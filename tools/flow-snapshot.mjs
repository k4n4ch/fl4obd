import { readFile } from 'node:fs/promises';
const mk = t => { const e={tag:t,attrs:{},children:[],textContent:''};
  e.setAttribute=(k,v)=>e.attrs[k]=String(v);
  e.getAttribute=k=>e.attrs[k];
  e.appendChild=c=>{e.children.push(c);return c};
  e.removeChild=c=>{e.children=e.children.filter(x=>x!==c)};
  Object.defineProperty(e,'firstChild',{get:()=>e.children[0]||null});
  return e; };
global.document={createElementNS:(n,t)=>mk(t), getElementById:()=>mk('svg')};
const src = await readFile(process.argv[2] || new URL('../lib/flow.js', import.meta.url),'utf8');
new Function(src + ';globalThis.__D=D;globalThis.__draw=drawFlow;')();
const D = globalThis.__D;
const CASES=[
 {runMode:20,rawMode:20,peng:0,pgen:0,pbat:0.8,pdrive:0,soc:29,engRot:0,vsp:0,fuelShow:true,fuelLvl:54.5},
 {runMode:40,rawMode:40,peng:21,pgen:-20,pbat:-3.4,pdrive:12.6,soc:38,engRot:2100,vsp:42,fuelShow:true,fuelLvl:48.5},
 {runMode:50,rawMode:50,peng:24.1,pgen:0,pbat:-6.1,pdrive:-2.2,soc:52,engRot:2050,vsp:89,fuelShow:true,fuelLvl:45.5},
 {runMode:60,rawMode:60,peng:18,pgen:-12,pbat:2.0,pdrive:8,soc:61,engRot:1800,vsp:55,gx:0.1,gy:-0.05},
 {runMode:20,rawMode:20,peng:0,pgen:0,pbat:-5,pdrive:-9,soc:88,engRot:0,vsp:60},
];
const dump=n=>{ const a=Object.entries(n.attrs).sort().map(([k,v])=>k+'='+v).join(' ');
  return `${n.tag}[${a}]${n.textContent?'{'+n.textContent+'}':''}` + n.children.map(dump).map(s=>'\n  '+s).join(''); };
const out=[];
for (const c of CASES){
  for (const k of Object.keys(D)) delete D[k];
  Object.assign(D,c);
  const svg=mk('svg'); svg.setAttribute('viewBox', process.argv[3]||'0 0 380 600');
  globalThis.__draw(svg);
  out.push(svg.children.map(dump).join('\n'));
}
console.log(out.join('\n=====\n'));
