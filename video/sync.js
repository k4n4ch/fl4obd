/*
 * sync.js — ドラレコ映像 / OBDログ / GPX / NMEA を共通の絶対時刻軸に載せる
 *
 * 環境非依存の ES モジュール。ブラウザ（再生アプリ）と Node（検証・書き出し）の双方から使う。
 * 手法・根拠は embedded/knowledge/dashcam-obd-time-sync.md を参照。
 *
 * 設計方針:
 *  - データから導出できる量はすべて導出する（クリップ長・NMEAリード・アンカー・オフセット）。
 *  - 機器依存で毎回測れない量だけをプロファイル定数にする（C_VIDEO）。
 *  - 時刻はすべて「UTC epoch 秒(小数)」で扱う。日付跨ぎ・ローカル時刻機種を回避する。
 *  - 推定値には必ず残差と妥当性フラグを付け、解けない場合は黙って通さない。
 */

const MP4_EPOCH_OFFSET = 2082844800; // 1904-01-01 → 1970-01-01 [s]

export const DEFAULT_PROFILE = {
  name: 'generic',
  // 映像 t=0 の絶対時刻 = A + cVideo。実測 +0.4±0.6s のため既定 0。
  // GPS同期時計の校正撮影を行ったらここを更新する（1フレーム=33ms精度で確定できる）。
  cVideo: 0.0,
  cVideoSource: 'default(unmeasured)',
};

/*
 * 機種判定用の署名センテンス。NMEA の独自センテンスで見分ける。
 * $JK* は OEM の JVCKENWOOD 由来。Honda 純正 DRH-224SD（前後2カメラセット,
 * 品番 08E30-PM5-C04A）で実測・校正した。SoC は Ambarella（MP4 の encoder タグ）。
 */
const PROFILES = [
  { name: 'honda-drh-224sd', signatures: ['$GTRIP', '$JKTMD', '$JKLLA'], cVideo: 0.0, cVideoSource: 'measured +0.4±0.6s → adopt 0' },
];

// ---------------------------------------------------------------- utilities

/** 昇順配列 xs に対する線形補間。範囲外・欠測跨ぎは null。 */
export function interpAt(xs, ys, x, maxGap = 3) {
  if (!xs.length) return null;
  let lo = 0, hi = xs.length - 1;
  if (x < xs[0] || x > xs[hi]) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid; else hi = mid;
  }
  const dx = xs[hi] - xs[lo];
  if (dx <= 0) return ys[lo];
  if (dx > maxGap) return null;
  const w = (x - xs[lo]) / dx;
  return ys[lo] + (ys[hi] - ys[lo]) * w;
}

function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const dy = (lat2 - lat1) * 111320;
  const dx = (lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** 位置列 → 区間中心時刻の速度[km/h]。ドップラ遅延を避けるため位置差分を使う。 */
export function speedFromPositions(pts, maxGap = 3) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].t - pts[i - 1].t;
    if (dt <= 0 || dt > maxGap) continue;
    const d = haversineMeters(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    out.push({ t: (pts[i].t + pts[i - 1].t) / 2, v: (d / dt) * 3.6 });
  }
  return out;
}

// ---------------------------------------------------------------- NMEA

function dmToDeg(v, hemi) {
  const f = parseFloat(v);
  if (!isFinite(f)) return NaN;
  const d = Math.floor(f / 100);
  const deg = d + (f - d * 100) / 60;
  return hemi === 'S' || hemi === 'W' ? -deg : deg;
}

/**
 * NMEA を解析。$GPRMC の date+time から絶対 epoch を作るので日付跨ぎに強い。
 * $GSENS は時刻フィールドを持たないため、前後の測位センテンスの間を等分して時刻を推定する
 * （推定であることを isEstimated で明示）。
 */
