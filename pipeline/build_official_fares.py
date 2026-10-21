#!/usr/bin/env python3
"""MTC's own stage fare table, and official fare stages for the harvested stop fares.

    build_official_fares.py mtc_official/fares_YYYYMMDD.html FARES_DIR

MTC publishes its fare matrix at https://mtcbus.tn.gov.in/Home/fares — stage-wise
fares for one adult in every service class (G.O. (Ms.) No. 48, 28 Jan 2018). This
writes it as FARES_DIR/mtc_official_stage_fares.csv, and rewrites
FARES_DIR/mtc_fare_stages.csv so each stop carries its official fare stage from the
working's first stop (fare_stage_min..fare_stage_max), found by matching the stop's
quoted fares in all four classes against the table. Above stage 11 the Ordinary
fare rises ₹1 every two stages, so one fare can mean two stages; the other classes
narrow it where they differ.
"""
import csv
import html
import json
import re
import sys

src, fares_dir = sys.argv[1:3]
s = open(src, encoding='utf-8').read()
labels = re.findall(r'href="#tab(\d+)" data-toggle="tab" onclick="getservicefarenote\(\d+\);"><strong>([^<]+)</strong>', s)
starts = [(m.start(), m.group(1)) for m in re.finditer(r'class="tab-pane[^"]*" id="tab(\d+)"', s)]
end = s.find('Night Service Fare details')
body = {t: s[p: starts[i + 1][0] if i + 1 < len(starts) else end] for i, (p, t) in enumerate(starts)}
KEY = {'Ordinary Services': 'ordinary', 'Express Services': 'express', 'Deluxe Services': 'deluxe', 'Small': 'small',
       'Night services': 'night', 'E/V Deluxe Service': 'ev_deluxe', 'E/V A/C Service': 'ev_ac',
       'Chennai Ula Vintage Services': 'chennai_ula_vintage', 'Pink Services': 'pink',
       'Chennai Ula A/C Services': 'chennai_ula_ac', 'Premium Services': 'premium'}
T = {}
for tab, name in labels:
    st = [(int(a), float(b)) for a, b in re.findall(r'class="stage col-md-1">\s*(\d+)\s*<span class="rate">([\d.]+)</span>', body[tab])]
    assert [k for k, _ in st] == list(range(1, len(st) + 1)), name
    T[KEY[html.unescape(name).strip()]] = [int(f) for _, f in st]
assert set(T) == set(KEY.values()), set(KEY.values()) - set(T)
cols = list(KEY.values())
n = max(len(v) for v in T.values())
with open(f'{fares_dir}/mtc_official_stage_fares.csv', 'w', newline='') as fh:
    w = csv.writer(fh)
    w.writerow(['fare_stage'] + cols)
    for i in range(n):
        w.writerow([i + 1] + [T[c][i] if i < len(T[c]) else '' for c in cols])
json.dump({'source': 'https://mtcbus.tn.gov.in/Home/fares', 'order': 'G.O. (Ms.) No. 48, 28 Jan 2018', 'fares': T},
          open(f'{fares_dir}/mtc_official_stage_fares.json', 'w'), separators=(',', ':'))

# official stage per harvested stop: the stages whose fares match all quoted classes
cls = {'fare_ordinary': 'ordinary', 'fare_express': 'express', 'fare_deluxe': 'deluxe', 'fare_ac': 'ev_ac'}
p = f'{fares_dir}/mtc_fare_stages.csv'
rows = list(csv.DictReader(open(p)))
out, nomatch = [], 0
for r in rows:
    if 'fare_stage' in r:                          # first run: from the old fare - 4 numbering
        r.pop('fare_stage')
    lo = hi = ''
    if r['stop_sequence'] == '0':
        lo = hi = 0
    elif r['fare_ordinary']:
        ok = [i + 1 for i in range(30) if all(not r[k] or T[c][i] == int(r[k]) for k, c in cls.items())]
        if not ok:                                 # AC alone off: fall back to the non-AC classes
            ok = [i + 1 for i in range(30) if all(not r[k] or T[c][i] == int(r[k]) for k, c in cls.items() if k != 'fare_ac')]
        if ok:
            lo, hi = ok[0], ok[-1]
        else:
            nomatch += 1
    r['fare_stage_min'], r['fare_stage_max'] = lo, hi
    out.append(r)
head = ['route_id', 'working_code', 'stop_sequence', 'stop_id', 'stop_name', 'fare_stage_min', 'fare_stage_max',
        'fare_ordinary', 'fare_express', 'fare_deluxe', 'fare_ac']
with open(p, 'w', newline='') as fh:
    w = csv.DictWriter(fh, head)
    w.writeheader()
    w.writerows({k: r.get(k, '') for k in head} for r in out)
exact = sum(1 for r in out if r['fare_stage_min'] != '' and r['fare_stage_min'] == r['fare_stage_max'])
print(f'{len(T)} classes; {len(out)} stops, {exact} with one exact stage, {nomatch} not in the table')
