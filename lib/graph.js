/*
 * graph.js — 経時変化グラフ（video.html / 将来 replay.html と共用）
 *
 * 並びは「因果が上から下へ流れる」ように固定する:
 *   ① 標高と勾配（地形＝入力）
 *   ② 車速（車両の応答）
 *   ③ パワー Psys / Pbat / ENGrpm（何がその速度を作ったか）
 *   ④ SOC と電費（その結果どうエネルギーが動いたか）
 * i-MMD はアクセル操作によらずエンジンを効率点で回し、ドライバーに意識させない制御なので、
 * アクセル開度より「いつエンジンが表に出たか」と「SOC/電費がどう動いたか」の対応が要点。
 *
 * 描画は SVG。呼び出し側が panels を組み立て、ここは描くだけ（データ源に依存しない）。
 *   panel  = { h, zero, series:[...], yl:[min,max]|null, yr:[min,max]|null, fmtL, fmtR, flag,
 *                minL, minR (自動スケールの最小スパン), zeroL, zeroR (0 を必ず含める),
 *                symL, symR (0 を中心に対称) }
 *   series = { name, color, axis:'L'|'R', pts:[[t,v],...], w, fill, fmt, segColor, segDash, dash }
 *     segDash(i) で区間ごとに線種を変える。実測と推定を1系列のまま描き分けられるので
 *     凡例は1つで済む。panel.flag(tNow) は再生位置が推定のときだけ注記を出す用。
 * yl/yr 省略時は表示窓内で自動スケール。segColor(i) を与えると区間ごとに色を変えて描く。
 * pts は時刻昇順。t は呼び出し側の任意の連続時間軸（video では動画時間 S[秒]）。
 */

const GNS = 'http://www.w3.org/2000/svg';
const BG = '#0c1a24';        // プロット背景。文字の縁取りにも使う
const gEl = (tag, attrs, parent) => {
  const e = document.createElementNS(GNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};

/*
 * グラフに重なる文字を読めるようにする。背景色で縁取りを敷き、その上に本来の色を塗る。
 * paint-order:stroke fill で「先にストローク→後で塗り」の順になるため、
 * 縁取りが文字を痩せさせずに外側だけへ広がる。要素を2つ重ねる必要が無い。
 */
const halo = (attrs) => ({ ...attrs, stroke: BG, 'stroke-width': 3, 'stroke-linejoin': 'round', 'paint-order': 'stroke fill' });

/** 昇順 pts から [t0,t1] に入る範囲を二分探索で切り出す（全点を毎フレーム描かない） */
function sliceRange(pts, t0, t1) {
  let lo = 0, hi = pts.length - 1, a = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (pts[m][0] < t0) { a = m; lo = m + 1; } else hi = m - 1; }
  lo = 0; hi = pts.length - 1; let b = pts.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (pts[m][0] > t1) { b = m; hi = m - 1; } else lo = m + 1; }
  return [Math.max(0, a), Math.min(pts.length - 1, b)];
}

/*
 * 表示窓内の自動スケール。ただし **最小スパンを設ける**。
 *
 * 素の自動スケールだと、値がほとんど動かない区間（市街地の標高など）で
 * レンジが 1m まで縮み、ノイズが画面いっぱいに拡大されて信号に見える。
 * 逆に固定レンジだと低速域で線が下端に張り付いて死ぬ。
 *
 * minSpan で下限を切り、zeroBase なら 0 を必ず含める（車速など）。
 * sym なら **0 を中心に対称**にする。同一パネルで正負を持つ量（力行と回生）を
 * 比べるとき、0 が中央にないと同じ大きさの正負が違う長さに見えてしまう。
 */
