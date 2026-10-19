#!/usr/bin/env python3
"""Build the point layers the v2 MTC map draws, deduplicated by location.

The enriched layers were assembled per route, so every station appeared once for
each route touching it: metro_stations held 17,400 features for 157 real
stations (Washermenpet 465 times), bus_termini 10,328 for 1,309 locations
(Chennai Beach 528 times). That is what forced the map to cap terminus pins at
120 per viewport — it was drawing the same handful of places hundreds of times.

Deduping by rounded coordinate collapses them and keeps the route list per
place, which is what the popover wants to show anyway.

    python3 build_map_layers.py [--out DIR]
"""
from __future__ import annotations

import argparse
import json
import os
import math
import re
from collections import OrderedDict, Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
HARVEST = os.path.join(HERE, os.environ.get('CHENNAI_ONE_HARVEST', 'harvest'), 'routes')
SNAPSHOT = os.path.join(HERE, os.environ.get('CHENNAI_ONE_SNAPSHOT', 'pt_data.json'))
DEFAULT_OUT = '/Users/admin/Desktop/projects/maps-site-congestion/routesv2/data'

# One physical stop appears many times in the feed under slightly different
# coordinates and near-identical names. Kilambakkam terminus alone has 12 records
# spread over ~110 m — "KILAMBAKKAM BUS TERMINUS", "KCBT - KILAMBAKKAM", a
# "- return" variant of each, and `prm_`-prefixed parent-stop copies. Rounding
# coordinates (the old approach) cannot merge points 110 m apart, so four pins
# stacked on one terminus, all listing the same buses.
#
# Cluster instead: same normalised name AND within this radius. Requiring the
# name to match keeps genuinely separate stops apart; 1,885 names have every
# copy inside 200 m, while 369 names repeat over 2 km away and are different
# places (or mis-geocodes) that must NOT be merged.
CLUSTER_M = 200
# Second pass for the same place spelled two different ways. "KCBT - KILAMBAKKAM"
# and "KILAMBAKKAM BUS TERMINUS" sit 25 m apart and are one terminus, but no
# name normalisation joins an abbreviation to its expansion. Merge very close
# stops that share a distinctive word instead — that catches this without
# collapsing unrelated stops that merely happen to be neighbours.
SAME_PLACE_M = 75
# Stops sharing a coordinate to within this are one pin on screen — whichever is
# drawn second is unclickable — so merge regardless of name and keep the other
# names as `alt`. Some are the same place spelled differently ("FORD" /
# "MARAIMALAI NAGAR FORD", "ARUNODAYAM NAGAR" / "ARUNODHAYA NAGAR"); others are
# distinct stops the feed geocoded to one point. Both are better as one pin
# listing every route and every name than as pins hidden under each other.
STACKED_M = 5
STOPWORDS = {'BUS', 'TERMINUS', 'STAND', 'STOP', 'ROAD', 'NAGAR', 'STATION', 'JN',
             'JUNCTION', 'TERMINAL', 'DEPOT', 'GATE', 'WEST', 'EAST', 'NORTH', 'SOUTH',
             'NEW', 'OLD', 'MAIN', 'CROSS', 'THE', 'AND', 'RETURN', 'METRO'}


def tokens(name: str):
    return {w for w in norm_name(name).split() if len(w) >= 5 and w not in STOPWORDS}


def norm_name(n: str) -> str:
    n = (n or '').upper()
    n = re.sub(r'\s*-\s*RETURN$', '', n)      # directional copy of the same stop
    n = re.sub(r'[^A-Z0-9 ]', ' ', n)
    return ' '.join(n.split())


def hav(a, b) -> float:
    r = 6371000.0
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dp, dl = p2 - p1, math.radians(b[0] - a[0])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def cluster(points):
    """Single-linkage clustering within CLUSTER_M. points: [(lonlat, payload)]."""
    n = len(points)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n):
        for j in range(i + 1, n):
            if hav(points[i][0], points[j][0]) <= CLUSTER_M:
                a, b = find(i), find(j)
                if a != b:
                    parent[a] = b
    groups = defaultdict(list)
    for i in range(n):
        groups[find(i)].append(points[i])
    return list(groups.values())




