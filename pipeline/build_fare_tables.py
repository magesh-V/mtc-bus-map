#!/usr/bin/env python3
"""Fare tables from the Chennai One fare harvest (v36/fare_harvest.py).

    CHENNAI_ONE_HARVEST=harvest_20261017 CHENNAI_ONE_SNAPSHOT=pt_data_20261017.json \
    python3 build_fare_tables.py --out fares_out FARES.jsonl [FARES.jsonl ...]

Stop ids are the deduplicated GTFS stop_ids of gtfs_clean/{mtc,cmrl,suburban}
(the same clustering build_gtfs_clean.py uses), so the tables join to the feeds.

mtc_fare_stages.csv
    One row per stop of each harvested MTC working: its fare stage counted from
    the working's first stop, and the fare from the first stop in every class.
    Every MTC class is a fixed function of that stage s (verified on every
    quote harvested; see README):
        Ordinary, Small Bus Ordinary   4 + s
        Express, Small Bus Express     floor(1.5 x Ordinary)
        Deluxe                         2 x Ordinary + 1
        AC                             slab of Ordinary: 5-6 -> 15, 7-9 -> 20,
                                       10-12 -> 30, 13-16 -> 40, 17-18 -> 50,
                                       19-20 -> 60, 21+ -> 60/70
cmrl_fares.csv        every station pair: adult fare and the in-app (QR) price
suburban_fares.csv    every station pair served: fare per class and category
"""
import argparse
import collections
import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_gtfs_clean as bg  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('fares', nargs='+')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    rows = collections.defaultdict(dict)          # vt -> (route, from, to) -> record (last wins)
    for p in a.fares:
        for line in open(p):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get('q'):
                rows[r['vt']][(r['route'], r['from'], r['to'])] = r

    # stop code -> GTFS stop_id, exactly as the feeds were built
    place = {}
    for vt in ('BUS', 'METRO', 'SUBWAY'):
        routes = bg.load_mode(vt)
        code2place, places = bg.canonical_stops(routes)
        place[vt] = (code2place, places, {r['code']: r for r in routes})

    # ── MTC: stage per stop, from the first-stop fares ──
    code2place, places, routes = place['BUS']
    out = []
    by_route = collections.defaultdict(dict)
    for (route, s0, s1), r in rows['BUS'].items():
        q = {t: p for t, _n, p, _c in r['q']}
        if 'ORDINARY' in q:
            by_route[route][s1] = (q['ORDINARY'] - 4, q)
    covered = 0
    for route, got in sorted(by_route.items(), key=lambda kv: kv[0]):
        w = routes.get(route)
        if not w:
            continue
        stops = w['stops']
        if not stops or stops[0]['code'] in got:
            pass
        covered += 1
        for i, s in enumerate(stops):
            if i == 0:
                stage, q = 0, {}
            elif s['code'] in got:
                stage, q = got[s['code']]
            else:
                continue                                   # stop dropped from the plan (rare)
            pid = code2place.get(s['code'])
            out.append([w['sn'], route, i, pid, places[pid]['name'] if pid else s.get('name'), stage,
                        q.get('ORDINARY', ''), q.get('EXPRESS', ''), q.get('EXECUTIVE', ''), q.get('AC', '')])
    # pairs that do not start at a working's first stop: measured, not derivable
    # from the stage table (only about half equal the stage difference)
    mid = []
    for (route, s0, s1), r in rows['BUS'].items():
        w = routes.get(route)
        if not w or not w['stops'] or w['stops'][0]['code'] == s0:
            continue
        q = {t: p for t, _n, p, _c in r['q']}
        a_, b_ = code2place.get(s0), code2place.get(s1)
        mid.append([w['sn'], route, a_, places[a_]['name'] if a_ else '', b_, places[b_]['name'] if b_ else '',
                    q.get('ORDINARY', ''), q.get('EXPRESS', ''), q.get('EXECUTIVE', ''), q.get('AC', '')])
    with open(os.path.join(a.out, 'mtc_fare_pairs_midroute.csv'), 'w', newline='') as fh:
        w_ = csv.writer(fh)
        w_.writerow(['route_id', 'working_code', 'from_stop_id', 'from_name', 'to_stop_id', 'to_name',
                     'fare_ordinary', 'fare_express', 'fare_deluxe', 'fare_ac'])
        w_.writerows(sorted(mid))
    print(f'mtc_fare_pairs_midroute.csv: {len(mid)} pairs')
    with open(os.path.join(a.out, 'mtc_fare_stages.csv'), 'w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['route_id', 'working_code', 'stop_sequence', 'stop_id', 'stop_name', 'fare_stage',
                    'fare_ordinary', 'fare_express', 'fare_deluxe', 'fare_ac'])
        w.writerows(out)
    print(f'mtc_fare_stages.csv: {covered} workings, {len(out)} stops')

    # ── CMRL and suburban: origin-destination ──
    for vt, name in (('METRO', 'cmrl_fares.csv'), ('SUBWAY', 'suburban_fares.csv')):
        code2place, places, _ = place[vt]
        seen, res = set(), []
        classes = sorted({(t, n) for r in rows[vt].values() for t, n, _p, _c in r['q']})
        cats = sorted({c for r in rows[vt].values() for _t, _n, _p, cs in r['q'] for c in cs})
        for (_route, s0, s1), r in rows[vt].items():
            a_, b_ = code2place.get(s0), code2place.get(s1)
            if not a_ or not b_ or (a_, b_) in seen:
                continue
            seen.add((a_, b_))
            q = {(t, n): (p, cs) for t, n, p, cs in r['q']}
            row = [a_, places[a_]['name'], b_, places[b_]['name']]
            for k in classes:
                p, cs = q.get(k, ('', {}))
                row += [p] + [cs.get(c, '') for c in cats]
            res.append(row)
        hdr = ['from_stop_id', 'from_name', 'to_stop_id', 'to_name']
        for t, n in classes:
            tag = (n or t).lower().replace(' ', '_')
            hdr += [f'{tag}_app_price'] + [f'{tag}_{c.lower()}' for c in cats]
        # rail fares are the same both ways; the app prices some pairs in one
        # direction only (whichever way the route lists them), so fill the other
        for row in list(res):
            if (row[2], row[0]) not in seen:
                seen.add((row[2], row[0]))
                res.append([row[2], row[3], row[0], row[1]] + row[4:])
        res.sort(key=lambda x: (x[1], x[3]))
        with open(os.path.join(a.out, name), 'w', newline='') as fh:
            w = csv.writer(fh)
            w.writerow(hdr)
            w.writerows(res)
        print(f'{name}: {len(res)} station pairs, classes {classes}, categories {cats}')


if __name__ == '__main__':
    main()
