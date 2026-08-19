/*
 * flow.js — パワーフロー図の描画（replay.html から抽出した共有ライブラリ）
 *
 * replay.html と video.html が共用する。クラシックスクリプトとして読み込み、
 * 呼び出し側の既存コードをそのまま動かすためグローバルに定義する。
 *
 *   <script src="lib/flow.js"></script>
 *   D.peng=... ; drawFlow(svgEl)   // svgEl 省略時は #flowSvg
 *
 * SVG の viewBox は 0 0 380 600 を前提とする。
 */
const D = {};   // drawFlow が参照する現在値
// 70(直結クラッチ開放準備)は実測で GEN が80%活性の遷移状態なので TRANS 扱いにする
const MODE_LABELS = { 20:'EV', 40:'SERIES', 50:'DIRECT', 10:'TRANS', 30:'TRANS', 60:'TRANS', 70:'TRANS' };
const MODE_COLOR  = { EV:'#00e5ff', SERIES:'#4a9eff', DIRECT:'#ff9a44', TRANS:'#8aa0b4' };
function modeColorOf(mode){ return MODE_COLOR[MODE_LABELS[mode]] || '#8aa0b4'; }
function spdWidth(v){ v=Math.max(0,Math.min(110,v||0)); return Math.round(2 + v/110*10); }  // 車速→線幅 2..12(俯瞰でも差が出るよう広め)
const FNS='http://www.w3.org/2000/svg';
function fEl(tag,attrs,parent){const e=document.createElementNS(FNS,tag);for(const k in attrs)e.setAttribute(k,attrs[k]);if(parent)parent.appendChild(e);return e;}
const FX_M='#ff9a44', FX_E='#00e5ff', FX_R='#25e0a0', FX_A='#c9a0ff';
const fWX=190,fWY=58, fEX=20,fEY=185, fTX=142,fTY=185, fGX=20,fGY=390, fJX=190,fJY=418, fBX=142,fBY=512, fAX=264,fAY=390, fBW=96,fBH=56;
function fDefs(svg){
  const d=fEl('defs',{},svg);
  for(const [id,c] of [['fah_mech',FX_M],['fah_elec',FX_E],['fah_regen',FX_R],['fah_aux',FX_A]]){
    const m=fEl('marker',{id,markerWidth:2.6,markerHeight:2.4,refX:2.3,refY:1.2,orient:'auto',markerUnits:'strokeWidth'},d);
    fEl('path',{d:'M0 0 L2.6 1.2 L0 2.4 Z',fill:c},m);
  }
}
function fArrow(svg,pts,kind,active,kw,lx,ly,col,anchor){
  const color = col || (kind==='mech'?FX_M:kind==='elec'?FX_E:kind==='aux'?FX_A:FX_R);
  const mk = {[FX_M]:'fah_mech',[FX_E]:'fah_elec',[FX_R]:'fah_regen',[FX_A]:'fah_aux'}[color]||'fah_elec';
  const mag = (kw!=null)?Math.abs(kw):0;
  const w = active ? Math.max(3.6, Math.min(2.4+mag*0.18,15)) : 2.6;
  const d = pts.map((p,i)=>(i?'L':'M')+p[0]+' '+p[1]).join(' ');
  fEl('path',{d,fill:'none',stroke:color,'stroke-width':w,'stroke-linecap':'round','stroke-linejoin':'round','marker-end':'url(#'+mk+')',opacity:active?1:0.15},svg);
  if(kw!=null){const t=fEl('text',{x:lx,y:ly,'text-anchor':anchor||'middle','font-size':28,'font-weight':'bold','font-family':'Courier New',fill:color,opacity:active?1:0.15},svg);t.textContent=kw.toFixed(1);}
}
function fNode(svg,x,y,label,sub,on,hot,subcol){
  const g=fEl('g',{opacity:on?1:0.45},svg);
  fEl('rect',{x,y,width:fBW,height:fBH,rx:7,fill:'#111a24',stroke:on?'#4a6a80':'#2a3a4a','stroke-width':1.6},g);
  fEl('text',{x:x+fBW/2,y:y+(hot?24:31),'text-anchor':'middle','font-size':19,'font-weight':'bold','font-family':'Courier New',fill:'#dfefff'},g).textContent=label;
  fEl('text',{x:x+fBW/2,y:y+46,'text-anchor':'middle','font-size':hot?19:10,'font-family':'Courier New','font-weight':hot?'bold':'normal',fill:hot?(subcol||'#9fe8ff'):'#5a7a90'},g).textContent=sub;
}
function fWheel(svg,x,y,on,spd){
  const g=fEl('g',{opacity:on?1:0.45},svg);
  fEl('circle',{cx:x,cy:y,r:20,fill:'none',stroke:'#889','stroke-width':3.5},g);
  fEl('circle',{cx:x,cy:y,r:5,fill:'#889'},g);
  fEl('text',{x:x-32,y:y+6,'text-anchor':'end','font-size':11,fill:'#889'},g).textContent='車輪';
  if(spd!=null&&!isNaN(spd)){fEl('text',{x:x+30,y:y+8,'text-anchor':'start','font-size':24,'font-weight':'bold','font-family':'Courier New',fill:'#9fe8ff'},svg).textContent=Math.round(spd)+' km/h';}
}
// ── Gボール（前後左右G） ────────────────────────────────────────────
// パワーフロー図の左下の空き（GEN箱の下・BAT箱の左）に置く。viewBox 0 0 380 600 前提。
// D.gx=前後G[g](＋加速) / D.gy=左右G[g](＋右旋回)。未設定なら何も描かない（replay.html は無影響）。
const AUX_MAX=3.0;   // 補機の実測上限[kW](A/C1.8+ブロワ0.4+DC-DC0.16≈2.5)。超える残差は不整合として飽和表示
const GB_CX=70, GB_CY=509, GB_R=48, GB_FS=0.5;   // 外周リング=0.5g。GEN箱(下端446)とviewBox下端(600)の間に収める
// ── 残燃料 ────────────────────────────────────────────────
// PID 012F は残量[%]しか返さないので容量を掛けて L 換算する。カタログ値 40L。
// 分解能は 100/255=0.39% ＝ 0.157L/count なので、小数1桁より下は意味が無い。
const FUEL_TANK_L=40;
const FU_CX=312, FU_Y=500;   // MODE(x=312)と同じ列。BAT箱(右端238)とviewBox右端の間の空き
/*
 * gx/gy が数値なら通常表示、null/NaN なら**グレーアウト表示**（枠だけ出して note を添える）。
 * 「校正が済んでいないから出ない」だと何が足りないのか分からないため、枠は常に出す。
 */