export function parseNmea(text) {
  const fixes = [];
  const gsensRaw = [];
  const signatures = new Set();
  const seen = new Set();
  const alt = new Map();          // hhmmss.ss → 標高[m]（$GPGGA。$GPRMC は標高を持たない）
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('$')) continue;
    const tag = line.slice(0, 6);
    const p = line.split(',');
    if (tag === '$GPGGA') {
      const a = parseFloat(p[9]);
      if (p[1] && isFinite(a) && p[6] !== '0') alt.set(p[1], a);
    } else if (tag === '$GPRMC') {
      if (p.length < 10 || p[2] !== 'A' || !p[1] || !p[9]) continue;
      const hh = +p[1].slice(0, 2), mm = +p[1].slice(2, 4), ss = parseFloat(p[1].slice(4));
      const dd = +p[9].slice(0, 2), mo = +p[9].slice(2, 4), yy = +p[9].slice(4, 6);
      if (!isFinite(hh) || !isFinite(dd)) continue;
      const t = Date.UTC(2000 + yy, mo - 1, dd, hh, mm, 0) / 1000 + ss;
      const lat = dmToDeg(p[3], p[4]), lon = dmToDeg(p[5], p[6]);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      if (!seen.has(t)) {
        seen.add(t);
        fixes.push({ t, lat, lon, spd: (parseFloat(p[7]) || 0) * 1.852, ele: null, _tk: p[1] }); // knot → km/h
      }
      gsensRaw.push({ mark: t });
    } else if (tag === '$GSENS') {
      const x = parseFloat(p[1]), y = parseFloat(p[2]), z = parseFloat(p[3]);
      if (isFinite(x) && isFinite(y) && isFinite(z)) gsensRaw.push({ acc: [x, y, z] });
    } else if (line.startsWith('$GT') || line.startsWith('$JK')) {
      signatures.add(tag);
    }
  }
  fixes.sort((a, b) => a.t - b.t);
  // 標高を突合。$GPGGA が $GPRMC の前後どちらに来るかは機器依存なので、全部読んでから割り当てる
  for (const f of fixes) { const a = alt.get(f._tk); if (a !== undefined) f.ele = a; delete f._tk; }
  // $GSENS に時刻を割り当て（測位センテンス間を等分）
  const gsens = [];
  let pend = [];
  let prevMark = null;
  for (const r of gsensRaw) {
    if (r.mark !== undefined) {
      if (prevMark !== null && pend.length) {
        for (let i = 0; i < pend.length; i++) {
          gsens.push({ t: prevMark + ((r.mark - prevMark) * (i + 0.5)) / pend.length, acc: pend[i], isEstimated: true });
        }
      }
      prevMark = r.mark; pend = [];
    } else pend.push(r.acc);
  }
  return { fixes, gsens, signatures: [...signatures] };
}

// ---------------------------------------------------------------- GPX

