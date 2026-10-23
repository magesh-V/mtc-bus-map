#!/usr/bin/env python3
"""Every CMRL Metro train of the day, for the map's timetable layer (web/trains.js).

    build_metro_trains.py GTFS_DIR metro_trains.json

GTFS_DIR is gtfs_clean/cmrl (or the published data/chennai-one/cmrl). Nobody
publishes live train positions in Chennai — not CMRL, not CUMTA, not the GTFS
mirrors — so the map draws each train where its timetable puts it, and says so.

Each trip is reduced to knots the browser interpolates between: at every
station, the arrival and departure time (seconds after midnight, past 86400 for
after-midnight runs) and the distance along the trip's own shape. Stations are
projected onto the shape in order, searching WINDOW vertices ahead of the
previous one (the rest of the shape only if that misses by more than 80 m), so
a shape that comes back along itself cannot pull a station onto its return leg.
Trips that share a shape and a stop sequence share the projection.

Each trip carries its service's weekday pattern from calendar.txt, so a
Sunday-only train is not drawn on a weekday (calendar_dates.txt exceptions are
not applied). A trip with a blank time or a stop missing from stops.txt is left
out and counted, rather than stopping refresh.sh.

Output:
  {"v": feed_version, "lines": [...], "heads": [...], "stations": [...],
   "spos": [[lon, lat], ...]   (per station, the mean of its platforms)
   "days": ["1111111", ...]    (Monday..Sunday patterns)
   "shapes": [[[lon, lat], ...], ...],
   "trips": [[shape, line, head, [station, arr, dep, metres, station, arr, ...], days], ...]}
"""
import csv
import json
import math
import os
import sys
from collections import defaultdict

K = 111320
WINDOW = 400
WEEK = ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')


def rows(d, name):
    with open(os.path.join(d, name), newline='', encoding='utf-8-sig') as fh:
        return list(csv.DictReader(fh))


def secs(hms):
    """'25:04:10' -> 90250; None for a blank or malformed time."""
    try:
        h, m, s = (int(x) for x in hms.strip().split(':'))
    except (AttributeError, ValueError):
        return None
    return h * 3600 + m * 60 + s


def project(xy, cum, px, py, i0, i1):
    """(offset m, segment, metres along) of the nearest point on segments [i0, i1)."""
    best = None
    for i in range(i0, min(i1, len(xy) - 1)):
        (ax, ay), (bx, by) = xy[i], xy[i + 1]
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        u = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L)) if L else 0.0
        off = math.hypot(ax + u * dx - px, ay + u * dy - py)
        if best is None or off < best[0]:
            best = (off, i, cum[i] + u * math.sqrt(L))
    return best


def main():
    src, out = sys.argv[1:3]
    stops = {r['stop_id']: r for r in rows(src, 'stops.txt')}
    trips = {r['trip_id']: r for r in rows(src, 'trips.txt')}
    try:
        version = rows(src, 'feed_info.txt')[0].get('feed_version', '')
    except (OSError, IndexError):
        version = ''
    try:
        week = {r['service_id']: ''.join('1' if r.get(d, '0').strip() == '1' else '0' for d in WEEK) for r in rows(src, 'calendar.txt')}
    except OSError:
        week = {}

    pts = defaultdict(list)
    for r in rows(src, 'shapes.txt'):
        pts[r['shape_id']].append((int(r['shape_pt_sequence']), float(r['shape_pt_lon']), float(r['shape_pt_lat'])))
    times = defaultdict(list)
    for r in rows(src, 'stop_times.txt'):
        arr, dep = secs(r.get('arrival_time', '')), secs(r.get('departure_time', ''))
        times[r['trip_id']].append((int(r['stop_sequence']), r['stop_id'], arr if arr is not None else dep, dep if dep is not None else arr))

    def idx(lst, ix, v):
        if v not in ix:
            ix[v] = len(lst)
            lst.append(v)
        return ix[v]

    lines, heads, stations, shapes, days = [], [], [], [], []
    li, hi, si, shi, di = {}, {}, {}, {}, {}
    geo, proj = {}, {}
    spos = defaultdict(lambda: [0.0, 0.0, 0])
    out_trips, far, bad = [], 0, 0
    for tid, st in times.items():
        t = trips.get(tid)
        if not t or t['shape_id'] not in pts or len(st) < 2:
            continue
        st = sorted(st)
        if any(arr is None or stop_id not in stops for _, stop_id, arr, _ in st):
            bad += 1
            continue
        sid = t['shape_id']
        if sid not in geo:
            p = [(lon, lat) for _, lon, lat in sorted(pts[sid])]
            cx = math.cos(math.radians(p[0][1])) * K
            xy = [(lon * cx, lat * K) for lon, lat in p]
            cum = [0.0]
            for a, b in zip(xy, xy[1:]):
                cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
            geo[sid] = (xy, cum, cx)
            shi[sid] = len(shapes)
            shapes.append([[round(lon, 5), round(lat, 5)] for lon, lat in p])
        xy, cum, cx = geo[sid]
        key = (sid, tuple(stop_id for _, stop_id, _, _ in st))
        if key not in proj:                       # trips on the same shape and stops land the same way
            ds, seg, prev = [], 0, 0.0
            for _, stop_id, _, _ in st:
                s = stops[stop_id]
                px, py = float(s['stop_lon']) * cx, float(s['stop_lat']) * K
                best = project(xy, cum, px, py, seg, seg + WINDOW)
                if best[0] > 80:                  # missed the window: the rest of the shape, still never behind
                    rest = project(xy, cum, px, py, seg, len(xy))
                    if rest[0] < best[0] - 40:
                        best = rest
                off, seg, d = best
                far += off > 300
                prev = max(prev, d)
                ds.append(prev)
            proj[key] = ds
        knots = []
        for (_, stop_id, arr, dep), d in zip(st, proj[key]):
            s = stops[stop_id]
            n = idx(stations, si, s['stop_name'].strip())
            knots += [n, arr, dep, round(d)]
            sp = spos[n]
            sp[0] += float(s['stop_lon']); sp[1] += float(s['stop_lat']); sp[2] += 1
        out_trips.append([shi[sid], idx(lines, li, t['route_id']), idx(heads, hi, (t.get('trip_headsign') or '').strip()), knots,
                          idx(days, di, week.get(t.get('service_id'), '1111111'))])

    out_trips.sort(key=lambda r: r[3][2])            # by first departure
    pos = [[round(spos[n][0] / spos[n][2], 5), round(spos[n][1] / spos[n][2], 5)] for n in range(len(stations))]
    with open(out + '.tmp', 'w') as fh:
        json.dump({'v': version, 'lines': lines, 'heads': heads, 'stations': stations, 'spos': pos, 'days': days,
                   'shapes': shapes, 'trips': out_trips}, fh, separators=(',', ':'))
    os.replace(out + '.tmp', out)
    print(f'{len(out_trips)} trains on {len(shapes)} shapes -> {out} '
          f'({os.path.getsize(out) / 1024:.0f} KB; {far} station fixes >300 m off their shape; '
          f'{bad} trips left out for a blank time or unknown stop; service days {days})')


if __name__ == '__main__':
    main()