function fGBall(svg,gx,gy,note){
  const live = (gx!=null && gy!=null && !isNaN(gx) && !isNaN(gy));
  const g=fEl('g',{opacity:live?1:0.4},svg);
  fEl('circle',{cx:GB_CX,cy:GB_CY,r:GB_R,fill:'#0a1520',stroke:'#2a4a5e','stroke-width':1.6},g);
  fEl('circle',{cx:GB_CX,cy:GB_CY,r:GB_R/2,fill:'none',stroke:'#223c4e','stroke-width':1.2},g);
  fEl('line',{x1:GB_CX-GB_R,y1:GB_CY,x2:GB_CX+GB_R,y2:GB_CY,stroke:'#223c4e','stroke-width':1},g);
  fEl('line',{x1:GB_CX,y1:GB_CY-GB_R,x2:GB_CX,y2:GB_CY+GB_R,stroke:'#223c4e','stroke-width':1},g);
  // 'G' はリング内側の左上の空白へ。ボールより先に描くので重なったときはボールが上に来る
  fEl('text',{x:GB_CX-GB_R*0.60,y:GB_CY-GB_R*0.46,'text-anchor':'middle','font-size':13,'font-weight':'bold','font-family':'Courier New',fill:'#4a6a80'},g).textContent='G';
  if(!live){
    fEl('circle',{cx:GB_CX,cy:GB_CY,r:7,fill:'none',stroke:'#5a7a90','stroke-width':1.6},g);
    fEl('text',{x:GB_CX,y:GB_CY+GB_R+16,'text-anchor':'middle','font-size':11,'font-family':'Courier New',fill:'#7a95ad'},g).textContent=note||'--';
    return;
  }
  // 体が押される方向にボールを動かす（加速で後ろ＝下、右旋回で左）
  const m=Math.hypot(gx,gy), cl=m>GB_FS?GB_FS/m:1;
  const bx=GB_CX-(gy*cl)/GB_FS*GB_R, by=GB_CY+(gx*cl)/GB_FS*GB_R;
  fEl('line',{x1:GB_CX,y1:GB_CY,x2:bx,y2:by,stroke:'#ffcc44','stroke-width':2,opacity:0.5},g);
  fEl('circle',{cx:bx,cy:by,r:7,fill:'#ffcc44',stroke:'#fff','stroke-width':1.6},g);
  const t=(v)=>(v>=0?'+':'')+v.toFixed(2);
  // 合成G(原点からのベクトル長=ボールの距離)を主表示、前後/左右の成分を副表示にする
  fEl('text',{x:GB_CX,y:GB_CY+GB_R+14,'text-anchor':'middle','font-size':14,'font-weight':'bold','font-family':'Courier New',fill:'#ffcc44'},g).textContent=m.toFixed(2)+' g';
  fEl('text',{x:GB_CX,y:GB_CY+GB_R+26,'text-anchor':'middle','font-size':9,'font-family':'Courier New',fill:'#7a95ad'},g).textContent='前後'+t(gx)+'  左右'+t(gy);
}

