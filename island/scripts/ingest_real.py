#!/usr/bin/env python3
# ingest_real.py — IslandResilience 앱에 논문 번들 실측 데이터(야간광·PV·SIAI/VQI·공식 전력노드) 반영
# 입력: uploads/paper/*, uploads/gen_est/data/*  →  출력: island/data-real/indicators_real.json
import json, csv, math, re
from datetime import date

UP = '/home/user/workspace/uploads'
APP = '/home/user/workspace/island'

def norm(s):
    return re.sub(r"['’`\- ]", '', str(s or '').lower())

def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))

def fnum(x):
    try:
        v = float(x)
        return None if (v != v) else v  # NaN guard
    except Exception:
        return None

# ---------- 1. 앱 마을(74) ----------
villages = json.load(open(f'{APP}/data-real/villages.json'))
if isinstance(villages, dict):
    villages = villages.get('villages', [])

# ---------- 2. 논문 표: 2025 이벤트 / VQI-SIAI ----------
ev = {}
for r in csv.DictReader(open(f'{UP}/paper/as_2025_event.csv')):
    ev[norm(r['name'])] = r
vqi = {}
for r in csv.DictReader(open(f'{UP}/paper/village_vqi_siai_final.csv')):
    vqi[norm(r['NAME'])] = r

# ---------- 3. 마을 경계(WKT) → 점포함 판정 ----------
def parse_rings(wkt):
    rings = []
    for m in re.finditer(r'\(\(([^()]+)\)\)', wkt):
        pts = []
        for pair in m.group(1).split(','):
            xy = pair.split()
            if len(xy) >= 2:
                pts.append((float(xy[0]), float(xy[1])))
        if pts:
            rings.append(pts)
    return rings

def pip(lon, lat, ring):
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > lat) != (y2 > lat):
            xin = x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
            if lon < xin:
                inside = not inside
    return inside

polys = {}
with open(f'{UP}/paper/village_treatment_h5.csv') as f:
    for r in csv.DictReader(f):
        polys[norm(r['NAME'])] = parse_rings(r['geom'])

# ---------- 4. Sentinel-2 PV 탐지 → 마을별 집계 ----------
pv_all = list(csv.DictReader(open(f'{UP}/paper/samoa_pv_detections.csv')))
pv_by_village = {}
for p in pv_all:
    lon, lat = float(p['lon']), float(p['lat'])
    mw = fnum(p['capacity_mw']) or 0.0
    ha = fnum(p['area_ha']) or 0.0
    placed = False
    for name, rings in polys.items():
        if any(pip(lon, lat, ring) for ring in rings):
            pv_by_village.setdefault(name, []).append((mw, ha, 0.0))
            placed = True
            break
    if not placed:
        best = None
        for name, r in vqi.items():
            d = haversine(lat, float(r['lat']), lon, float(r['lon']))
            if best is None or d < best[0]:
                best = (d, name)
        if best and best[0] <= 3.0:
            pv_by_village.setdefault(best[1], []).append((mw, ha, round(best[0], 2)))

# ---------- 5. 공식 전력노드(미국령 사모아 4곳) ----------
nodes = [r for r in csv.DictReader(open(f'{UP}/gen_est/data/official_nodes.csv'))
         if 'American Samoa' in (r['island'] or '')]