export function parseGpx(text) {
  const pts = [];
  const re = /<trkpt[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
  let m;
  while ((m = re.exec(text))) {
    const tm = /<time>([^<]+)<\/time>/.exec(m[3]);
    if (!tm) continue;
    const t = Date.parse(tm[1]) / 1000;
    if (!isFinite(t)) continue;
    const el = /<ele>([-\d.]+)<\/ele>/.exec(m[3]);
    pts.push({ t, lat: +m[1], lon: +m[2], ele: el ? +el[1] : null });
  }
  pts.sort((a, b) => a.t - b.t);
  return pts;
}

// ---------------------------------------------------------------- OBD log

/** ISO-TP 表示のフレーム群を連結。フレーム10以降はコロン区切りが無い形式に対応。 */
function reassembleFrames(rest) {
  const frames = new Map();
  for (const tok of rest.trim().split(/\s+/)) {
    let m = /^(\d+):([0-9A-Fa-f]+)$/.exec(tok);
    if (m) { frames.set(+m[1], m[2]); continue; }
    // コロン無し: 先頭2桁がフレーム番号 + CF ペイロード7バイト（例 1000003A7FFF00E0）。
    // 14桁ちょうどに限定しないと単フレーム応答（415B45...）を誤って拾う。
    m = /^(\d{2})([0-9A-Fa-f]{14})$/.exec(tok);
    if (m) { frames.set(+m[1], m[2]); continue; }
  }
  if (!frames.size) return null;
  const idx = [...frames.keys()].sort((a, b) => a - b);
  // 連番欠けは不完全として捨てる
  for (let i = 0; i < idx.length; i++) if (idx[i] !== i) return null;
  const hex = idx.map((i) => frames.get(i)).join('');
  const n = hex.length >> 1;
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  return b;
}

const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const s16 = (b, i) => { const v = u16(b, i); return v >= 32768 ? v - 65536 : v; };

/**
 * fl4obd の webapp ログを解析。
 * オフセット規約: webapp の位置 = ロガーの位置 + 2（W[0..2] = 62 29 20）。
 *
 * timeMode: 'ok'=応答受信時刻（既定） / 'midpoint'=tx と ok の中点。
 * 実測では両者で照合残差が同一（0.4686 vs 0.4692 km/h）＝どちらが真の採取時刻かはデータから
 * 決まらず、δ が 0.25s ずれるだけ。ストリーム毎に実測オフセットを当てる方式なのでこの曖昧さは
 * 吸収される（'ok' で δ=-2.354s、GPX位置由来の -2.40s と 0.05s で一致する）。よって既定は 'ok'。
 */
export function parseObdLog(text, { timeMode = 'ok' } = {}) {
  const lines = text.split(/\r?\n/);
  const gen = /Generated:\s*(\S+)/.exec(text);
  const genT = gen ? Date.parse(gen[1]) / 1000 : NaN;
  if (!isFinite(genT)) throw new Error('OBDログに Generated ヘッダが無く日付を決定できない');
  const genDayStart = Math.floor(genT / 86400) * 86400;
  const genTod = genT - genDayStart;

  const samples = [];   // 2920 由来（車速・rpm 等）
  const speedPid = [];  // PID 0D 由来のフォールバック車速
  const soc = [];
  const dids = new Set();
  let lastTx = null, nTx = 0, nOk = 0, nBad = 0;

  for (const line of lines) {
    const h = /^\[(\d\d):(\d\d):(\d\d(?:\.\d+)?)\]\s*\[(\w+)\s*\]\s*(.*)$/.exec(line);
    if (!h) continue;
    let tod = +h[1] * 3600 + +h[2] * 60 + parseFloat(h[3]);
    // 日付跨ぎ: Generated 時刻より後の時刻は前日
    let t = genDayStart + tod;
    if (tod > genTod + 60) t -= 86400;
    const tag = h[4], rest = h[5];

    if (tag === 'tx') { lastTx = t; nTx++; continue; }
    if (tag !== 'ok') continue;
    nOk++;
    const ts = timeMode === 'midpoint' && lastTx !== null && t - lastTx < 5 ? (t + lastTx) / 2 : t;
    lastTx = null;

    const arrow = rest.indexOf('←');
    if (arrow < 0) continue;
    let body = rest.slice(arrow + 1).trim();

    // 宣言長プレフィックス（例 "06F"）。決め打ちせず読む。
    let declared = null;
    const lm = /^([0-9A-Fa-f]{3,4})\s+(?=\d)/.exec(body);
    if (lm) { declared = parseInt(lm[1], 16); body = body.slice(lm[0].length); }

    // マルチフレーム表示は必ずコロン付きのフレーム番号を含む。単フレーム応答と確実に区別する。
    if (declared !== null || /(^|\s)\d{1,2}:/.test(body)) {
      const W = reassembleFrames(body);
      if (!W) { nBad++; continue; }
      if (declared !== null && W.length < declared) { nBad++; continue; }
      if (W[0] === 0x62) {
        const did = u16(W, 1);
        dids.add(did);
        if (did === 0x2920 && W.length >= 104) {
          // W[98]==0xF8 は 2920 の固定バイト。あれば健全性チェックとして使う。
          if (W.length > 98 && W[98] !== 0xf8) { nBad++; continue; }
          samples.push({
            t: ts,
            vsp: W[15],
            rpm: u16(W, 100) / 4,
            mode: W[79],
            coolant: W[102] - 40,
            pbat: s16(W, 86) * 0.01,
            accel: (W[19] * 100) / 255, // logger byte17 = APS1 → webapp W[19]
            v12: W[16] * 0.1,
            drv: s16(W, 90),            // 駆動トルク(raw)
            gen: s16(W, 92),            // 発電機トルク(raw)
            eng: s16(W, 96),            // エンジントルク(raw)
          });
        }
      }
      continue;
    }

    // 単フレーム応答（同一応答が複数回並ぶことがある）
    const tok = body.split(/\s+/)[0];
    if (!/^[0-9A-Fa-f]{4,}$/.test(tok)) continue;
    const b0 = parseInt(tok.substr(0, 2), 16), b1 = parseInt(tok.substr(2, 2), 16);
    if (b0 === 0x41) {
      if (b1 === 0x0d) speedPid.push({ t: ts, v: parseInt(tok.substr(4, 2), 16) });
      else if (b1 === 0x5b) soc.push({ t: ts, v: (parseInt(tok.substr(4, 2), 16) * 100) / 255 });
    }
  }
  samples.sort((a, b) => a.t - b.t);
  speedPid.sort((a, b) => a.t - b.t);
  return { samples, speedPid, soc, dids: [...dids].sort(), stats: { nTx, nOk, nBad }, generatedAt: genT };
}

// ---------------------------------------------------------------- 派生量（パワーフロー用）

/*
 * 較正定数。replay.html / index.html と同一の値を使う。
 * 由来は embedded/knowledge/fl4-did-map.md（トルクスケール・coef 群）と
 * fl4obd/docs/soc-interpolation.md（SOC_K）。値を変えるときは両方を揃えること。
 */
export const CAL = {
  COEF_ENG: 2.09e-6,   // P_eng[kW] = COEF_ENG × eng_trq(raw) × rpm
  COEF_GEN: 3.92e-6,   // P_gen[kW] = COEF_GEN × (-gen_trq(raw)) × rpm
  COEF_TRC: 0.000147,  // P_drive[kW] = COEF_TRC × drv_trq(raw) × 車速
  SOC_K: -192,         // ΔSOC[%] = SOC_K × ∫Pbat[kWh]（短窓の実測係数）
};

/** 遷移モード(10/30/60)を「次の安定モード＝行先」へ寄せて modeR を付ける。 */
export function resolveModes(samples) {
  const stable = (m) => m === 20 || m === 40 || m === 50 || m === 70;
  const nextS = new Array(samples.length);
  let ns = -1;
  for (let i = samples.length - 1; i >= 0; i--) { if (stable(samples[i].mode)) ns = samples[i].mode; nextS[i] = ns; }
  let ps = -1;
  for (let i = 0; i < samples.length; i++) {
    if (stable(samples[i].mode)) { ps = samples[i].mode; samples[i].modeR = samples[i].mode; }
    else samples[i].modeR = nextS[i] >= 0 ? nextS[i] : ps >= 0 ? ps : samples[i].mode;
  }
  return samples;
}

/**
 * 生の 2920 サンプルからパワーフロー描画に必要な派生量を計算する。
 * SOC は実測 5B が来たら再アンカーし、その間を ∫Pbat で前進させる（表示専用）。
 */
export function deriveTelemetry(obd) {
  const socAnchors = obd.soc || [];
  let ai = 0, socR = NaN, prevT = null;
  resolveModes(obd.samples);
  for (const s of obd.samples) {
    while (ai < socAnchors.length && socAnchors[ai].t <= s.t) { socR = socAnchors[ai].v; ai++; } // 実測5Bで再アンカー
    const isDir = s.mode === 50 || s.mode === 70;
    s.peng = CAL.COEF_ENG * s.eng * s.rpm;
    s.pgen = CAL.COEF_GEN * -s.gen * s.rpm;
    s.pdrive = CAL.COEF_TRC * s.drv * s.vsp;
    s.psys = s.pdrive + (isDir ? s.peng : 0);
    if (!isNaN(socR) && prevT != null) {
      const dt = (s.t - prevT) / 3600; // s → h
      if (dt > 0 && dt < 0.02) socR += CAL.SOC_K * s.pbat * dt;
    }
    prevT = s.t;
    s.soc = isNaN(socR) ? NaN : +socR.toFixed(2);
  }
  return obd;
}

/** 車速系列を選ぶ。2920 が無ければ PID 0D にフォールバックする。 */
export function obdSpeedSeries(obd) {
  if (obd.samples.length > 20) return { series: obd.samples.map((s) => ({ t: s.t, v: s.vsp })), source: '22_2920' };
  if (obd.speedPid.length > 20) return { series: obd.speedPid, source: '01_0D' };
  return { series: [], source: 'none' };
}

// ---------------------------------------------------------------- MP4 metadata

/**
 * MP4 の moov/mvhd から creation_time と duration を読む。
 * reader: async (offset, length) => ArrayBuffer （File.slice / fs.read の両対応）
 * creation_time はローカル時刻を書く機種があるため、セッション組成の順序付けにのみ使い、
 * 絶対時刻の基準には NMEA を用いる（tzUncertain フラグで明示）。
 */
export async function parseMp4Meta(reader, fileSize) {
  const readBoxesFrom = async (start, limit) => {
    let off = start;
    while (off < limit) {
      const hdr = new DataView(await reader(off, 16));
      if (hdr.byteLength < 8) return null;
      let size = hdr.getUint32(0);
      const type = String.fromCharCode(hdr.getUint8(4), hdr.getUint8(5), hdr.getUint8(6), hdr.getUint8(7));
      let hsize = 8;
      if (size === 1) { size = Number(hdr.getBigUint64(8)); hsize = 16; }
      else if (size === 0) size = limit - off;
      if (type === 'moov') return { off: off + hsize, size: size - hsize };
      if (size <= 0) return null;
      off += size;
    }
    return null;
  };
  const moov = await readBoxesFrom(0, fileSize);
  if (!moov) throw new Error('moov ボックスが見つからない');
  // moov 内の mvhd を探す
  let off = moov.off;
  const end = moov.off + moov.size;
  while (off < end) {
    const hdr = new DataView(await reader(off, 8));
    if (hdr.byteLength < 8) break;
    const size = hdr.getUint32(0);
    const type = String.fromCharCode(hdr.getUint8(4), hdr.getUint8(5), hdr.getUint8(6), hdr.getUint8(7));
    if (type === 'mvhd') {
      const d = new DataView(await reader(off + 8, 32));
      const ver = d.getUint8(0);
      let created, timescale, duration;
      if (ver === 1) {
        created = Number(d.getBigUint64(4)); timescale = d.getUint32(20); duration = Number(d.getBigUint64(24));
      } else {
        created = d.getUint32(4); timescale = d.getUint32(12); duration = d.getUint32(16);
      }
      return {
        creationTime: created - MP4_EPOCH_OFFSET,
        duration: timescale > 0 ? duration / timescale : NaN,
        timescale,
      };
    }
    if (size <= 0) break;
    off += size;
  }
  throw new Error('mvhd ボックスが見つからない');
}

// ---------------------------------------------------------------- offset estimation

/**
 * src(t) ≈ ref(t+δ) となる δ を探す。粗→細の2段スイープ＋放物線頂点で精密化。
 * 妥当性: サンプル数と「谷のコントラスト」を検定し、平坦なら ok=false を返す。
 */
export function estimateOffset(src, ref, opts = {}) {
  const { range = 15, coarse = 0.5, fine = 0.02, moveThreshold = 5, minSamples = 200, minContrast = 0.15 } = opts;
  if (src.length < minSamples / 4 || ref.length < 10) {
    return { ok: false, reason: 'サンプル不足', delta: NaN, residual: NaN, n: 0 };
  }
  const rt = ref.map((r) => r.t), rv = ref.map((r) => r.v);
  const cost = (d) => {
    const e = [];
    for (const s of src) {
      const r = interpAt(rt, rv, s.t + d);
      if (r === null) continue;
      if (Math.max(s.v, r) < moveThreshold) continue;
      e.push(Math.abs(s.v - r));
    }
    return e.length ? { c: median(e), n: e.length } : { c: NaN, n: 0 };
  };
  const scan = (lo, hi, step) => {
    const out = [];
    for (let d = lo; d <= hi + 1e-9; d += step) out.push({ d, ...cost(d) });
    return out.filter((r) => isFinite(r.c));
  };
  let grid = scan(-range, range, coarse);
  if (!grid.length) return { ok: false, reason: '重なり区間が無い', delta: NaN, residual: NaN, n: 0 };
  let best = grid.reduce((a, b) => (b.c < a.c ? b : a));
  const worst = grid.reduce((a, b) => (b.c > a.c ? b : a));
  const fineGrid = scan(best.d - coarse * 2, best.d + coarse * 2, fine);
  if (fineGrid.length) best = fineGrid.reduce((a, b) => (b.c < a.c ? b : a));
  // 放物線頂点
  let delta = best.d;
  const i = fineGrid.findIndex((r) => r.d === best.d);
  if (i > 0 && i < fineGrid.length - 1) {
    const [a, b, c] = [fineGrid[i - 1], fineGrid[i], fineGrid[i + 1]];
    const den = a.c - 2 * b.c + c.c;
    if (Math.abs(den) > 1e-12) {
      const sub = (0.5 * (a.c - c.c)) / den;
      if (Math.abs(sub) <= 1) delta = b.d + sub * fine;
    }
  }
  const contrast = worst.c > 0 ? (worst.c - best.c) / worst.c : 0;
  const ok = best.n >= minSamples && contrast >= minContrast;
  return {
    ok, delta, residual: best.c, n: best.n, contrast,
    reason: ok ? null : best.n < minSamples ? 'サンプル不足' : '谷が平坦（走行変化が乏しい）',
  };
}

// ---------------------------------------------------------------- sessions & anchor

/**
 * 時間的に重複するクリップを1本に絞る。
 * 多チャンネル機（前方/後方カメラが同名）や、EVENT/PARKING に同じ映像が複製される機種を
 * ディレクトリ名に依存せず汎用的に扱うため、重複は「時間の重なり」で判定する。
 * 優先順位は channelRank（小さいほど優先。呼び出し側が設定）→ 名前。
 */
export function dedupeOverlaps(clips, { tol = 0.5 } = {}) {
  const sorted = [...clips].sort(
    (a, b) => a.nmeaFirst - b.nmeaFirst || (a.channelRank ?? 0) - (b.channelRank ?? 0) || String(a.name).localeCompare(String(b.name))
  );
  const kept = [], dropped = [];
  for (const c of sorted) {
    const last = kept[kept.length - 1];
    if (last && c.nmeaFirst < last.nmeaLast - tol) { dropped.push(c); continue; }
    kept.push(c);
  }
  return { clips: kept, dropped };
}

/** NMEA の連続性でクリップをセッションに分割する（creation_time より信頼できる）。 */
export function groupSessions(clips, gapTol = 10) {
  const sorted = [...clips].sort((a, b) => a.nmeaFirst - b.nmeaFirst);
  const out = [];
  let cur = [];
  for (const c of sorted) {
    if (cur.length && c.nmeaFirst - cur[cur.length - 1].nmeaLast > gapTol) { out.push(cur); cur = []; }
    cur.push(c);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * セッションのアンカー A（連続動画 t=0 の絶対UTC）を求める。
 *   a_k = NMEA先頭(k) − S0(k)  の外れ値を除いた平均。
 * NMEA のみを使うので creation_time がローカル時刻の機種でも正しく求まる。
 * セッション先頭クリップは挙動が異なることがあるため、インデックス決め打ちではなく
 * 残差の外れ値として自動的に除外する。
 */
export function computeAnchor(session, { outlierTol = 1.5 } = {}) {
  let acc = 0;
  const rows = session.map((c) => { const r = { clip: c, S0: acc, a: c.nmeaFirst - acc }; acc += c.duration; return r; });
  const med = median(rows.map((r) => r.a));
  const kept = rows.filter((r) => Math.abs(r.a - med) <= outlierTol);
  const excluded = rows.filter((r) => Math.abs(r.a - med) > outlierTol).map((r) => ({ name: r.clip.name, a: r.a }));
  const use = kept.length ? kept : rows;
  const A = use.reduce((s, r) => s + r.a, 0) / use.length;
  const sd = Math.sqrt(use.reduce((s, r) => s + (r.a - A) ** 2, 0) / Math.max(use.length, 1));
  // NMEA先頭 − creation_time（機種特性。診断用に実測する。定数化しない）
  const leads = session.map((c) => c.nmeaFirst - c.creationTime).filter(isFinite);
  return {
    A, sd, sem: sd / Math.sqrt(Math.max(use.length, 1)),
    nUsed: use.length, excluded,
    sessionDuration: acc,
    nmeaLead: median(leads),
    clips: rows.map((r) => ({ name: r.clip.name, S0: r.S0, duration: r.clip.duration })),
  };
}

export function detectProfile(signatures) {
  for (const p of PROFILES) if (p.signatures.some((s) => signatures.includes(s))) return p;
  return DEFAULT_PROFILE;
}

// ---------------------------------------------------------------- manifest

/**
 * 同期マニフェストを構築する。
 * clips: [{name, creationTime, duration, nmeaFirst, nmeaLast, fixes:[...]}]
 */
export function buildManifest({ clips: inputClips, obd, gpx, profile = null, notes = [] }) {
  const signatures = [...new Set(inputClips.flatMap((c) => c.signatures || []))];
  const prof = profile || detectProfile(signatures);
  const { clips, dropped } = dedupeOverlaps(inputClips);

  const sessions = groupSessions(clips);
  const obdSpan = obd.samples.length
    ? [obd.samples[0].t, obd.samples[obd.samples.length - 1].t]
    : [NaN, NaN];
  // OBD 区間と最も重なるセッションを選ぶ
  let session = sessions[0], bestOv = -1;
  for (const s of sessions) {
    const ov = Math.min(s[s.length - 1].nmeaLast, obdSpan[1]) - Math.max(s[0].nmeaFirst, obdSpan[0]);
    if (ov > bestOv) { bestOv = ov; session = s; }
  }
  const anchor = computeAnchor(session);
  const sessFixes = session.flatMap((c) => c.fixes).sort((a, b) => a.t - b.t);

  // 基準（真値）: NMEA の位置差分速度と位置
  const refSpeed = speedFromPositions(sessFixes);
  const { series: obdSpeed, source: obdSpeedSource } = obdSpeedSeries(obd);
  const dObd = estimateOffset(obdSpeed, refSpeed, { moveThreshold: 5 });

  let dGpx = { ok: false, reason: 'GPXなし', delta: NaN, residual: NaN, n: 0 };
  let mapSource = 'nmea';
  if (gpx && gpx.length > 20) {
    // 位置同士で照合（微分を挟まないため最も素性が良い）
    const rt = sessFixes.map((f) => f.t);
    const cost = (d) => {
      const e = [];
      for (const p of gpx) {
        const la = interpAt(rt, sessFixes.map((f) => f.lat), p.t + d);
        const lo = interpAt(rt, sessFixes.map((f) => f.lon), p.t + d);
        if (la === null || lo === null) continue;
        e.push(haversineMeters(p.lat, p.lon, la, lo));
      }
      return e.length ? { c: median(e), n: e.length } : { c: NaN, n: 0 };
    };
    // 位置照合は距離[m]なので estimateOffset を使わず専用に走らせる
    let best = null, worst = null;
    for (let d = -15; d <= 15; d += 0.1) {
      const r = { d, ...cost(d) };
      if (!isFinite(r.c)) continue;
      if (!best || r.c < best.c) best = r;
      if (!worst || r.c > worst.c) worst = r;
    }
    if (best && best.n > 200) {
      const contrast = worst.c > 0 ? (worst.c - best.c) / worst.c : 0;
      dGpx = { ok: contrast >= 0.3, delta: best.d, residual: best.c, n: best.n, contrast, unit: 'm', reason: contrast >= 0.3 ? null : '谷が平坦' };
    }
    if (dGpx.ok) mapSource = 'gpx';
  }

  const videoStart = anchor.A + prof.cVideo;
  const videoEnd = videoStart + anchor.sessionDuration;
  const nmeaStart = sessFixes[0].t, nmeaEnd = sessFixes[sessFixes.length - 1].t;
  // OBD をドラレコ時間軸へ載せた区間
  const obdShift = dObd.ok ? dObd.delta : 0;
  const obdStart = obdSpan[0] + obdShift, obdEnd = obdSpan[1] + obdShift;
  const start = Math.max(videoStart, nmeaStart, obdStart);
  const end = Math.min(videoEnd, nmeaEnd, obdEnd);

  const warnings = [...notes];
  if (!dObd.ok) warnings.push(`OBD↔NMEA オフセットが解けない（${dObd.reason}）。同期は信頼できない。`);
  if (gpx && gpx.length > 20 && !dGpx.ok) warnings.push('GPX↔NMEA オフセットが解けない。マップは NMEA を使用する。');
  if (prof.cVideoSource.startsWith('default')) warnings.push('cVideo が未校正（既定0、±0.6s）。GPS同期時計の撮影で確定できる。');
  const info = [];
  if (dropped.length) info.push(`時間重複で除外したクリップ ${dropped.length}本（多チャンネル/複製）。`);
  if (sessions.length > 1) info.push(`セッション ${sessions.length}件を検出し、OBD区間と最も重なる1件を採用した。`);
  if (anchor.excluded.length) warnings.push(`アンカーから除外: ${anchor.excluded.slice(0, 5).map((e) => e.name).join(', ')}${anchor.excluded.length > 5 ? ` 他${anchor.excluded.length - 5}本` : ''}`);
  if (Math.abs(obdShift) > 60) warnings.push(`スマホ時計オフセットが異常に大きい（${obdShift.toFixed(1)}s）。要確認。`);
  if (!(end > start)) warnings.push('映像・NMEA・OBD の共通区間が存在しない。');

  return {
    generated: new Date().toISOString(),
    profile: { name: prof.name, cVideo: prof.cVideo, cVideoSource: prof.cVideoSource, signatures },
    session: {
      anchorUtc: anchor.A,
      videoStartUtc: videoStart,
      duration: anchor.sessionDuration,
      anchorSd: anchor.sd, anchorSem: anchor.sem, anchorNUsed: anchor.nUsed,
      nmeaLeadMeasured: anchor.nmeaLead,
      excludedFromAnchor: anchor.excluded,
      clips: anchor.clips,
    },
    offsets: {
      // 時刻変換: 動画時間 S = (t_phone + delta) − videoStartUtc
      obd: { delta: dObd.delta, residual: dObd.residual, unit: 'km/h', n: dObd.n, contrast: dObd.contrast, ok: dObd.ok, source: obdSpeedSource, measured: true },
      gpx: { delta: dGpx.delta, residual: dGpx.residual, unit: dGpx.unit || 'm', n: dGpx.n, contrast: dGpx.contrast, ok: dGpx.ok, measured: !!dGpx.ok },
      video: { delta: prof.cVideo, measured: !prof.cVideoSource.startsWith('default'), note: prof.cVideoSource },
    },
    window: { startUtc: start, endUtc: end, durationSec: end - start },
    coverage: {
      video: [videoStart, videoEnd],
      nmea: [nmeaStart, nmeaEnd],
      obd: [obdStart, obdEnd],
    },
    data: { obdDids: obd.dids, obdStats: obd.stats, mapSource, nFixes: sessFixes.length, nObd: obd.samples.length, nGpx: gpx ? gpx.length : 0, nClipsInput: inputClips.length, nClipsDeduped: clips.length, nSessions: sessions.length },
    info,
    warnings,
  };
}

/** 絶対UTC → 連続動画時間 S、および (クリップ, クリップ内秒) への変換 */
export function makeTimeline(manifest) {
  const clips = manifest.session.clips;
  const vs = manifest.session.videoStartUtc;
  return {
    utcToS: (utc) => utc - vs,
    sToUtc: (S) => vs + S,
    phoneToS: (t, which = 'obd') => t + (manifest.offsets[which].ok ? manifest.offsets[which].delta : 0) - vs,
    locate: (S) => {
      for (const c of clips) if (S >= c.S0 && S < c.S0 + c.duration) return { clip: c.name, offset: S - c.S0 };
      return null;
    },
  };
}