function drawFlow(svg){
  svg=svg||document.getElementById('flowSvg');
  while(svg.firstChild) svg.removeChild(svg.firstChild);
  fDefs(svg);
  const mode=(D.dispMode>=0)?D.dispMode:D.runMode;
  /*
   * トポロジとラベルは「生モード」(D.rawMode)で決める。解決後モード(modeR)で決めると
   * レブマッチ(60)が DIRECT として扱われ、直結には存在しない GEN 枝が出たうえに
   * エンジン出力が車軸とGENに二重計上される。
   * 実測(3ログ): 直結50 は pgen が 0/1480 サンプルで完全にゼロ。60 は pgen が97%活性、
   * 70(クラッチ開放準備)は80%活性。EV20 は peng/pgen とも最大まで完全にゼロ。
   */
  const raw=(D.rawMode!=null&&D.rawMode>=0)?D.rawMode:mode;
  const modeLabel=MODE_LABELS[raw]||'--';
  const isDirect=(raw===50||raw===70), isSeries=(raw===40);
  const peng=D.peng||0, pgen=D.pgen||0, pbat=D.pbat||0, pdrive=D.pdrive||0;
  const regen = pdrive < -0.1;
  const on=(v)=>Math.abs(v)>0.1;
  const genGen = pgen > 0.1;
  const genMot = pgen < -0.1;
  const genMag = Math.abs(pgen);
  const dump = regen && genMot && D.soc >= 85;
  let trcWheel, busTrc;
  // 存在する枝はモードで決定的に決める（双方向な枝の向きだけ実測符号で決める）
  const hasEngWheel  = (raw===50||raw===70);      // クラッチ係合＝エンジンが機械的に車軸へ
  const hasGenBranch = !(raw===20||raw===50);     // EV と純粋直結では GEN 枝が存在しない
  const genMagM = hasGenBranch ? genMag : 0;
  // エンジン出力を「発電機」と「車軸」に分配する（合計が peng を超えないようにする）
  const engGen   = hasGenBranch ? (genMot ? genMagM : Math.min(genMagM, peng)) : 0;
  const engWheel = hasEngWheel ? Math.max(0, peng - engGen) : 0;
  const genBus   = genMagM;
  if(regen)          { trcWheel=-pdrive; busTrc=-pdrive; }
  else if(hasEngWheel){ trcWheel=Math.max(0,pdrive-engWheel); busTrc=trcWheel; }
  else               { trcWheel=pdrive; busTrc=pdrive; }
  // AUX は他の枝で説明できない残差。実測上限を大きく超える値はモデル不整合なので
  // 飽和表示にして偽の精度を出さない（過渡では 25kW 級の無意味な値になる）。
  const auxRaw = Math.max(0, (regen?busTrc:-busTrc) + (genGen?genMagM:(genMot?-genMagM:0)) + pbat);
  const auxSat = auxRaw > AUX_MAX;
  const aux = auxSat ? AUX_MAX : auxRaw;
  const batBus=-pbat;
  fArrow(svg,[[fEX+fBW/2,fEY],[fEX+fBW/2,fWY],[fWX-24,fWY]],'mech',on(engWheel),on(engWheel)?engWheel:null,128,140);
  if(regen) fArrow(svg,[[fTX+fBW/2,fWY+24],[fTX+fBW/2,fTY]],'mech',on(trcWheel),on(trcWheel)?trcWheel:null,286,140,FX_R,'end');
  else      fArrow(svg,[[fTX+fBW/2,fTY],[fTX+fBW/2,fWY+24]],'mech',on(trcWheel),on(trcWheel)?trcWheel:null,286,140,FX_M,'end');
  if(genMot) fArrow(svg,[[fEX+fBW/2,fGY],[fEX+fBW/2,fEY+fBH]],'mech',on(engGen),on(engGen)?engGen:null,128,326,dump?FX_R:FX_M);
  else       fArrow(svg,[[fEX+fBW/2,fEY+fBH],[fEX+fBW/2,fGY]],'mech',on(engGen),on(engGen)?engGen:null,128,326);
  if(genMot) fArrow(svg,[[fJX-9,fJY],[fGX+fBW,fGY+fBH/2]],'elec',on(genBus),on(genBus)?genBus:null,132,378,dump?FX_R:null);
  else       fArrow(svg,[[fGX+fBW,fGY+fBH/2],[fJX-9,fJY]],'elec',on(genBus),on(genBus)?genBus:null,132,378);
  if(regen) fArrow(svg,[[fJX,fTY+fBH],[fJX,fJY-9]],'elec',on(busTrc),on(busTrc)?busTrc:null,286,326,FX_R,'end');
  else      fArrow(svg,[[fJX,fJY-9],[fJX,fTY+fBH]],'elec',on(busTrc),on(busTrc)?busTrc:null,286,326,null,'end');
  if(batBus>=0) fArrow(svg,[[fJX,fJY+9],[fBX+fBW/2,fBY]],'elec',on(batBus),on(batBus)?batBus:null,286,470,regen?FX_R:FX_E,'end');
  else          fArrow(svg,[[fBX+fBW/2,fBY],[fJX,fJY+9]],'elec',on(batBus),on(batBus)?-batBus:null,286,470,null,'end');
  fArrow(svg,[[fJX+9,fJY],[fAX,fAY+fBH/2]],'aux',on(aux),on(aux)?aux:null,286,378,null,'end');
  fEl('circle',{cx:fJX,cy:fJY,r:8,fill:'#0a0e14',stroke:FX_E,'stroke-width':2.5},svg);
  fEl('circle',{cx:fJX,cy:fJY,r:3,fill:FX_E},svg);
  fNode(svg,fEX,fEY,'ENG',(Math.round(D.engRot)||0)+' rpm',on(peng)||genMot,true);
  fNode(svg,fTX,fTY,'MOT','P_mot',on(pdrive));
  fNode(svg,fGX,fGY,'GEN','P_gen',on(pgen));
  if(dump) fEl('text',{x:fEX+fBW/2,y:fEY-8,'text-anchor':'middle','font-size':14,'font-weight':'bold','font-family':'Courier New',fill:'#ff5544'},svg).textContent='廃電';
  fNode(svg,fBX,fBY,'BAT',isNaN(D.soc)?'SOC --':'SOC '+D.soc.toFixed(0)+'%',true,true);
  fNode(svg,fAX,fAY,'AUX/AC',on(aux)?(auxSat?'>'+AUX_MAX.toFixed(1)+'kW':aux.toFixed(1)+'kW'):'--',on(aux),true,auxSat?'#ff8844':FX_A);
  fWheel(svg,fWX,fWY,on(trcWheel)||on(engWheel),D.vsp);
  if(D.gShow || (D.gx!=null && D.gy!=null)) fGBall(svg,D.gx,D.gy,D.gNote);
  // 残燃料。012F をポーリングするアプリだけが fuelShow を立てる。
  // 未取得でも枠は出す（Gボールと同じ理由: 何も出ないと「未対応」と区別が付かない）
  const fuLive=(D.fuelLvl!=null && isFinite(D.fuelLvl));
  if(D.fuelShow || fuLive){
    const fl=fuLive?D.fuelLvl/100*FUEL_TANK_L:null;
    const fc = !fuLive ? '#7a95ad' : fl<=4 ? '#ff4444' : fl<=8 ? '#ffaa00' : '#dfefff';  // 概ね警告灯の点く域
    const g=fEl('g',{opacity:fuLive?1:0.4},svg);
    fEl('text',{x:FU_CX,y:FU_Y,'text-anchor':'middle','font-size':12,'font-family':'Courier New',fill:'#5a7a90','letter-spacing':2},g).textContent='FUEL';
    fEl('text',{x:FU_CX,y:FU_Y+30,'text-anchor':'middle','font-size':26,'font-weight':'bold','font-family':'Courier New',fill:fc},g).textContent=fuLive?fl.toFixed(1)+' L':'-- L';
    fEl('text',{x:FU_CX,y:FU_Y+48,'text-anchor':'middle','font-size':11,'font-family':'Courier New',fill:'#7a95ad'},g).textContent=(fuLive?D.fuelLvl.toFixed(1):'--')+' %  /'+FUEL_TANK_L+'L';
  }
  const mc={EV:FX_E,SERIES:FX_E,DIRECT:FX_M,TRANS:MODE_COLOR.TRANS}[modeLabel]||'#cfe';
  fEl('text',{x:312,y:fEY+8,'text-anchor':'middle','font-size':12,'font-family':'Courier New',fill:'#5a7a90','letter-spacing':2},svg).textContent='MODE';
  fEl('text',{x:312,y:fEY+38,'text-anchor':'middle','font-size':26,'font-weight':'bold','font-family':'Courier New',fill:mc},svg).textContent=modeLabel;
}

// ═══ 描画 ═════════════════════════════════════════════════
