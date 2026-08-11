#!/usr/bin/env node
/*
 * build-sync.mjs — sync.json を生成する CLI
 *
 *   node build-sync.mjs --obd <log.txt> [--gpx <log.gpx>] --dashcam <folder> [--out sync.json]
 *
 * ドラレコフォルダ配下から MP4 を再帰探索し、同名の .NMEA を対応付ける（構成に依存しない）。
 * 多チャンネル機（前方/後方が同名）や EVENT/PARKING の複製は時間重複で自動除去する。
 * --channel <部分文字列>  使うチャンネルを明示（既定: パス階層が浅い方＝通常は前方カメラ）
 * --gpx 省略時は OBD ログと同じ basename の .gpx を探す。
 */
import { readFile, readdir, stat, open, writeFile } from 'node:fs/promises';
import { join, extname, basename, dirname } from 'node:path';
import { parseNmea, parseGpx, parseObdLog, parseMp4Meta, buildManifest, makeTimeline, deriveTelemetry, fillTrackGaps } from './sync.js';

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[i + 1];
  return o;
}
async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out); else out.push(p);
  }
  return out;
}

const o = args();
if (!o.obd || !o.dashcam) {
  console.error('usage: node build-sync.mjs --obd <log.txt> [--gpx <log.gpx>] --dashcam <folder> [--out sync.json]');
  process.exit(1);
}
const files = await walk(o.dashcam);
let mp4s = files.filter((f) => extname(f).toLowerCase() === '.mp4');
if (o.channel) mp4s = mp4s.filter((f) => f.includes(o.channel));
// チャンネル優先度: パスが浅いものを優先（前方カメラは NORMAL/ 直下、後方は REAR/NORMAL/ など）
const depth = (f) => f.split('/').length;
const minDepth = Math.min(...mp4s.map(depth));
const nmeaByBase = new Map();
for (const f of files) if (extname(f).toLowerCase() === '.nmea') nmeaByBase.set(basename(f, extname(f)), f);
console.log(`ドラレコ: MP4 ${mp4s.length}本 / NMEA ${nmeaByBase.size}本  (${o.dashcam})`);

const clips = [];
for (const mp4 of mp4s) {
  const base = basename(mp4, extname(mp4));
  const nme = nmeaByBase.get(base);
  if (!nme) continue;                                  // NMEAが無いクリップは同期に使えない
  const { fixes, gsens, signatures } = parseNmea(await readFile(nme, 'latin1'));
  // 測位ゼロ（トンネル等）でも捨てない。配置は creation_time+尺で決まる。
  const fh = await open(mp4, 'r');
  const size = (await fh.stat()).size;
  const reader = async (off, len) => {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, off);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead);
  };
  let meta;
  try { meta = await parseMp4Meta(reader, size); }
  catch (e) { console.warn(`  ! ${base}: ${e.message}`); await fh.close(); continue; }
  await fh.close();
  clips.push({
    name: base, path: mp4, nmeaPath: nme, channelRank: depth(mp4) - minDepth,
    creationTime: meta.creationTime, duration: meta.duration,
    nmeaFirst: fixes.length ? fixes[0].t : NaN,
    nmeaLast: fixes.length ? fixes[fixes.length - 1].t : NaN,
    fixes, gsensCount: gsens.length, signatures,
  });
}
if (!clips.length) { console.error('対応する MP4+NMEA が見つからない'); process.exit(1); }

const obd = parseObdLog(await readFile(o.obd, 'utf8'));
const gpxPath = o.gpx || join(dirname(o.obd), basename(o.obd, extname(o.obd)) + '.gpx');
let gpx = null;
try { gpx = parseGpx(await readFile(gpxPath, 'utf8')); } catch { console.log('GPX なし → マップは NMEA を使用'); }

