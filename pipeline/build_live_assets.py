#!/usr/bin/env python3
"""Static inputs for observed bus speeds (live congestion).

    build_live_assets.py ROUTE_STOPS MTC_ROUTES OUTDIR

stop_dist.json   {code: [metres along the route of each stop in route_stops]}
                 — the collector turns two GPS fixes of one bus into distance
                 travelled along its own route, so a speed is road distance over
                 time, not a straight line.
seg_geo.json     FeatureCollection, one LineString per stop-to-stop segment
                 keyed "fromStopCode|toStopCode" (property k), cut from the
                 road-snapped route line; the map colours these by speed.

Stops are placed along the line exactly as mapsv2/live.js does (monotonic
projection), so the server and the browser agree on where a stop is.
"""
import json
import math
import sys

from shapely.geometry import LineString, Point
from shapely.ops import substring, transform
import pyproj

rs_path, routes_path, out = sys.argv[1:4]
RS = json.load(open(rs_path))
FEAT = {str(f['properties']['code']): f for f in json.load(open(routes_path))['features']}
TO = pyproj.Transformer.from_crs(4326, 32644, always_xy=True).transform
BACK = pyproj.Transformer.from_crs(32644, 4326, always_xy=True).transform

dist, segs, seen = {}, [], set()
for code, r in RS.items():
    st = r['d'][0]['s']
    f = FEAT.get(code)
    coords = None
    if f and f['geometry']:
        g = f['geometry']
        coords = [c for part in g['coordinates'] for c in part] if g['type'] == 'MultiLineString' else g['coordinates']
    if not coords or len(coords) < 2:
        coords = [[s[3], s[2]] for s in st]
    line = transform(TO, LineString(coords))
    L = line.length
    ds, prev = [], 0.0
    for s in st:
        p = transform(TO, Point(s[3], s[2]))
        # project onto the part of the line after the previous stop first, so a
        # loop or out-and-back does not snap a stop onto the wrong pass
        tail = substring(line, prev, L) if prev < L - 1 else None
        d = prev + tail.project(p) if tail is not None and tail.length > 0 else line.project(p)
        if line.interpolate(d).distance(p) > 80:
            d2 = line.project(p)
            if line.interpolate(d2).distance(p) < line.interpolate(d).distance(p) - 40:
                d = d2
        d = max(prev, d)
        ds.append(round(d))
        prev = d
    dist[code] = ds
    for i in range(len(st) - 1):
        k = f'{st[i][0]}|{st[i + 1][0]}'
        if k in seen or ds[i + 1] - ds[i] < 15:
            continue
        seen.add(k)
        piece = substring(line, ds[i], ds[i + 1])
        if piece.geom_type != 'LineString' or piece.length < 15:
            continue
        piece = transform(BACK, piece.simplify(3))
        segs.append({'type': 'Feature', 'properties': {'k': k, 'm': round(ds[i + 1] - ds[i])},
                     'geometry': {'type': 'LineString', 'coordinates': [[round(x, 5), round(y, 5)] for x, y in piece.coords]}})

json.dump(dist, open(f'{out}/stop_dist.json', 'w'), separators=(',', ':'))
json.dump({'type': 'FeatureCollection', 'features': segs}, open(f'{out}/seg_geo.json', 'w'), separators=(',', ':'))
print(f'{len(dist)} routes, {len(segs)} segments')
