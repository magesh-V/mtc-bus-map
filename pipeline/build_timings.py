#!/usr/bin/env python3
"""Per-working departure times for the v2 route card.

timings.json used to be keyed by service number, so every working of 21G showed
the same block — first bus 02:00, last 23:15, 88 trips — whether it was the
50-stop Kilambakkam run or the 2-stop hop from Tondiarpet depot. The card was
answering a question about the service when the user had picked a working.

Keying on the working's own code fixes that, and makes the short workings
legible: a 2-stop working that only runs at 05:10 and 22:40 is a depot move, and
now says so instead of borrowing the parent service's all-day span.

Departures are read at the working's FIRST stop, which is where a rider boards.
Trips are attributed by trip-id prefix, the same rule the GTFS build uses — a
trip appears in the timetable of every working whose stops it passes.

    python3 build_timings.py [--out FILE]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
TIMETABLES = os.path.join(HERE, os.environ.get('CHENNAI_ONE_HARVEST', 'harvest'), 'timetables')
DEFAULT_OUT = '/Users/admin/Desktop/projects/maps-site/mapsv2/data/timings.json'
# The attribution line used to be repeated in every entry — an identical 76-char
# string 4,315 times, a third of the file — and the card now carries it instead.

# A working whose departures cluster outside the day's main service window, and
# which is short, is a depot move dressed as a revenue trip. Both halves matter:
# plenty of short workings are genuine short-turns that run all day.
DEPOT_MAX_STOPS = 8


def hhmm(sec: int) -> str:
    return f'{(sec // 3600) % 24:02d}:{(sec % 3600) // 60:02d}'


def secs(t: str) -> int:
    h, m, s = (int(x) for x in t.split(':')[:3])
    return h * 3600 + m * 60 + s


def departures(vt: str, code: str, stop_code: str, tiers=None):
    """Every departure of this working from one stop, de-duplicated by trip id.

    `tiers`, if given, collects each trip's serviceTierType once. MTC runs the
    same route number under several board types and the feed states which on
    every trip: ORDINARY and EXECUTIVE are non-AC (EXECUTIVE is the premium
    non-AC board), EXPRESS is limited-stop, AC and NON_AC say so outright, and
    SPECIAL is a special service. It is the only vehicle classification the feed
    carries — nothing anywhere says whether a bus is electric or diesel.
    """
    out = {}
    for d in ('fwd', 'rev'):
        p = os.path.join(TIMETABLES, f'{vt}_{code}_{d}_{stop_code.replace("|", "_")}.json')
        if not os.path.exists(p) or os.path.getsize(p) < 3:
            continue
        try:
            rows = (json.load(open(p)) or {}).get('timetable') or []
        except Exception:
            continue
        for r in rows:
            tid = r.get('tripId')
            t = r.get('timeOfDeparture') or r.get('timeOfArrival')
            if not tid or not t:
                continue
            # the trip belongs to the working its id names
            if re.split(r'[-_]', tid)[0] != code:
                continue
            if tiers is not None and tid not in out:
                tiers[r.get('serviceTierType') or 'ORDINARY'] += 1
            out[tid] = secs(t)
    return sorted(out.values())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--report', action='store_true',
                    help='print the short-working analysis instead of writing')
    a = ap.parse_args()

    import snap_routes as sr
    routes = sr.load_routes()

    out, rows = {}, []
    for r in routes:
        stops = r['stops']
        if len(stops) < 2:
            continue
        tiers = Counter()
        dep = departures('BUS', r['code'], stops[0].get('code') or '', tiers)
        if not dep:
            continue
        gaps = [b - a for a, b in zip(dep, dep[1:]) if b > a]
        # median gap, not mean: one 6-hour midday break would otherwise report a
        # 90-minute headway on a route that runs every 10 minutes
        head = round(statistics.median(gaps) / 60) if gaps else None
        hours = Counter(t // 3600 for t in dep)
        out[r['code']] = {
            'sn': r['sn'], 'first': hhmm(dep[0]), 'last': hhmm(dep[-1]),
            'freq': f'every ~{head} min' if head else 'one trip a day',
            'trips': len(dep),
            # trips by board type, each trip counted once
            'tiers': dict(tiers.most_common()),
            # 24 counts, one per hour of departure — the card draws these
            'hours': [hours.get(h, 0) for h in range(24)],
        }
        rows.append((r['sn'], r['code'], len(stops), dep, r['ln']))

    if a.report:
        return report(rows)

    path = a.out
    tmp = path + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(out, fh, separators=(',', ':'))
    os.replace(tmp, path)
    print(f'{len(out)} workings -> {path} ({os.path.getsize(path)/1048576:.2f} MB)')
    return 0


def report(rows):
    """Do the short workings look like depot moves?"""
    by_sn = defaultdict(list)
    for sn, code, n, dep, ln in rows:
        by_sn[sn].append((code, n, dep, ln))
    short_all, long_all = [], []
    for sn, ws in by_sn.items():
        if len(ws) < 2:
            continue
        longest = max(n for _, n, _, _ in ws)
        for code, n, dep, ln in ws:
            frac_edge = sum(1 for t in dep if t < 6 * 3600 or t >= 21 * 3600) / len(dep)
            rec = (sn, code, n, len(dep), frac_edge, hhmm(dep[0]), hhmm(dep[-1]), ln)
            (short_all if (n <= DEPOT_MAX_STOPS and n < longest / 2) else long_all).append(rec)

    def summarise(name, lst):
        if not lst:
            return
        edge = statistics.median(x[4] for x in lst)
        print(f'{name}: {len(lst)} workings · median share of departures before 06:00 '
              f'or after 21:00 = {edge*100:.0f}%')
        print(f'  {sum(1 for x in lst if x[4] >= 0.8)} run ENTIRELY (>=80%) at those hours')
        print(f'  {sum(1 for x in lst if x[3] <= 2)} run at most twice a day')
    summarise('short workings (<=8 stops and under half the longest)', short_all)
    summarise('the rest', long_all)
    print('\nshort workings that run only at the edges of the day:')
    for x in sorted(short_all, key=lambda r: (-r[4], r[3]))[:18]:
        print(f'  {x[0]:9s} {x[2]:2d} stops {x[3]:4d}/day  {x[5]}–{x[6]}  '
              f'{x[4]*100:3.0f}% edge  {x[7][:46]}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
