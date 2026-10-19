#!/usr/bin/env python3
"""Road-snap every MTC bus route by routing through its stop sequence.

Replaces osrm_snap.py + stitch_routes.py, which produced 30% broken routes
(1,302 of 4,320 had a jump between consecutive vertices of up to 90 km).

Why that happened, and what is done differently here:

  osrm_snap.py snapped a route, then *sliced* the polyline into one piece per
  consecutive stop pair by finding each stop's nearest vertex, and
  stitch_routes.py concatenated those pieces back. Two things break that:

    * nearest-vertex matching is global, so on a route that runs the same
      corridor twice (loops, out-and-back), a stop matches the wrong pass and
      its slice leaps across the city;
    * `if ia > ib: ia, ib = ib, ia` silently reverses any slice that runs
      backwards along the source polyline, so the stitched line doubles back.

  Slicing and re-stitching is unnecessary: OSRM already returns one continuous
  road path through the waypoints, in order. Keep it as-is. Per-stop-pair
  geometry — which the congestion map does need — comes from the response's own
  `legs`, one per consecutive waypoint pair, so it can never disagree with the
  route line or lose direction.

Also fixes a real bug in the old script: it computed `radiuses` and never put
them in the URL, so OSRM was free to snap a stop to any road at any distance.

Outputs
  routesv2/data/mtc_routes.geojson   one LineString per route (map)
  congestion/data/seg_geo.json       {"aCode|bCode": [[lon,lat],...]} (congestion)

Resumable: progress is cached per route in snap_cache/, so a re-run costs
nothing for routes already done. Polite: a few concurrent requests, and it
backs off on failure.

    python3 snap_routes.py [--workers 3] [--limit N] [--osrm URL]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import threading
import time
import hashlib
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
# CHENNAI_ONE_HARVEST / CHENNAI_ONE_SNAPSHOT select a dated harvest (e.g. harvest_20261017)
HARVEST = os.path.join(HERE, os.environ.get('CHENNAI_ONE_HARVEST', 'harvest'), 'routes')
SNAPSHOT = os.path.join(HERE, os.environ.get('CHENNAI_ONE_SNAPSHOT', 'pt_data.json'))
CACHE = os.path.join(HERE, os.environ.get('CHENNAI_ONE_SNAP_CACHE', 'snap_cache'))
SITE = os.environ.get('CHENNAI_ONE_SITE_OUT', '/Users/admin/Desktop/projects/maps-site-congestion')
ROUTES_OUT = os.path.join(SITE, 'routesv2', 'data', 'mtc_routes.geojson')
SEG_OUT = os.path.join(SITE, 'congestion', 'data', 'seg_geo.json')

# OSRM's demo server caps waypoints per request; chunk longer routes and repeat
# one stop across the seam so the pieces join on a shared point.
CHUNK = 60
# Snap radius ladder. 100 m is right for a normal kerbside stop, but OSRM answers
# HTTP 400 (NoSegment) the moment ONE stop on the route is further than this from a
# routable road — terminals inside depots, stops on unmapped service lanes. That
# rejected 40 whole routes, which then fell back to straight lines and produced the
# very cross-city jumps this script exists to remove. So widen and retry instead;
# OSRM still picks the nearest road, just looks further for it.
SNAP_RADII = [100, 500, 2000, None]
# A gap between consecutive vertices is normal — OSRM emits no intermediate point
# along a straight road, and Chennai has 700 m straights (measured p95 = 705 m over
# a 200-route sample, nothing above 3 km). Only a city-scale leap means the path is
# actually broken; the old slice-and-restitch output had jumps up to 90 km.
JUMP_LIMIT = 2000      # m

_print_lock = threading.Lock()


def log(msg: str) -> None:
    with _print_lock:
        print(msg, flush=True)


def haversine(a, b) -> float:
    r = 6371000.0
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dp = p2 - p1
    dl = math.radians(b[0] - a[0])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def max_jump(coords) -> float:
    return max((haversine(coords[i], coords[i + 1]) for i in range(len(coords) - 1)), default=0.0)


def fetch(url: str, tries: int = 4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=40) as r:
                return json.loads(r.read().decode())
        except Exception:
            if i == tries - 1:
                return None
            time.sleep(1.5 * (i + 1))    # back off rather than hammer
    return None


def route_chunk(osrm: str, stops, radius):
    """Route through one chunk of stops. Returns (full_coords, [leg_coords…]).

    `radius` None means let OSRM snap at any distance."""
    coords = ';'.join(f"{s['lon']},{s['lat']}" for s in stops)
    url = (f"{osrm}/route/v1/driving/{urllib.parse.quote(coords, safe=',;')}"
           f"?geometries=geojson&overview=full&steps=true")
    if radius is not None:
        url += '&radiuses=' + ';'.join([str(radius)] * len(stops))
    d = fetch(url)
    if not d or d.get('code') != 'Ok' or not d.get('routes'):
        return None, None
    r = d['routes'][0]
    legs = []
    for leg in r.get('legs', []):
        pts = []
        for step in leg.get('steps', []):
            g = (step.get('geometry') or {}).get('coordinates') or []
            for p in g:
                if not pts or pts[-1] != p:
                    pts.append(p)
        legs.append(pts)
    return r['geometry']['coordinates'], legs


def snap_route(osrm: str, stops):
    """Whole route, chunked. Returns dict(coords, legs, ok) — legs align 1:1 with
    consecutive stop pairs so a leg can never belong to a different pair."""
    chunks = []
    i = 0
    while i < len(stops) - 1:
        c = stops[i:i + CHUNK]
        chunks.append((i, c))
        if i + CHUNK >= len(stops):
            break
        i += CHUNK - 1                      # overlap one stop across the seam

    for radius in SNAP_RADII:
        full, all_legs, ok = [], [], True
        for _, c in chunks:
            coords, legs = route_chunk(osrm, c, radius)
            if coords is None:
                ok = False
                break
            if full and full[-1] == coords[0]:
                full.extend(coords[1:])
            else:
                full.extend(coords)
            all_legs.extend(legs)
        if not ok or len(all_legs) != len(stops) - 1:   # a leg per gap, or retry wider
            continue
        return {'coords': full, 'legs': all_legs, 'radius': radius}
    return None


def straight(stops):
    return {'coords': [[s['lon'], s['lat']] for s in stops],
            'legs': [[[stops[i]['lon'], stops[i]['lat']],
                      [stops[i + 1]['lon'], stops[i + 1]['lat']]] for i in range(len(stops) - 1)]}


# Greater Chennai. Routes reaching past this are genuine intercity services
# (Kilambakkam-Trichy and similar), not city buses.
CHENNAI_BBOX = (12.60, 79.70, 13.55, 80.40)     # S, W, N, E
# A stop more than this from BOTH of its neighbours is in the wrong place. CUMTA's
# feed geocodes some intermediate stops by name onto a same-named place in Chennai
# — S315SP puts "PERAMBALUR" at 13.116,80.232, which is Perambur, 270 km from the
# rest of its route. That single bad point makes the line leap across the state
# and back, which is the "junk looping everywhere".
OUTLIER_M = 25000


# CMRL files its Phase-2 construction stations under placeholder names —
# "[TEST]-0417" and friends, 10 of them along the Poonamallee alignment with
# real coordinates. They are not stations anyone can board at, and they were
# turning up in the published feed and at the top of the congestion map's
# slowest-corridor list.
PLACEHOLDER = re.compile(r'\[\s*TEST\s*\]|^TEST[\s_-]*\d', re.I)


def is_placeholder(stop) -> bool:
    return bool(PLACEHOLDER.search((stop.get('name') or '').strip()))


def clean_stops(stops):
    """Drop placeholder stops, then stops that agree with neither neighbour.
    Returns (stops, n_dropped)."""
    stops = [s for s in stops if not is_placeholder(s)]
    if len(stops) < 3:
        return stops, 0
    keep, dropped = [], 0
    for i, s in enumerate(stops):
        prev = stops[i - 1] if i else None
        nxt = stops[i + 1] if i + 1 < len(stops) else None
        far = []
        for o in (prev, nxt):
            if o is not None:
                far.append(haversine([s['lon'], s['lat']], [o['lon'], o['lat']]) > OUTLIER_M)
        if far and all(far):
            dropped += 1
            continue
        keep.append(s)
    return (keep, dropped) if len(keep) >= 2 else (stops, 0)


def seq_hash(stops):
    key = ';'.join(f"{s['lon']:.6f},{s['lat']:.6f}" for s in stops)
    return hashlib.sha1(key.encode()).hexdigest()[:12]


def load_routes():
    pt = json.load(open(SNAPSHOT))
    out = []
    dropped_total = 0
    for r in pt['rs']:
        if r['vt'] != 'BUS':
            continue
        f = os.path.join(HARVEST, f"BUS_{r['cd']}.json")
        if not os.path.exists(f) or os.path.getsize(f) < 5:
            continue
        try:
            stops = json.load(open(f)).get('stops') or []
        except Exception:
            continue
        stops = [s for s in stops if s.get('lat') and s.get('lon')]
        if len(stops) < 2:
            continue
        stops, nd = clean_stops(stops)
        dropped_total += nd
        S, W, N, E = CHENNAI_BBOX
        intercity = any(not (S <= s['lat'] <= N and W <= s['lon'] <= E) for s in stops)
        out.append({'code': r['cd'], 'sn': (r.get('sN') or r['cd']).strip(),
                    'ln': r.get('lN') or '', 'stops': stops,
                    # dTC is the operator's daily trip count for this working —
                    # 18A's 16 workings run anywhere from 1 to 34 trips a day.
                    'trips': r.get('dTC') or 0,
                    'intercity': intercity, 'dropped': nd})
    if dropped_total:
        log(f'dropped {dropped_total} mis-geocoded stops across '
            f'{sum(1 for x in out if x["dropped"])} routes')
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--workers', type=int, default=3)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--osrm', default='https://router.project-osrm.org')
    a = ap.parse_args()

    os.makedirs(CACHE, exist_ok=True)
    routes = load_routes()
    if a.limit:
        routes = routes[:a.limit]
    log(f'{len(routes)} bus routes')

    def cached_ok(r):
        p = os.path.join(CACHE, r['code'] + '.json')
        if not os.path.exists(p):
            return False
        try:
            return json.load(open(p)).get('seq') == seq_hash(r['stops'])
        except Exception:
            return False

    todo = [r for r in routes if not cached_ok(r)]
    log(f'{len(routes) - len(todo)} cached, {len(todo)} to snap')

    done = [0]
    t0 = time.time()

    def work(r):
        res = snap_route(a.osrm, r['stops'])
        ok = res is not None
        if not ok:
            res = straight(r['stops'])
        res['ok'] = ok
        res['seq'] = seq_hash(r['stops'])
        json.dump(res, open(os.path.join(CACHE, r['code'] + '.json'), 'w'), separators=(',', ':'))
        with _print_lock:
            done[0] += 1
            n = done[0]
        if n % 100 == 0:
            rate = n / max(time.time() - t0, 1)
            log(f'{n}/{len(todo)} · {rate:.1f}/s · eta {(len(todo)-n)/max(rate,.01)/60:.0f}m')

    if todo:
        with ThreadPoolExecutor(max_workers=a.workers) as ex:
            list(ex.map(work, todo))

    # ── assemble ──
    # A short name covers several services: 21G alone has 9 — both directions of
    # the full run, two Tambaram West short-turns, and Broadway/Cement Road splits.
    # The map selects by name and draws every match, so emitting them all as "21G"
    # paints nine overlapping lines going opposite ways and ending at four
    # different places. Disambiguate as 21G, 21G (2), … longest first, which is
    # what the previous data did and what keeps one selection = one line.
    by_sn = {}
    for r in routes:
        by_sn.setdefault(r['sn'], []).append(r)

    def order(r):
        # The bare name goes to the fullest working, then lowest code. Verified
        # against Moovit: S100's real service is Airport Metro <-> Tambaram East
        # (27 stops there, 25 here) — ordering by code alone gave the name to a
        # 4-stop Nehru Nagar stub. 500ET is Chitlapakkam <-> Chengalpattu (65
        # stops there, 41 here), not the 17-stop Royapuram working. 21G is
        # unaffected: its 50-stop Island Ground -> Kilambakkam run is code 115.
        c = r['code']
        return (-len(r['stops']), int(c) if c.isdigit() else 10 ** 9, c)

    display = {}
    for sn, group in by_sn.items():
        group.sort(key=order)
        for i, r in enumerate(group):
            display[r['code']] = sn if i == 0 else f'{sn} ({i + 1})'

    feats, segs = [], {}
    stats = {'snapped': 0, 'straight': 0, 'broken': 0, 'intercity_excluded': 0}
    for r in routes:
        # Kilambakkam-Trichy and the like are in CUMTA's feed but are not MTC city
        # services — they are TNSTC/SETC long-distance workings, and drawing a
        # 300 km line labelled "MTC Route" through a city bus map is wrong twice
        # over. Excluded from the map; still in the harvest if ever wanted.
        if r.get('intercity'):
            stats['intercity_excluded'] += 1
            continue
        p = os.path.join(CACHE, r['code'] + '.json')
        if not os.path.exists(p):
            continue
        res = json.load(open(p))
        coords = [[round(c[0], 5), round(c[1], 5)] for c in res['coords']]
        if len(coords) < 2:
            continue
        jump = max_jump(coords)
        if not res.get('ok'):
            stats['straight'] += 1
        elif jump > JUMP_LIMIT:
            stats['broken'] += 1
        else:
            stats['snapped'] += 1
        stops = r['stops']
        feats.append({
            'type': 'Feature',
            'geometry': {'type': 'LineString', 'coordinates': coords},
            'properties': {
                'route_name': display.get(r['code'], r['sn']), 'sn': r['sn'],
                'code': r['code'], 'category': 'MTC Route', 'ln': r['ln'],
                'intercity': bool(r.get('intercity')), 'trips': r.get('trips') or 0,
                'source': stops[0].get('name'), 'destinatio': stops[-1].get('name'),
                'nstops': len(stops), 'snapped': bool(res.get('ok')),
                'max_jump_m': round(jump),
            },
        })
        for i, leg in enumerate(res['legs']):
            if len(leg) < 2:
                continue
            key = f"{stops[i]['code']}|{stops[i+1]['code']}"
            if key not in segs:
                segs[key] = [[round(c[0], 5), round(c[1], 5)] for c in leg]

    for path, obj in ((ROUTES_OUT, {'type': 'FeatureCollection', 'features': feats}), (SEG_OUT, segs)):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + '.tmp'
        with open(tmp, 'w') as fh:                 # write via temp file: the old
            json.dump(obj, fh, separators=(',', ':'))   # run left a truncated
        os.replace(tmp, path)                      # routes_full.geojson behind
        log(f'{path} · {os.path.getsize(path)/1048576:.1f} MB')

    log(f'routes: {len(feats)} · {stats}')
    log(f'segments: {len(segs)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