# ---------- 6. 마을별 병합 ----------
out = {}
matched = 0
for v in villages:
    key = norm(v['name'])
    e = ev.get(key)
    q = vqi.get(key)
    if e is None or q is None:
        best = None
        for nk, r in vqi.items():
            d = (float(r['lat']) - v['lat']) ** 2 + (float(r['lon']) - v['lon']) ** 2
            if best is None or d < best[0]:
                best = (d, nk)
        if best and best[0] <= 0.0036:  # ~6km
            key = best[1]
            e = e or ev.get(key)
            q = q or vqi.get(key)
    if e:
        matched += 1
    rec = {'matched': bool(e)}
    if e:
        rec.update({
            'geoid': e['GEOID'], 'matched_name': e['name'],
            'siai': round(fnum(e['SIAI']), 4) if fnum(e['SIAI']) is not None else None,
            'vqi': round(fnum(q['VQI']), 4) if q and fnum(q['VQI']) is not None else None,
            'ntl_pre': fnum(e['ntl_pre']), 'ntl_event': fnum(e['ntl_event']),
            'drop_pct': round(fnum(e['drop_pct']), 2) if fnum(e['drop_pct']) is not None else None,
            'rec_days': int(float(e['recovery_days'])) if e.get('recovery_days') not in (None, '', 'nan') else None,
            'exp_flood': fnum(e['EXP_flood']), 'exp_wind': fnum(e['EXP_wind']), 'exp_asset': fnum(e['EXP_asset']),
        })
    elif q:
        rec.update({'matched_name': q['NAME'],
                    'siai': round(fnum(q['SIAI']), 4) if fnum(q['SIAI']) is not None else None,
                    'vqi': round(fnum(q['VQI']), 4) if fnum(q['VQI']) is not None else None})
    plist = pv_by_village.get(key, [])
    rec['pv_mw'] = round(sum(p[0] for p in plist), 3)
    rec['pv_count'] = len(plist)
    rec['pv_area_ha'] = round(sum(p[1] for p in plist), 3)
    best_d = None
    for p in pv_all:
        d = haversine(v['lat'], v['lon'], float(p['lat']), float(p['lon']))
        if best_d is None or d < best_d:
            best_d = d
    rec['pv_nearest_km'] = round(best_d, 2) if best_d is not None else None
    dn = db_ = None
    near = None
    for nd in nodes:
        d = haversine(v['lat'], v['lon'], float(nd['lat']), float(nd['lon']))
        if nd['type'] in ('solar', 'solar_bess', 'bess') and (db_ is None or d < db_):
            db_ = d
        if dn is None or d < dn:
            dn, near = d, nd
    rec['dist_power_node_km'] = round(dn, 2) if dn is not None else None
    rec['dist_bess_km'] = round(db_, 2) if db_ is not None else None
    if near is not None and dn is not None and dn <= 2.0:
        rec['official_asset'] = {'label': near['label'], 'type': near['type'], 'capacity_kw': None,
                                 'source': near['official_sources'], 'dist_km': round(dn, 2)}
    out[norm(v['name'])] = rec

meta = {
    'event': '2025 compound disaster — VIIRS DNB nightly NTL (117 nights, 2025-01-01 ~ 2025-12-30), village-level pre/event light, drop %, recovery days',
    'pv': 'Sentinel-2 L2A (2025-09-12 scene) PV panel detections — 204 objects, 45.75 MW, 50.8 ha; capacity_mw from panel_count × module watt estimate',
    'siai_vqi': 'SIAI (infrastructure-access z-index: OSM buildings/roads/amenities + DEM lowland/flatness) and VQI (5 social axes) — user research bundle',
    'official_assets': 'Documented AS power facilities (DOE/EIA) — Satala & Tafuna diesel-thermal, Pava\'ia\'i & Aunu\'u solar+BESS',
    'honesty': 'Socioeconomic (income/education/unemployment/age) and water indicators remain SYNTHETIC demo values. Gita-2018 demo columns retired to NULL — real 2025 event values live in event2025_* columns.',
    'sources': ['VIIRS DNB (paper bundle as_daily_ntl.json / as_2025_event.csv)',
                'Sentinel-2 L2A (paper bundle samoa_pv_detections.csv)',
                'TIGER 2020 village boundaries (village_treatment_h5.csv)',
                'OSM / ESA WorldCover / Copernicus DEM (SIAI, VQI)',
                'DOE/EIA documented facilities (gen_est official_nodes.csv)'],
    'generated': date.today().isoformat(),
    'matched_villages': matched, 'total_app_villages': len(villages),
    'pv_villages': sum(1 for r in out.values() if r.get('pv_count', 0) > 0),
}

json.dump({'meta': meta, 'villages': out}, open(f'{APP}/data-real/indicators_real.json', 'w'),
          ensure_ascii=False, indent=1)
print('MATCHED:', matched, '/', len(villages))
print('PV-bearing villages:', meta['pv_villages'], '| PV MW assigned:',
      round(sum(r.get('pv_mw', 0) for r in out.values()), 2))
print('official assets attached:', sum(1 for r in out.values() if r.get('official_asset')))
print('sample Pava\'ia\'i:', json.dumps(out.get(norm("Pava'ia'i")), ensure_ascii=False)[:220])
print('sample Pago Pago:', json.dumps(out.get(norm('Pago Pago')), ensure_ascii=False)[:220])
