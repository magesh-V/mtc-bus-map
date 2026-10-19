#!/usr/bin/env python3
"""Observed bus speeds per road segment, from the collector's speed samples.

    live_speeds.py --stops route_stops.json --archive DIR --out speeds.json [--days 7]

Each sample is one bus covering stops i0..i1 of its route between two GPS fixes.
Its speed is credited to every stop-to-stop segment in that span, keyed by the
physical stop pair ("fromStopCode|toStopCode"), so all routes sharing a road
pool their buses. Medians, not means: one bus held at a depot gate must not
make a whole corridor look jammed.

Output:
  {"t": epoch, "days": n, "now_min": 60,
   "city": {"now": km/h, "h": [24 hourly medians]},
   "s": {"a|b": [now km/h or -1, buses now, h0..h23 km/h or -1]}}
Hours are IST. Segments with fewer than 3 samples in an hour leave that hour -1.
Also gzips archive days older than today.
"""
import argparse
import datetime as dt
import glob
import gzip
import json
import os
import shutil
import statistics
import time
from collections import defaultdict

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
MAX_SPAN = 20          # samples spanning more segments than this are too smeared to place


def read(path):
    op = gzip.open if path.endswith('.gz') else open
    with op(path, 'rt') as fh:
        for line in fh:
            try:
                yield json.loads(line)
            except ValueError:
                continue                    # a line cut short by a concurrent write


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stops', required=True)
    ap.add_argument('--archive', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--days', type=int, default=7)
    a = ap.parse_args()
    codes = {c: [s[0] for s in r['d'][0]['s']] for c, r in json.load(open(a.stops)).items()}
    today = dt.datetime.now(IST).date()

    # compress finished days (the collector only appends to today's files)
    for p in glob.glob(os.path.join(a.archive, '*-????-??-??.jsonl')):
        day = p.rsplit('-', 3)[-3:]
        d = dt.date(int(day[0][-4:]), int(day[1]), int(day[2][:2]))
        if d < today and not os.path.exists(p + '.gz'):
            with open(p, 'rb') as src, gzip.open(p + '.gz', 'wb') as dst:
                shutil.copyfileobj(src, dst)
            os.remove(p)

    now = time.time()
    hours = defaultdict(lambda: defaultdict(list))   # seg -> hour -> speeds
    recent = defaultdict(list)
    city_h, city_now = defaultdict(list), []
    for n in range(a.days + 1):
        day = (today - dt.timedelta(days=n)).isoformat()
        for p in (os.path.join(a.archive, f'speed-{day}.jsonl'), os.path.join(a.archive, f'speed-{day}.jsonl.gz')):
            if not os.path.exists(p):
                continue
            for r in read(p):
                st = codes.get(r['r'])
                if not st or r['i1'] - r['i0'] > MAX_SPAN:
                    continue
                h = dt.datetime.fromtimestamp(r['t'], IST).hour
                fresh = now - r['t'] <= 3600
                city_h[h].append(r['v'])
                if fresh:
                    city_now.append(r['v'])
                for i in range(r['i0'], min(r['i1'], len(st) - 2) + 1):
                    k = f'{st[i]}|{st[i + 1]}'
                    hours[k][h].append(r['v'])
                    if fresh:
                        recent[k].append(r['v'])

    med = lambda xs: round(statistics.median(xs), 1)
    out = {}
    for k, hh in hours.items():
        row = [med(recent[k]) if recent.get(k) else -1, len(recent.get(k, []))]
        row += [med(hh[h]) if len(hh.get(h, [])) >= 3 else -1 for h in range(24)]
        if row[0] != -1 or any(x != -1 for x in row[2:]):
            out[k] = row
    res = {'t': int(now), 'days': a.days, 'now_min': 60,
           'city': {'now': med(city_now) if city_now else None,
                    'h': [med(city_h[h]) if city_h.get(h) else None for h in range(24)]},
           's': out}
    tmp = a.out + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(res, fh, separators=(',', ':'))
    os.replace(tmp, a.out)
    print(f'{len(out)} segments, {len(city_now)} samples in the last hour, city median {res["city"]["now"]} km/h')


if __name__ == '__main__':
    main()
