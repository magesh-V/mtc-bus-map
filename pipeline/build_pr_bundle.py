#!/usr/bin/env python3
"""Stage the cleaned Chennai One feeds into a checkout of ChennaiGTFS.

The upstream repo's own feeds and ours are not mergeable row-for-row: upstream
publishes 4,611 MTC "routes" keyed by ids from a different collection, 2,305
distinct short names (101 CT1, 101 CT11 … are separate names there), and 5,580
stops that include the duplicate records the app emits for one physical stop.
Ours are 1,087 services over 4,283 workings and 3,303 deduplicated stops. Only
1,390 stop names appear in both. Grafting our shapes onto their route ids would
be guesswork, so this stages our feeds beside theirs under data/chennai-one/
and leaves every existing file untouched.

Shape simplification: OSRM's full-overview polylines carry a vertex every few
metres, most of them collinear. Douglas-Peucker at SIMPLIFY_M keeps the road
alignment — the whole point of the contribution — while dropping the vertices
that carry no information.

    python3 build_pr_bundle.py --repo /path/to/ChennaiGTFS
"""
from __future__ import annotations

import argparse
import csv
import math
import os
import shutil
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'gtfs_clean')
MODES = ('mtc', 'cmrl', 'suburban')
FILES = ('agency.txt', 'calendar.txt', 'feed_info.txt', 'routes.txt',
         'stops.txt', 'stop_times.txt', 'trips.txt', 'shapes.txt',
         'fare_attributes.txt', 'fare_rules.txt', 'pathways.txt')

# 1 m: below the ~4 m positional accuracy of the road centrelines the routes are
# matched against, so it cannot move a line off its road.
SIMPLIFY_M = 1.0


def m_per_deg(lat: float):
    return 111320.0 * math.cos(math.radians(lat)), 110540.0


def rdp(pts, eps_m: float):
    """Douglas-Peucker on (lat, lon), distances in metres."""
    if len(pts) < 3:
        return pts
    mx, my = m_per_deg(pts[0][0])
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        ay, ax = pts[i][0] * my, pts[i][1] * mx
        by, bx = pts[j][0] * my, pts[j][1] * mx
        dx, dy = bx - ax, by - ay
        den = math.hypot(dx, dy)
        best, bi = -1.0, i
        for k in range(i + 1, j):
            py, px = pts[k][0] * my, pts[k][1] * mx
            d = (abs(dy * px - dx * py + bx * ay - by * ax) / den if den
                 else math.hypot(px - ax, py - ay))
            if d > best:
                best, bi = d, k
        if best > eps_m:
            keep[bi] = True
            stack += [(i, bi), (bi, j)]
    return [p for p, k in zip(pts, keep) if k]


def simplify_shapes(src: str, dst: str):
    """Rewrite shapes.txt through rdp, preserving shape order and resequencing."""
    kept = total = nshapes = 0
    with open(src, newline='') as fh, open(dst, 'w', newline='') as out:
        r = csv.reader(fh)
        header = next(r)
        w = csv.writer(out)
        w.writerow(header)
        cur, pts = None, []

        def flush():
            nonlocal kept, total, nshapes
            if not pts:
                return
            nshapes += 1
            total += len(pts)
            s = rdp(pts, SIMPLIFY_M)
            kept += len(s)
            for n, (lat, lon) in enumerate(s):
                w.writerow([cur, f'{lat:.6f}', f'{lon:.6f}', n])

        for row in r:
            sid, lat, lon = row[0], float(row[1]), float(row[2])
            if sid != cur:
                flush()
                cur, pts = sid, []
            pts.append((lat, lon))
        flush()
    return nshapes, total, kept


def zip_feed(d: str, path: str):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in sorted(os.listdir(d)):
            if f.endswith('.txt'):
                z.write(os.path.join(d, f), f)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True)
    a = ap.parse_args()
    base = os.path.join(a.repo, 'data', 'chennai-one')

    for m in MODES:
        s, d = os.path.join(SRC, m), os.path.join(base, m)
        os.makedirs(d, exist_ok=True)
        for f in FILES:
            sp = os.path.join(s, f)
            if not os.path.exists(sp):
                continue
            if f == 'shapes.txt':
                n, tot, kept = simplify_shapes(sp, os.path.join(d, f))
                print(f'{m}/shapes.txt: {tot:,} -> {kept:,} points over {n:,} shapes '
                      f'({100 - 100 * kept / tot:.1f}% dropped at {SIMPLIFY_M} m)')
            else:
                shutil.copyfile(sp, os.path.join(d, f))
        zp = os.path.join(a.repo, 'data', f'chennai-one-{m}-gtfs.zip')
        zip_feed(d, zp)
        print(f'{m}: {os.path.getsize(zp)/1048576:.1f} MB zip · '
              + ' · '.join(f'{f.split(".")[0]} {sum(1 for _ in open(os.path.join(d, f))) - 1:,}'
                           for f in ('routes.txt', 'trips.txt', 'stops.txt')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
