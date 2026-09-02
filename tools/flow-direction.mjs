/* 縦長と横長で、各矢印が「どのノードからどのノードへ」向いているかが一致するかを見る。
   干渉検査は重なりしか見ないので、向きの取り違えはこちらで捕まえる。 */
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
const NODES={
  portrait:{ENG:[68,213],MOT:[190,213],GEN:[68,418],BAT:[190,540],AUX:[312,418],WHEEL:[190,58],J:[190,418]},
  land:    {ENG:[72,44], MOT:[360,44], GEN:[72,168], BAT:[568,168],AUX:[568,44], WHEEL:[216,44],J:[360,168]},
};
const near=(p,ns)=>Object.entries(ns).map(([k,c])=>[k,Math.hypot(p[0]-c[0],p[1]-c[1])]).sort((a,b)=>a[1]-b[1])[0][0];
const flat=(n,a=[])=>{for(const c of n.children){a.push(c);flat(c,a);}return a;};
function arrows(vb,key,c){
  for(const k of Object.keys(D)) delete D[k];
  Object.assign(D,c);
  const svg=mk('svg'); svg.setAttribute('viewBox',vb); globalThis.__draw(svg);
  return flat(svg).filter(e=>e.tag==='path'&&e.attrs.d&&e.attrs.d.startsWith('M')&&+(e.attrs.opacity??1)>0.3)
    .map(e=>{const pts=e.attrs.d.split(/(?=[ML])/).map(t=>t.slice(1).trim().split(' ').map(Number));
      return near(pts[0],NODES[key])+'→'+near(pts[pts.length-1],NODES[key]);})
    .filter(s=>{const [a,b]=s.split('→');return a!==b;}).sort();
}
const CASES=[
 ['EV 力行',   {runMode:20,rawMode:20,peng:0,pgen:0,pdrive:8,   pbat:8.8, soc:29,engRot:0,   vsp:31}],
 ['EV 回生',   {runMode:20,rawMode:20,peng:0,pgen:0,pdrive:-9,  pbat:-8,  soc:60,engRot:0,   vsp:55}],
 ['SERIES',    {runMode:40,rawMode:40,peng:21,pgen:20,pdrive:12.6,pbat:-6.2,soc:38,engRot:2100,vsp:42}],
 ['DIRECT',    {runMode:50,rawMode:50,peng:24.1,pgen:0,pdrive:-2.2,pbat:-1.5,soc:52,engRot:2050,vsp:89}],
 ['TRANS60',   {runMode:60,rawMode:60,peng:18,pgen:12,pdrive:8,  pbat:-3.2,soc:61,engRot:1800,vsp:55}],
 ['TRANS60 逆',{runMode:60,rawMode:60,peng:5,pgen:-12,pdrive:-4, pbat:-2,  soc:88,engRot:1200,vsp:40}],
];
let bad=0;
for(const [name,c] of CASES){
  const p=arrows('0 0 380 600','portrait',c), l=arrows('0 0 640 240','land',c);
  const ok=JSON.stringify(p)===JSON.stringify(l);
  if(!ok){ bad++;
    console.log(`${name.padEnd(10)} 不一致`);
    console.log('   縦長:', p.join('  '));
    console.log('   横長:', l.join('  '));
  } else console.log(`${name.padEnd(10)} 一致  ${p.join('  ')}`);
}
console.log(bad? `\n${bad} 件が不一致` : '\n全状態で矢印の向きが一致');
