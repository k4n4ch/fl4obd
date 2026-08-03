/*
 * tilemap.js — canvas への Web Mercator タイルマップ描画
 *
 * 書き出し用。Leaflet の DOM はラスタライズできないため、書き出し経路では
 * タイル・ルート・現在地を自前で canvas に描く。
 * OSM タイルは `access-control-allow-origin: *` なので crossOrigin='anonymous' で
 * 取得すれば canvas は汚染されない（= フレームを読み出して符号化できる）。
 *
 * タイル取得はキャッシュ前提。1走行のナビ表示で数百枚に収まる（連番書き出しでも
 * 同じタイルを何万回も取りに行かない）。
 */

/*
 * 使用するタイル。OSM 公式タイルはライトのみでダーク版が無いため、ダークは OSM データを
 * 使った CARTO の basemap を用いる（APIキー不要・`access-control-allow-origin: *` で
 * canvas 描画も可）。地図画像を含む成果物を配布する以上、帰属表示は必須なので
 * スタイルごとに attrib を持たせて必ず焼き込む。
 */
export const TILE_STYLES = {
  dark:   { label: 'ダーク',           url: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
            attrib: '© OpenStreetMap contributors © CARTO' },
  darknl: { label: 'ダーク(地名なし)', url: 'https://basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png',
            attrib: '© OpenStreetMap contributors © CARTO' },
  light:  { label: 'ライト(OSM)',      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            attrib: '© OpenStreetMap contributors' },
};

/** 帰属表示を矩形の右下に焼き込む（書き出し用） */
export function drawAttribution(ctx, text, x, y, w, h) {
  ctx.save();
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x + w - tw - 10, y + h - 17, tw + 8, 15);
  ctx.fillStyle = '#9ab';
  ctx.fillText(text, x + w - 6, y + h - 5);
  ctx.restore();
}

export const TILE = 256;
const EARTH_C = 156543.03392804097; // 赤道でのズーム0 m/px

export const lonToX = (lon, z) => ((lon + 180) / 360) * Math.pow(2, z);
export const latToY = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, z);
};
/** 幅 pxW に spanM メートルを収めるズーム（整数） */
export function zoomForSpan(spanM, pxW, lat) {
  const mpp = spanM / pxW;
  return Math.max(1, Math.min(19, Math.floor(Math.log2((EARTH_C * Math.cos((lat * Math.PI) / 180)) / mpp))));
}
/** 矩形 (w,h) に緯度経度の範囲を収めるズームと中心 */
export function fitView(track, w, h, pad = 0.06) {
  let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
  for (const p of track) { la0 = Math.min(la0, p.lat); la1 = Math.max(la1, p.lat); lo0 = Math.min(lo0, p.lon); lo1 = Math.max(lo1, p.lon); }
  const cLat = (la0 + la1) / 2, cLon = (lo0 + lo1) / 2;
  let z = 19;
  for (; z >= 1; z--) {
    const dx = Math.abs(lonToX(lo1, z) - lonToX(lo0, z)) * TILE;
    const dy = Math.abs(latToY(la0, z) - latToY(la1, z)) * TILE;
    if (dx <= w * (1 - pad * 2) && dy <= h * (1 - pad * 2)) break;
  }
  return { z, lat: cLat, lon: cLon };
}

export class TileCache {
  constructor(url = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', limit = 4000) {
    this.url = url; this.limit = limit; this.m = new Map(); this.hits = 0; this.miss = 0;
  }
  get(z, x, y) {
    const k = `${z}/${x}/${y}`;
    if (this.m.has(k)) { this.hits++; return this.m.get(k); }
    this.miss++;
    const p = new Promise((res) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => res(img);
      img.onerror = () => res(null);       // 取得失敗は空タイル扱いで進める
      img.src = this.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    });
    if (this.m.size >= this.limit) this.m.delete(this.m.keys().next().value);
    this.m.set(k, p);
    return p;
  }
}

