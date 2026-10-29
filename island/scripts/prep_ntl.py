#!/usr/bin/env python3
# prep_ntl.py — VIIRS DNB 일별 야간광(117야 × 76마을)을 앱용 주간 시계열로 변환
# 출력: island/data-real/ntl2025.json  {weeks, territorial, series:[{name, geoid, weekly}], eventWeek, nadirDate}
import json, csv, re, math
from datetime import date, timedelta

UP = '/home/user/workspace/uploads'
APP = '/home/user/workspace/island'
norm = lambda s: re.sub(r"['’`\- ]", '', str(s or '').lower())

def num(v):
    return v if isinstance(v, (int, float)) and math.isfinite(v) else None

j = json.load(open(f'{UP}/paper/as_daily_ntl.json'))
dates = [r['date'] for r in j]
d0 = date.fromisoformat(dates[0])

def week_idx(ds):
    return (date.fromisoformat(ds) - d0).days // 7

nweeks = max(week_idx(d) for d in dates) + 1
# geoid → 앱 마을 이름 매핑 (indicators_real.json의 matched 결과 역변환)
ind = json.load(open(f'{APP}/data-real/indicators_real.json'))
geoid_to_name = {}
for app_name, rec in ind['villages'].items():
    if rec.get('geoid'):
        geoid_to_name[str(rec['geoid'])] = rec.get('matched_name') or app_name

series = {}
for g in j[0].keys():
    if g == 'date':
        continue
    daily = [num(r.get(g)) for r in j]
    weekly = []
    for w in range(nweeks):
        vals = [v for d, v in zip(dates, daily) if week_idx(d) == w and v is not None]
        weekly.append(round(sum(vals) / len(vals), 4) if vals else None)
    name = geoid_to_name.get(str(g))
    if name:
        series[name] = {'geoid': str(g), 'weekly': weekly}

# 영토 평균(마을 평균, NaN 제외) 주간
territorial = []
for w in range(nweeks):
    vals = [s['weekly'][w] for s in series.values() if s['weekly'][w] is not None]
    territorial.append(round(sum(vals) / len(vals), 4) if vals else None)

event_week = min(range(nweeks), key=lambda w: (territorial[w] if territorial[w] is not None else 9e9))
nadir_date = min(dates, key=lambda d: (lambda vals: sum(vals) / len(vals) if vals else 9e9)(
    [v for k, v in j[[r['date'] for r in j].index(d)].items() if k != 'date' and isinstance(v, (int, float)) and math.isfinite(v)]))

out = {
    'meta': {
        'source': 'VIIRS DNB nightly nighttime lights, 2025 (user research bundle as_daily_ntl.json) — weekly means of village-level radiance',
        'units': 'nW/cm²/sr', 'nights': len(dates), 'villages': len(series),
        'window': dates[0] + ' ~ ' + dates[-1], 'nadir_date': nadir_date,
        'honesty': 'Observed satellite radiance. Comparisons are descriptive, not causal.',
    },
    'weeks': ['W' + str(w + 1) for w in range(nweeks)],
    'week_start_dates': [(d0 + timedelta(days=7 * w)).isoformat() for w in range(nweeks)],
    'territorial': territorial,
    'event_week': event_week,
    'series': [{'name': n, **v} for n, v in sorted(series.items())],
}
json.dump(out, open(f'{APP}/data-real/ntl2025.json', 'w'), ensure_ascii=False, indent=0)
tv = [v for v in territorial if v is not None]
print('weeks:', nweeks, '| villages with series:', len(series), '| event_week:', event_week,
      '| nadir:', nadir_date, '| territorial min/max:', min(tv), max(tv))
