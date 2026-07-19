#!/usr/bin/env python3
# replay.html 検証用ダミーデータ生成。
# 合成走行(閉ループ)を作り、同期した GPX(1Hz) と フレーム.txt(2Hz, 622920) を出力する。
# バイト配置は index.html の parse22 と同一 (app index = report byte+2)。
import math, datetime, os

OUT = os.path.join(os.path.dirname(__file__), '..', 'testdata')
os.makedirs(OUT, exist_ok=True)

# ── 閉ループ経路(丸角矩形, 実座標) ─────────────────────────
CLAT, CLON = 35.7000, 139.7000            # 中心(東京付近)
def m2deg(dn, de, lat):                    # 北/東[m] → 緯度経度差
    return dn/111320.0, de/(111320.0*math.cos(math.radians(lat)))
def rounded_rect(hw, hh, r, n_side=40, n_corner=12):
    # 中心原点の丸角矩形の周を(北[m],東[m])で返す(閉ループ)
    pts=[]
    segs=[(( r-hw, -hh),( hw-r, -hh)),  # 下辺(南) 東進
          (( hw, r-hh),( hw, hh-r)),    # 右辺(東) 北進
          (( hw-r, hh),( r-hw, hh)),    # 上辺(北) 西進
          ((-hw, hh-r),(-hw, r-hh))]    # 左辺(西) 南進
    corners=[(hw-r,-(hh-r), -90,0),(hw-r,hh-r,0,90),(-(hw-r),hh-r,90,180),(-(hw-r),-(hh-r),180,270)]
    def line(a,b,n):
        for i in range(n):
            t=i/n; yield (a[1]+(b[1]-a[1])*t, a[0]+(b[0]-a[0])*t)  # (north=y? ) -> keep (E,N)? use (de,dn)
    order=[segs[0],corners[0],segs[1],corners[1],segs[2],corners[2],segs[3],corners[3]]
    out=[]
    for k in range(4):
        (a,b)=segs[k]
        for i in range(n_side):
            t=i/n_side
            de=a[0]+(b[0]-a[0])*t; dn=a[1]+(b[1]-a[1])*t
            out.append((dn,de))
        cx,cy,a0,a1=corners[k]
        for i in range(n_corner):
            ang=math.radians(a0+(a1-a0)*i/n_corner)
            out.append((cy+r*math.sin(math.radians(a0+(a1-a0)*i/n_corner)), cx+r*math.cos(ang)))
    return out
loop_ne = rounded_rect(hw=420, hh=300, r=90)          # (dn,de)[m] の閉ループ
# 累積距離と絶対座標
def seg_len(p,q):
    dn=q[0]-p[0]; de=q[1]-p[1]; return math.hypot(dn,de)
loop=loop_ne+[loop_ne[0]]
cum=[0.0]
for i in range(1,len(loop)):
    cum.append(cum[-1]+seg_len(loop[i-1],loop[i]))
PERIM=cum[-1]
def pos_at(dist):
    d=dist % PERIM
    lo,hi=0,len(cum)-1
    for i in range(1,len(cum)):
        if cum[i]>=d: lo=i-1; break
    seg=cum[lo+1]-cum[lo]; t=0 if seg==0 else (d-cum[lo])/seg
    dn=loop[lo][0]+(loop[lo+1][0]-loop[lo][0])*t
    de=loop[lo][1]+(loop[lo+1][1]-loop[lo][1])*t
    dlat,dlon=m2deg(dn,de,CLAT); return CLAT+dlat, CLON+dlon

# ── 速度プロファイル(km/h): (継続秒, 目標速度) の列を線形につなぐ ──
phases=[(0,0),(12,40),(28,40),(8,0),(4,0),(16,60),(38,60),(10,25),(18,25),
        (12,52),(30,52),(14,0),(4,0)]
tv=[]; t=0; v=0
for dur,tgt in phases:
    for _ in range(int(dur*2)):           # 0.5s刻み
        v += (tgt-v)*0.12
        tv.append((t, v)); t+=0.5
DUR=t
def speed_kmh(tt):
    i=min(int(tt*2), len(tv)-1); return tv[i][1]