function autoRange(series, axis, t0, t1, minSpan = 0, zeroBase = false, sym = false) {
  let lo = Infinity, hi = -Infinity;
  for (const s of series) {
    if ((s.axis || 'L') !== axis || !s.pts.length) continue;
    const [a, b] = sliceRange(s.pts, t0, t1);
    for (let i = a; i <= b; i++) { const v = s.pts[i][1]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  }
  if (!Number.isFinite(lo)) return null;
  if (zeroBase) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const pad = Math.max((hi - lo) * 0.12, 1e-6);
  lo -= pad; hi += pad;
  if (sym) { const m = Math.max(Math.abs(lo), Math.abs(hi)); lo = -m; hi = m; }
  if (minSpan > 0 && hi - lo < minSpan) {        // 狭すぎたら中心を保って広げる
    const c = sym ? 0 : (zeroBase && lo >= 0 ? minSpan / 2 : (lo + hi) / 2);
    lo = c - minSpan / 2; hi = c + minSpan / 2;
    if (zeroBase && !sym) { lo = Math.min(lo, 0); hi = lo + minSpan; }
  }
  return [lo, hi];
}

/**
 * グラフを描く。
 *  svg    : 対象の <svg>（viewBox は W×H に合わせておく）
 *  panels : パネル定義の配列
 *  tNow   : 現在時刻（赤線＝常に中央）
 *  span   : 表示する時間幅[秒]（tNow を中心に ±span/2）
 */
export function drawGraph(svg, panels, tNow, span, W, H) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const t0 = tNow - span / 2, t1 = tNow + span / 2;
  const PAD_L = 46, PAD_R = 52;                      // 左右の軸ラベル領域
  const plotW = W - PAD_L - PAD_R;
  const PX = (t) => PAD_L + ((t - t0) / span) * plotW;

  gEl('rect', { x: 0, y: 0, width: W, height: H, fill: '#0a1520' }, svg);

  let y = 0;
  for (const p of panels) {
    const h = p.h, yt = y + 2, yb = y + h - 2, ph = yb - yt;
    // 枠と目盛り
    gEl('rect', { x: PAD_L, y: yt, width: plotW, height: ph, fill: BG, stroke: '#16303f', 'stroke-width': 1 }, svg);
    const rngL = p.yl || autoRange(p.series, 'L', t0, t1, p.minL, p.zeroL, p.symL);
    const rngR = p.yr || autoRange(p.series, 'R', t0, t1, p.minR, p.zeroR, p.symR);
    const mapY = (v, r) => yb - ((v - r[0]) / (r[1] - r[0])) * ph;

    // 0 線（±を扱うパネル用）
    if (p.zero && rngL && rngL[0] < 0 && rngL[1] > 0) {
      const y0 = mapY(0, rngL);
      gEl('line', { x1: PAD_L, y1: y0, x2: PAD_L + plotW, y2: y0, stroke: '#2a4a5e', 'stroke-width': 1, 'stroke-dasharray': '3 3' }, svg);
    }
    // 系列
    for (const s of p.series) {
      const r = (s.axis === 'R') ? rngR : rngL;
      if (!r || !s.pts.length) continue;
      const [a, b] = sliceRange(s.pts, t0, t1);
      if (b <= a) continue;
      const XY = (i) => [PX(s.pts[i][0]), Math.max(yt, Math.min(yb, mapY(s.pts[i][1], r)))];
      /*
       * ペンが下りているかを明示的に持つ。以前は d の末尾が空白かで判定していたが、
       * 各点の後ろに必ず空白を付けていたため常に真になり、全点が M（移動）になって
       * 線が 1 本も描かれていなかった（fill だけが別経路で見えていた）。
       */
      let d = '', pen = false, first = -1, last = -1;
      for (let i = a; i <= b; i++) {
        if (!Number.isFinite(s.pts[i][1])) { pen = false; continue; }   // 欠測でパスを切る
        const [cx, cy] = XY(i);
        d += (pen ? 'L' : 'M') + cx.toFixed(1) + ' ' + cy.toFixed(1) + ' ';
        pen = true;
        if (first < 0) first = i;
        last = i;
      }
      if (!d) continue;
      // 塗りは区間分割より先に一度だけ。segColor/segDash でも塗りが消えないようにする
      if (s.fill) {
        const base = mapY(Math.max(r[0], 0), r);
        gEl('path', { d: d + `L${PX(s.pts[last][0]).toFixed(1)} ${base} L${PX(s.pts[first][0]).toFixed(1)} ${base} Z`,
                      fill: s.color, opacity: 0.18, stroke: 'none' }, svg);
      }
      /*
       * 区間ごとに色や線種が変わる系列。色はモード表現（マップのルートと同じ語彙）、
       * 線種は実測と推定の区別に使う。**系列を2本に割らずに済む**ので、凡例は1つのまま。
       */
      if (s.segColor || s.segDash) {
        const runs = [];
        let cur = null;
        for (let i = a; i <= b; i++) {
          if (!Number.isFinite(s.pts[i][1])) { cur = null; continue; }
          const col = s.segColor ? s.segColor(i) : s.color;
          const dash = s.segDash ? s.segDash(i) : null;
          const pt = XY(i);
          if (!cur || cur.col !== col || cur.dash !== dash) {
            if (cur) cur.pts.push(pt);                    // 境界で線を切らない（1点重ねる）
            cur = { col, dash, pts: [pt] }; runs.push(cur);
          } else cur.pts.push(pt);
        }
        for (const rn of runs) {
          if (rn.pts.length < 2) continue;
          const at = { d: 'M' + rn.pts.map((q) => q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(' L'),
                       fill: 'none', stroke: rn.col, 'stroke-width': s.w || 1.6,
                       'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
          if (rn.dash) at['stroke-dasharray'] = rn.dash;
          gEl('path', at, svg);
        }
        continue;
      }
      const at = { d, fill: 'none', stroke: s.color, 'stroke-width': s.w || 1.6,
                   'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
      if (s.dash) at['stroke-dasharray'] = s.dash;
      gEl('path', at, svg);
    }
    // 軸ラベル（上下端の値）と系列名
    const lab = (x, yy, txt, col, anchor) =>
      gEl('text', halo({ x, y: yy, 'text-anchor': anchor, 'font-size': 10, 'font-family': 'Courier New', fill: col }), svg).textContent = txt;
    if (rngL) { lab(PAD_L - 4, yt + 9, (p.fmtL || ((v) => v.toFixed(0)))(rngL[1]), '#6f8ba0', 'end');
                lab(PAD_L - 4, yb - 2, (p.fmtL || ((v) => v.toFixed(0)))(rngL[0]), '#6f8ba0', 'end'); }
    if (rngR) { lab(PAD_L + plotW + 4, yt + 9, (p.fmtR || ((v) => v.toFixed(0)))(rngR[1]), '#6f8ba0', 'start');
                lab(PAD_L + plotW + 4, yb - 2, (p.fmtR || ((v) => v.toFixed(0)))(rngR[0]), '#6f8ba0', 'start'); }
    /*
     * 系列名（左上に並べる）＋現在値。
     * **表示窓に実データが無い系列は凡例に出さない。** 補完区間だけに値を持つ
     * 「(推定)」系列が常時居座ると、実測しか無い場面でも推定があるように見える。
     * 逆にトンネル内では実測側が消えて推定だけが残るので、今どちらを見ているかが凡例で分かる。
     */
    let lx = PAD_L + 6;
    for (const s of p.series) {
      if (!s.pts.length) continue;
      const [va, vb] = sliceRange(s.pts, t0, t1);
      let visible = false;
      for (let i = va; i <= vb; i++) if (Number.isFinite(s.pts[i][1])) { visible = true; break; }
      if (!visible) continue;
      const r = (s.axis === 'R') ? rngR : rngL;
      // 現在値は「tNow 以前で最後の有限値」。sliceRange の b は窓の終端より1つ先を指すので
      // そのまま使うと1サンプル先の値（境界では NaN）を拾う
      let cur = NaN;
      for (let i = vb; i >= va; i--) {
        if (s.pts[i][0] > tNow) continue;
        if (Number.isFinite(s.pts[i][1])) { cur = s.pts[i][1]; break; }
      }
      const txt = s.name + (Number.isFinite(cur) ? ' ' + (s.fmt ? s.fmt(cur) : cur.toFixed(1)) : '');
      const t = gEl('text', halo({ x: lx, y: yt + 11, 'font-size': 11, 'font-family': 'Courier New',
                                  'font-weight': 'bold', fill: s.color }), svg);
      t.textContent = txt;
      lx += txt.length * 6.6 + 12;
    }
    /*
     * パネル単位の注記。再生位置の値が実測でないときだけ出す。
     * 系列ごとに「(推定)」の別項目を常設すると、実測しか無い場面でも推定が
     * あるように見えるうえ、窓のどこかに補完があるだけで点きっぱなしになる。
     * 判定は tNow の1点だけで行う。
     */
    if (p.flag) {
      const f = p.flag(tNow);
      if (f) gEl('text', halo({ x: lx, y: yt + 11, 'font-size': 11, 'font-family': 'Courier New',
                                'font-weight': 'bold', fill: '#e0a34a' }), svg).textContent = f;
    }
    y += h;
  }
  // 現在時刻（常に中央）
  gEl('line', { x1: PAD_L + plotW / 2, y1: 0, x2: PAD_L + plotW / 2, y2: H, stroke: '#ff4444', 'stroke-width': 1.5, opacity: 0.9 }, svg);
  // 時間軸の目安
  gEl('text', halo({ x: PAD_L + 2, y: H - 3, 'font-size': 10, 'font-family': 'Courier New', fill: '#4a6a80' }), svg)
    .textContent = '-' + (span / 2).toFixed(0) + 's';
  gEl('text', halo({ x: PAD_L + plotW - 2, y: H - 3, 'text-anchor': 'end', 'font-size': 10, 'font-family': 'Courier New', fill: '#4a6a80' }), svg)
    .textContent = '+' + (span / 2).toFixed(0) + 's';
}
