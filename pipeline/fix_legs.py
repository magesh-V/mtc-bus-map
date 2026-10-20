#!/usr/bin/env python3
"""Replace grossly over-long legs with the operator's own path.

    CHENNAI_ONE_HARVEST=... CHENNAI_ONE_SNAPSHOT=... python3 fix_legs.py --from snap_cache_guided --to snap_cache_fixed

After snap_guided.py, a few legs still loop: where a stop sits on the far
carriageway of a divided road, OSRM drives past, turns round and comes back
(121A Arul Nagar -> Madhavaram Post Box: 1.7 km for 575 m). Where both stops of
a leg lie within LEG_OFF_M of the operator path and our leg is more than
RATIO times that path and at least EXTRA_M longer, the leg is replaced by the
operator path between the two stops — it follows the roads (15 m median from
our snapped lines where both exist). Every other leg is kept as routed.
"""
import argparse
import json
import math
import os
import sys
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

from shapely.geometry import LineString, Point
from shapely.ops import substring, transform
import pyproj

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import snap_routes as sr  # noqa: E402

TO_M = pyproj.Transformer.from_crs(4326, 32644, always_xy=True).transform
TO_LL = pyproj.Transformer.from_crs(32644, 4326, always_xy=True).transform
LEG_OFF_M, RATIO, EXTRA_M, MIN_W = 60, 1.4, 300, 100

ap = argparse.ArgumentParser()
ap.add_argument('--from', dest='src', required=True)
ap.add_argument('--to', dest='dst', required=True)
ap.add_argument('--osrm', default='https://router.project-osrm.org')
ap.add_argument('--workers', type=int, default=3)
a = ap.parse_args()


def heading(W, d):
    p, q = W.interpolate(max(0, d - 25)), W.interpolate(min(W.length, d + 25))
    return (math.degrees(math.atan2(q.x - p.x, q.y - p.y)) + 360) % 360


def road_leg(W, d0, d1):
    """The operator path between d0 and d1, routed onto the roads: dense vias
    along it, each held to the path's heading, so OSRM can only follow it."""
    ks = [d0] + [d0 + k for k in range(150, int(d1 - d0) - 60, 150)] + [d1]
    pts = []
    for k in ks:
        x, y = W.interpolate(k).coords[0]
        lon, lat = TO_LL(x, y)
        pts.append((lon, lat, heading(W, k)))
    out = []
    for i in range(0, len(pts) - 1, 59):
        c = pts[i:i + 60]
        url = (f"{a.osrm}/route/v1/driving/" + urllib.parse.quote(';'.join(f'{x:.6f},{y:.6f}' for x, y, _ in c), safe=',;')
               + '?geometries=geojson&overview=full&radiuses=' + ';'.join(['35'] * len(c))
               + '&bearings=' + ';'.join(f'{round(h)},40' for _, _, h in c))
        d = sr.fetch(url)
        if not d or d.get('code') != 'Ok':
            return None
        g = d['routes'][0]['geometry']['coordinates']
        out.extend(g[1:] if out and out[-1] == g[0] else g)
    return out
os.makedirs(a.dst, exist_ok=True)
fixed_legs = fixed_routes = 0
saved = 0.0
raw, routed = [0], [0]


def one(r):
    global fixed_legs, fixed_routes, saved
    code, stops = r['code'], r['stops']
    g = json.load(open(os.path.join(a.src, code + '.json')))
    try:
        wps = json.load(open(os.path.join(sr.HARVEST, f'BUS_{code}.json'))).get('waypoints') or []
    except Exception:
        wps = []
    legs = g.get('legs') or []
    if len(wps) > 2 and len(legs) == len(stops) - 1:
        W = transform(TO_M, LineString([(p['lon'], p['lat']) for p in wps]))
        pr = []
        for s in stops:
            p = transform(TO_M, Point(s['lon'], s['lat']))
            d = W.project(p)
            pr.append((d, W.interpolate(d).distance(p)))
        changed = False
        for i, leg in enumerate(legs):
            (d0, o0), (d1, o1) = pr[i], pr[i + 1]
            lw = d1 - d0
            if o0 > LEG_OFF_M or o1 > LEG_OFF_M or lw < MIN_W or len(leg) < 2:
                continue
            lg = transform(TO_M, LineString(leg)).length
            if lg > RATIO * lw and lg - lw > EXTRA_M:
                new = road_leg(W, d0, d1)
                if not new or transform(TO_M, LineString(new)).length > 1.15 * lw:
                    piece = transform(TO_LL, substring(W, d0, d1))
                    new = [[round(x, 6), round(y, 6)] for x, y in piece.coords]
                    raw[0] += 1
                else:
                    routed[0] += 1
                # keep the seams: start and end where the neighbouring legs do
                new[0], new[-1] = leg[0], leg[-1]
                legs[i] = new
                fixed_legs += 1; saved += lg - lw; changed = True
        if changed:
            coords = []
            for leg in legs:
                coords.extend(leg[1:] if coords and coords[-1] == leg[0] else leg)
            g['coords'], g['legs'] = coords, legs
            fixed_routes += 1
    json.dump(g, open(os.path.join(a.dst, code + '.json'), 'w'), separators=(',', ':'))


with ThreadPoolExecutor(a.workers) as ex:
    list(ex.map(one, sr.load_routes()))
print(f'{fixed_legs} legs on {fixed_routes} routes re-laid on the operator path '
      f'({routed[0]} routed on roads, {raw[0]} as the path itself), {saved / 1000:.0f} km of loops removed')