# ── 車両パラメータ・簡易物理 ─────────────────────────────
M=1500.0; g=9.81; Crr=0.011; rho=1.2; Cd=0.30; A=2.2
def obd_at(tt):
    vk=speed_kmh(tt); vms=vk/3.6
    vk2=speed_kmh(tt+0.5); a=((vk2-vk)/3.6)/0.5
    F=M*a + M*g*Crr + 0.5*rho*Cd*A*vms*vms      # 駆動力[N] (正=加速)
    Pwheel=F*vms/1000.0                          # 車輪出力[kW] (正=力行,負=回生)
    # モード判定
    if vk<1: mode=20 if Pwheel<0.5 else 40       # 停車: 低需要EV / 充電series
    elif vk>=48 and abs(a)<0.3: mode=50          # 高速定常=直結
    elif Pwheel>2 or vk<25: mode=40              # 中負荷=series
    else: mode=20
    # 各値(LSB)
    vsp=max(0,min(255,round(vk)))
    # mot_trq: 車輪出力から  Pwheel=0.000147*drv*vsp
    drv = 0 if vsp==0 else Pwheel/(0.000147*max(vsp,1))
    if mode==20:
        eng_rpm=0; eng=0; gen=0
        pbat = Pwheel*1.05                        # 電池が駆動を賄う(力行+,回生-)
    elif mode==40:                                # series: エンジンが発電
        eng_rpm=int(1150 + max(0,Pwheel)*40)
        Peng=max(2.0, Pwheel*1.15+2.0)            # 発電機械出力
        eng = Peng/(2.09e-6*max(eng_rpm,1))       # eng_trq LSB
        fric=6.5+3.0*eng_rpm/1000.0               # 回転依存摩擦[Nm]
        gen = -max(0,(eng*0.02-fric))/0.0374      # gen_trq LSB(発電=負)
        Pgen=3.92e-6*(-gen)*eng_rpm
        pbat = Pwheel - Pgen                      # 収支の端数を電池
    else:                                         # direct: 直結
        eng_rpm=int(23*vsp)
        Peng=max(0,Pwheel*0.7)
        eng = Peng/(2.09e-6*max(eng_rpm,1))
        gen = 0
        pbat = Pwheel - Peng
    def s16(x): x=int(round(x)) & 0xFFFF; return x
    return dict(vsp=vsp, mode=mode, eng_rpm=int(eng_rpm),
                drv=int(round(drv)), gen=int(round(gen)), eng=int(round(eng)),
                pbat=int(round(pbat/0.01)))       # batt_pwr LSB (×0.01kW)

# ── 622920 フレーム(111B)エンコード ─────────────────────
def enc_frame(o):
    D=bytearray(111); D[0],D[1],D[2]=0x62,0x29,0x20
    def put16(i,val):
        v=int(val)&0xFFFF; D[i]=(v>>8)&0xFF; D[i+1]=v&0xFF
    D[15]=o['vsp']&0xFF                     # spd_echo (u8)
    D[79]=o['mode']&0xFF                    # mode
    put16(86,o['pbat'])                     # batt_pwr (s16)
    put16(90,o['drv'])                      # drv_trq3
    put16(92,o['gen'])                      # gen_trq
    put16(96,o['eng'])                      # eng_trq
    put16(100,o['eng_rpm']*4)              # eng_rpm (÷4)
    # フレーム分割: 0=6B, 1..15=7B
    hexs=D.hex().upper()
    toks=[]; pos=0
    for k in range(16):
        ln=6 if k==0 else 7
        chunk=hexs[pos*2:(pos+ln)*2]; pos+=ln
        toks.append((f'{k}:' if k<10 else f'{k}')+chunk)
    return '06F '+' '.join(toks)

# ── 出力 ────────────────────────────────────────────────
BASE=datetime.datetime(2026,7,17,8,0,0,tzinfo=datetime.timezone.utc)
def iso(dt): return dt.strftime('%Y-%m-%dT%H:%M:%S.')+f'{dt.microsecond//1000:03d}Z'

# GPX (1Hz)
gpx=['<?xml version="1.0" encoding="UTF-8"?>',
     '<gpx version="1.1" creator="fl4obd-dummy" xmlns="http://www.topografix.com/GPX/1/1">',
     '<trk><name>dummy drive</name><trkseg>']
cd=0.0
for i in range(int(DUR)+1):
    tt=float(i)
    lat,lon=pos_at(cd)
    gpx.append(f'<trkpt lat="{lat:.7f}" lon="{lon:.7f}"><time>{iso(BASE+datetime.timedelta(seconds=tt))}</time></trkpt>')
    cd += speed_kmh(tt)/3.6                 # 次の1秒で進む距離(m)
gpx+=['</trkseg></trk>','</gpx>','']
open(os.path.join(OUT,'dummy_drive.gpx'),'w').write('\n'.join(gpx))

# フレーム.txt (2Hz)
lines=[]; soc=62.0
for j in range(int(DUR*2)):
    tt=j*0.5; dt=BASE+datetime.timedelta(seconds=tt)
    o=obd_at(tt)
    soc -= (o['pbat']*0.01)*0.04                 # pbat[kW]で SOC ドリフト(放電で減/充電で増)
    soc = max(20.0, min(88.0, soc))
    ts=dt.strftime('%H:%M:%S.')+f'{dt.microsecond//1000:03d}'
    aa=max(0,min(255,round(soc*255/100)))
    lines.append(f'[{ts}] [ok ] ← 415B{aa:02X}555555')   # SOC (01_5B) を先に
    lines.append(f'[{ts}] [ok ] ← '+enc_frame(o))
gen_dt=BASE+datetime.timedelta(seconds=DUR+1)
txt='FL4 OBD MONITOR LOG\nGenerated: '+iso(gen_dt)+'\n'+'='*60+'\n'+'\n'.join(lines)+'\n'
open(os.path.join(OUT,'dummy_drive.txt'),'w').write(txt)

print(f'DUR={DUR}s  GPX pts={int(DUR)+1}  frames={int(DUR*2)}  perim={PERIM:.0f}m')
print('wrote testdata/dummy_drive.gpx, dummy_drive.txt')