def bus_routes():
    """Same stop cleaning as snap_routes.py so the card and the line agree."""
    import snap_routes as sr
    return sr.load_routes()


def collect(vt: str):
    """Every stop of every route of one vehicle type, keyed by position."""
    pt = json.load(open(SNAPSHOT))
    places: OrderedDict = OrderedDict()
    for r in pt['rs']:
        if r['vt'] != vt:
            continue
        f = os.path.join(HARVEST, f"{vt}_{r['cd']}.json")
        if not os.path.exists(f) or os.path.getsize(f) < 5:
            continue
        try:
            stops = json.load(open(f)).get('stops') or []
        except Exception:
            continue
        sn = (r.get('sN') or r['cd']).strip()
        # CMRL's Phase-2 construction stations carry placeholder names and real
        # coordinates; they are not places anyone can board
        import snap_routes as _sr
        stops = [x for x in stops if not _sr.is_placeholder(x)]
        for i, s in enumerate(stops):
            if not (s.get('lat') and s.get('lon')):
                continue
            key = s.get('code') or (round(s['lon'], 5), round(s['lat'], 5))
            p = places.setdefault(key, {'name': s.get('name'), 'lonlat': (s['lon'], s['lat']),
                                        'names': Counter(), 'routes': set(), 'terminus': False})
            p['names'][s.get('name') or ''] += 1
            p['routes'].add(sn)
            if i == 0 or i == len(stops) - 1:
                p['terminus'] = True          # an endpoint of at least one route

    # collapse the many records of one physical stop into a single place
    by_name = defaultdict(list)
    for p in places.values():
        by_name[norm_name(p['name'])].append((p['lonlat'], p))
    merged = OrderedDict()
    for _, pts in by_name.items():
        for group in cluster(pts):
            names, routes, term = Counter(), set(), False
            lon = sum(g[0][0] for g in group) / len(group)
            lat = sum(g[0][1] for g in group) / len(group)
            for _, p in group:
                names += p['names']
                routes |= p['routes']
                term = term or p['terminus']
            # prefer the spelling the feed uses most, and never the "- return" one
            best = sorted(names.items(), key=lambda kv: (-kv[1], kv[0].upper().endswith('- RETURN'), len(kv[0])))[0][0]
            merged[(round(lon, 6), round(lat, 6))] = {
                'name': re.sub(r'\s*-\s*[Rr]eturn$', '', best).strip(),
                'routes': routes, 'terminus': term, 'merged': len(group),
                'names': names}

    # second pass: same place, different spelling
    items = list(merged.items())
    grid = defaultdict(list)
    for idx, (ll, _) in enumerate(items):
        grid[(round(ll[0], 3), round(ll[1], 3))].append(idx)   # ~100 m cells
    parent = list(range(len(items)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for (cx, cy), idxs in grid.items():
        near = []
        for dx in (-0.001, 0, 0.001):
            for dy in (-0.001, 0, 0.001):
                near += grid.get((round(cx + dx, 3), round(cy + dy, 3)), [])
        for i in idxs:
            for j in near:
                if j <= i:
                    continue
                dm = hav(items[i][0], items[j][0])
                if dm > SAME_PLACE_M:
                    continue
                if dm <= STACKED_M or (tokens(items[i][1]['name']) & tokens(items[j][1]['name'])):
                    a, b = find(i), find(j)
                    if a != b:
                        parent[a] = b
    groups = defaultdict(list)
    for i in range(len(items)):
        groups[find(i)].append(i)
    out = OrderedDict()
    for members in groups.values():
        names, routes, term = Counter(), set(), False
        lon = sum(items[i][0][0] for i in members) / len(members)
        lat = sum(items[i][0][1] for i in members) / len(members)
        for i in members:
            p = items[i][1]
            names += p['names']
            routes |= p['routes']
            term = term or p['terminus']
        best = sorted(names.items(), key=lambda kv: (-kv[1], kv[0].upper().endswith('- RETURN'), len(kv[0])))[0][0]
        primary = re.sub(r'\s*-\s*[Rr]eturn$', '', best).strip()
        alt = sorted({re.sub(r'\s*-\s*[Rr]eturn$', '', n).strip() for n in names} - {primary})
        out[(round(lon, 6), round(lat, 6))] = {
            'name': primary, 'alt': alt, 'routes': routes, 'terminus': term}
    return out


def fc(features):
    return {'type': 'FeatureCollection', 'features': features}


def point(lonlat, props):
    return {'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [lonlat[0], lonlat[1]]},
            'properties': props}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=DEFAULT_OUT)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    bus = collect('BUS')
    # Property names match what routesv2/app.js already reads, so this is a
    # drop-in replacement rather than a rename across the app.
    stops_f, termini_f = [], []
    for ll, p in bus.items():
        routes = sorted(p['routes'])
        common = {'Stop Name': p['name'], 'route name': ', '.join(routes),
                  'nroutes': len(routes)}
        if p.get('alt'):
            common['alt'] = ', '.join(p['alt'][:6])
        stops_f.append(point(ll, common))
        if p['terminus']:
            termini_f.append(point(ll, {'Name of th': p['name'], 'Stop Name': p['name'],
                                        'route_name': ', '.join(routes),
                                        'nroutes': len(routes), 'Ownership': 'MTC'}))

    rail = OrderedDict()
    for vt, label in (('METRO', 'Metro'), ('SUBWAY', 'Suburban')):
        for ll, p in collect(vt).items():
            e = rail.setdefault(ll, {'name': p['name'], 'lines': set(), 'routes': set()})
            e['lines'].add(label)
            e['routes'] |= p['routes']
    rail_f = [point(ll, {'name': e['name'], 'line': '/'.join(sorted(e['lines'])),
                         'nroutes': len(e['routes'])}) for ll, e in rail.items()]

    out = {'bus_stops.geojson': fc(stops_f),
           'bus_termini.geojson': fc(termini_f),
           'metro_stations.geojson': fc(rail_f)}
    for name, obj in out.items():
        path = os.path.join(a.out, name)
        tmp = path + '.tmp'
        with open(tmp, 'w') as fh:
            json.dump(obj, fh, separators=(',', ':'))
        os.replace(tmp, path)
        print(f'{name}: {len(obj["features"])} features · {os.path.getsize(path)/1048576:.2f} MB')

    # route_stops.json — keyed by ROUTE CODE, not by display name.
    #
    # It used to be keyed by the display name that build_explorer_data.py
    # invented, while mtc_routes.geojson carries the one snap_routes.py invents.
    # The two numbering schemes drifted the moment the geojson started ordering
    # variants by stop count: the card for "S100" showed a 4-stop list while its
    # line on the map had 25, and "S315SP (2)" showed "0 stops" because that key
    # did not exist at all. A code is issued upstream and belongs to exactly one
    # working, so keying on it removes the whole class of bug.
    rs = {}
    for r in bus_routes():
        stops = r['stops']
        rs[r['code']] = {'sn': r['sn'], 'd': [{
            'o': stops[0].get('name'), 'e': stops[-1].get('name'),
            's': [[s.get('code'), s.get('name'), round(s['lat'], 5), round(s['lon'], 5)] for s in stops],
        }]}
    path = os.path.join(a.out, 'route_stops.json')
    tmp = path + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(rs, fh, separators=(',', ':'))
    os.replace(tmp, path)
    print(f'route_stops.json: {len(rs)} routes keyed by code · {os.path.getsize(path)/1048576:.2f} MB')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