/** ビュー: 中心(lat,lon) と ズーム z で幅 w × 高さ h の窓を定義する */
export function makeView(lat, lon, z, w, h) {
  const cx = lonToX(lon, z), cy = latToY(lat, z);
  const x0 = cx - w / 2 / TILE, y0 = cy - h / 2 / TILE;   // 左上（タイル単位）
  return {
    z, w, h, x0, y0,
    px: (la, lo) => [(lonToX(lo, z) - x0) * TILE, (latToY(la, z) - y0) * TILE],
  };
}

/** ビューを覆うタイルを描く。ox,oy は canvas 上の配置オフセット。 */
export async function drawTiles(ctx, cache, view, ox = 0, oy = 0) {
  const n = Math.pow(2, view.z);
  const ix0 = Math.floor(view.x0), iy0 = Math.floor(view.y0);
  const ix1 = Math.floor(view.x0 + view.w / TILE), iy1 = Math.floor(view.y0 + view.h / TILE);
  const jobs = [];
  for (let ty = iy0; ty <= iy1; ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = ix0; tx <= ix1; tx++) {
      const wx = ((tx % n) + n) % n;
      jobs.push(Promise.resolve(cache.get(view.z, wx, ty)).then((img) => ({ img, tx, ty })));
    }
  }
  for (const { img, tx, ty } of await Promise.all(jobs)) {
    if (!img) continue;
    ctx.drawImage(img, ox + Math.round((tx - view.x0) * TILE), oy + Math.round((ty - view.y0) * TILE), TILE, TILE);
  }
}

/**
 * ルートを描く。replay/video の表現に合わせ「白フチ → モード色・車速線幅」の2度塗り。
 * from/to で描画するインデックス範囲を絞れる（ナビ表示で全点を毎フレーム描かないため）。
 */
export function drawRoute(ctx, track, meta, view, ox = 0, oy = 0, { colorOf, widthOf, from = 0, to = -1 } = {}) {
  if (to < 0) to = track.length - 1;
  const runs = [];
  let cur = null;
  for (let i = from; i <= to; i++) {
    const col = colorOf(meta[i].mode), wd = widthOf(meta[i].spd);
    const p = view.px(track[i].lat, track[i].lon);
    if (!cur || cur.col !== col || cur.w !== wd) { if (cur) cur.pts.push(p); cur = { col, w: wd, pts: [p] }; runs.push(cur); }
    else cur.pts.push(p);
  }
  const stroke = (r, col, wd) => {
    ctx.beginPath();
    ctx.moveTo(ox + r.pts[0][0], oy + r.pts[0][1]);
    for (let i = 1; i < r.pts.length; i++) ctx.lineTo(ox + r.pts[i][0], oy + r.pts[i][1]);
    ctx.strokeStyle = col; ctx.lineWidth = wd; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
  };
  ctx.save();
  ctx.globalAlpha = 0.85; for (const r of runs) stroke(r, '#f4f8ff', r.w + 3);
  ctx.globalAlpha = 1;    for (const r of runs) stroke(r, r.col, r.w);
  ctx.restore();
}

export function drawDot(ctx, view, lat, lon, ox, oy, { r = 8, fill = '#4a9eff', ring = '#fff', rw = 3 } = {}) {
  const [x, y] = view.px(lat, lon);
  ctx.beginPath(); ctx.arc(ox + x, oy + y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill; ctx.fill();
  if (rw > 0) { ctx.lineWidth = rw; ctx.strokeStyle = ring; ctx.stroke(); }
}

/** 可視範囲に入るトラックのインデックス範囲（現在位置 i の周辺のみ走査） */
export function visibleRange(track, view, i, margin = 200) {
  const inside = (k) => {
    const [x, y] = view.px(track[k].lat, track[k].lon);
    return x > -margin && x < view.w + margin && y > -margin && y < view.h + margin;
  };
  let a = i, b = i;
  while (a > 0 && inside(a - 1)) a--;
  while (b < track.length - 1 && inside(b + 1)) b++;
  return [Math.max(0, a - 1), Math.min(track.length - 1, b + 1)];
}
