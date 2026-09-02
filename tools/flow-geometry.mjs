import { readFile } from 'node:fs/promises';
const mk = t => { const e={tag:t,attrs:{},children:[],textContent:''};
  e.setAttribute=(k,v)=>e.attrs[k]=v; e.getAttribute=k=>e.attrs[k];
  e.appendChild=c=>{e.children.push(c);return c};
  e.removeChild=c=>{e.children=e.children.filter(x=>x!==c)};
  Object.defineProperty(e,'firstChild',{get:()=>e.children[0]||null});
  return e; };
global.document={createElementNS:(n,t)=>mk(t), getElementById:()=>mk('svg')};
new Function(await readFile(new URL('../lib/flow.js', import.meta.url),'utf8') + ';globalThis.__D=D;globalThis.__draw=drawFlow;')();
const D=globalThis.__D;
const CW=0.6;
/* 母線の収支が合う組（aux は残差なので、辻褄が合わないと 0 になり検査にならない） */
const CASES=[
 ['EV',     {runMode:20,rawMode:20,peng:0,pgen:0,pdrive:8,   pbat:8.8, soc:29,engRot:0,   vsp:31,fuelShow:true,fuelLvl:54.5}],
 ['SERIES', {runMode:40,rawMode:40,peng:21,pgen:20,pdrive:12.6,pbat:-6.2,soc:38,engRot:2100,vsp:42,fuelShow:true,fuelLvl:48.5}],
 ['DIRECT', {runMode:50,rawMode:50,peng:24.1,pgen:0,pdrive:-2.2,pbat:-1.5,soc:52,engRot:2050,vsp:89,fuelShow:true,fuelLvl:45.5}],
 ['TRANS60',{runMode:60,rawMode:60,peng:18,pgen:12,pdrive:8,  pbat:-3.2,soc:61,engRot:1800,vsp:55,fuelShow:true,fuelLvl:40.0}],
];
const flat=(n,acc=[])=>{ for(const c of n.children){ acc.push(c); flat(c,acc);} return acc; };
const ov=(a,b)=>!(a.x2<=b.x1||b.x2<=a.x1||a.y2<=b.y1||b.y2<=a.y1);
const seg=(p,q,r)=>{for(let k=0;k<=60;k++){const x=p[0]+(q[0]-p[0])*k/60,y=p[1]+(q[1]-p[1])*k/60;
  if(x>r.x1&&x<r.x2&&y>r.y1&&y<r.y2)return true;}return false;};
const VB={w:640,h:240};
let total=0;
for(const [name,c] of CASES){
  for(const k of Object.keys(D)) delete D[k];
  Object.assign(D,c);
  const svg=mk('svg'); svg.setAttribute('viewBox','0 0 640 240');
  globalThis.__draw(svg);
  const all=flat(svg);
  const rects=all.filter(e=>e.tag==='rect').map(e=>({x1:+e.attrs.x,y1:+e.attrs.y,x2:+e.attrs.x+ +e.attrs.width,y2:+e.attrs.y+ +e.attrs.height,tag:'箱'}));
  const circs=all.filter(e=>e.tag==='circle'&&+e.attrs.r>10).map(e=>({x1:e.attrs.cx-e.attrs.r,y1:e.attrs.cy-e.attrs.r,x2:+e.attrs.cx+ +e.attrs.r,y2:+e.attrs.cy+ +e.attrs.r,tag:'車輪'}));
  const texts=all.filter(e=>e.tag==='text'&&e.textContent).map(e=>{
    const s=+e.attrs['font-size'], w=e.textContent.length*s*CW, an=e.attrs['text-anchor'];
    const x=an==='middle'?e.attrs.x-w/2:an==='end'?e.attrs.x-w:+e.attrs.x;
    return {x1:x,y1:e.attrs.y-s*0.8,x2:x+w,y2:+e.attrs.y+s*0.22,tag:`"${e.textContent}"`,op:+(e.attrs.opacity??1)};
  }).filter(t=>t.op>0.3);
  const paths=all.filter(e=>e.tag==='path'&&e.attrs.d&&+(e.attrs.opacity??1)>0.3)
    .map(e=>e.attrs.d.split(/(?=[ML])/).map(t=>t.slice(1).trim().split(' ').map(Number)));
  const hit=[];
  const solid=[...rects,...circs];
  // 箱の中に完全に収まっている文字はその箱のラベル。干渉ではない
  const inside=(t,b)=>t.x1>=b.x1&&t.x2<=b.x2&&t.y1>=b.y1&&t.y2<=b.y2;
  for(const t of texts) for(const b of solid) if(ov(t,b)&&!inside(t,b)) hit.push(`文字${t.tag}×${b.tag}`);
  for(let i=0;i<texts.length;i++) for(let j=i+1;j<texts.length;j++) if(ov(texts[i],texts[j])) hit.push(`文字${texts[i].tag}×文字${texts[j].tag}`);
  for(const p of paths) for(let k=0;k<p.length-1;k++){
    for(const b of rects) if(seg(p[k],p[k+1],b)) hit.push('線×箱');
    for(const t of texts) if(seg(p[k],p[k+1],t)) hit.push(`線×文字${t.tag}`);
  }
  for(const t of texts) if(t.x1<0||t.x2>VB.w||t.y1<0||t.y2>VB.h) hit.push(`文字${t.tag}が枠外`);
  const u=[...new Set(hit)]; total+=u.length;
  console.log(`${name.padEnd(8)} 箱${rects.length} 文字${texts.length} 線${paths.length} → ${u.length?'干渉 '+u.join(' / '):'干渉なし'}`);
}
console.log(total? '\n要修正' : '\n横長 640×240: すべて干渉なし');