const m = buildManifest({ clips, obd, gpx });
const iso = (t) => new Date(t * 1000).toISOString();
const S = m.session;
console.log(`\nプロファイル: ${m.profile.name} [${m.profile.signatures.join(' ')}]  cVideo=${m.profile.cVideo} (${m.profile.cVideoSource})`);
console.log(`セッション: ${S.clips.length}クリップ  長さ ${S.duration.toFixed(3)}s`);
console.log(`  アンカー A = ${S.anchorUtc.toFixed(3)} (${iso(S.anchorUtc)})  sd=${S.anchorSd.toFixed(3)} sem=${S.anchorSem.toFixed(3)} n=${S.anchorNUsed}`);
console.log(`  NMEA先頭−creation_time 実測 = ${S.nmeaLeadMeasured.toFixed(2)}s`);
console.log(`  アンカー除外 = ${S.excludedFromAnchor.map((e) => `${e.name}(${(e.a - S.anchorUtc).toFixed(2)})`).join(', ') || 'なし'}`);
for (const [k, v] of Object.entries(m.offsets)) {
  const d = Number.isFinite(v.delta) ? v.delta.toFixed(2) + 's' : '-';
  const r = Number.isFinite(v.residual) ? v.residual.toFixed(3) + (v.unit || '') : '-';
  const c = Number.isFinite(v.contrast) ? v.contrast.toFixed(2) : '-';
  console.log(`  offset.${k}: δ=${d} 残差=${r} n=${v.n ?? '-'} contrast=${c} 実測=${v.measured} 妥当=${v.ok ?? '-'}`);
}
console.log(`  共通区間: ${iso(m.window.startUtc)} 〜 ${iso(m.window.endUtc)} (${m.window.durationSec.toFixed(1)}s)`);
if (m.info.length) console.log('  情報: ' + m.info.join(' / '));
console.log(`  データ: DID=${m.data.obdDids.map((d) => d.toString(16)).join(',')} 2920=${m.data.nObd} fix=${m.data.nFixes} gpx=${m.data.nGpx} map=${m.data.mapSource} クリップ ${m.data.nClipsInput}→${m.data.nClipsDeduped}(${m.data.nSessions}セッション)`);
if (m.warnings.length) console.log('\n警告:\n' + m.warnings.map((w) => '  - ' + w).join('\n'));

// 測位途絶の補完（video.html と同じ関数を通す。CLI でも合否と残差を確認できるように）
{
  const useGpx = m.data.mapSource === 'gpx' && gpx;
  const dGpx = m.offsets.gpx.ok ? m.offsets.gpx.delta : 0;
  const track = useGpx
    ? gpx.map((p) => ({ t: p.t + dGpx, lat: p.lat, lon: p.lon, ele: p.ele }))
    : S.clips.flatMap((c) => (clips.find((x) => x.name === c.name) || { fixes: [] }).fixes).sort((a, b) => a.t - b.t);
  deriveTelemetry(obd);
  const r = await fillTrackGaps(track, obd.samples, { obdDelta: m.offsets.obd.ok ? m.offsets.obd.delta : 0 });
  console.log(`\n測位途絶の補完 (${useGpx ? 'GPX' : 'NMEA'}): ${r.reports.length}箇所`);
  for (const q of r.reports) {
    const w = `${iso(q.from)}〜${iso(q.to)}`;
    if (q.ok) console.log(`  ✓ ${w}  経路 ${q.lengthKm.toFixed(3)}km / 車速積分 ${q.integratedKm.toFixed(3)}km  乖離 ${q.errPct.toFixed(2)}%  追い風 ${q.wind != null ? q.wind.toFixed(2) + 'm/s' : '-'}  端点棄却 ${q.droppedFixes}点`);
    else console.log(`  ✗ ${w}  ${q.reason}`);
  }
  if (r.reports.length) console.log(`  ${track.length} → ${r.fixes.length}点 (補完 ${r.fixes.filter((f) => f.estimated).length})`);
}

const tl = makeTimeline(m);
const mid = (m.window.startUtc + m.window.endUtc) / 2;
console.log(`\n変換例: 中央時刻 ${iso(mid)} → S=${tl.utcToS(mid).toFixed(2)}s → ${JSON.stringify(tl.locate(tl.utcToS(mid)))}`);

const out = o.out || 'sync.json';
await writeFile(out, JSON.stringify({ ...m, session: { ...S, clips: S.clips } }, null, 2));
console.log(`\n${out} を書き出した`);
