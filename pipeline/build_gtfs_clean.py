#!/usr/bin/env python3
"""Build a clean MTC GTFS feed from the Chennai One extraction.

Intended as a contribution to ungalsoththu/ChennaiGTFS, whose README lists the
gap this fills:

    "MTC shapes: Straight-line per route. Actual road paths require OSM road
     matching."

Differences from a naive export of the same source, all of which matter for a
feed people are meant to consume:

  routes = SERVICES, not workings.  The upstream feed publishes one GTFS route
  per scheduled working, so `18A` appears 16 times and `27B` 27 times. GTFS
  models that with one route and many trips; a route per working makes every
  consumer render Chennai as if it had 4,600 bus lines. Here `route_id` is the
  service number and each working becomes trips carrying `direction_id`.

  stops are deduplicated.  The feed splits one physical stop across many records
  — Kilambakkam terminus alone has 12 within ~110 m, as "KILAMBAKKAM BUS
  TERMINUS", "KCBT - KILAMBAKKAM", a "- return" copy of each, and `prm_`-prefixed
  parent copies. Stops are clustered (same name within 200 m; within 75 m sharing
  a distinctive word; within 5 m regardless) and every reference is remapped, so
  a rider's stop appears once with all its services.

  shapes are road-matched.  Geometry comes from routing each working's stop
  sequence over OSRM and keeping the returned path, validated to start and end
  within a few metres of the working's own terminals.

  service tiers are carried through.  MTC runs the same path in several classes
  and the feed says so: `serviceTierType` on each timetable row is ORDINARY,
  EXECUTIVE, EXPRESS, AC, SPECIAL or NON_AC, and 3,409 of 4,316 workings appear
  in more than one. Tier rides on the trip (where GTFS wants it), not the route.

  rail differs from bus in two ways.  Its tripIds are `<code>_T<n>` rather than
  `<code>-<tier>-<UP|DOWN>-<n>`, and the same train is listed once per travel
  class (FIRST_CLASS and SECOND_CLASS rows share a tripId), so trips are
  deduplicated across the whole mode and the classes collected onto the one trip.

  trips are counted once.  A trip surfaces in the timetable of every working
  whose stops it passes, so keying on (working, tripId) multiplied 51,998 real
  trips into 973,843 — 45,595 tripIds appeared under more than one route. The
  tripId's own prefix is the owning route code (99.98% resolve), so each trip is
  emitted once, against the working that actually operates it.

  direction comes from the operator.  `tripId` is `<route>-<tier>-<UP|DOWN>-<n>`,
  so direction_id is read rather than guessed from which terminal came first.

  mis-geocoded stops are dropped.  CUMTA geocodes some intermediate stops onto a
  same-named place in Chennai — S315SP puts PERAMBALUR at 13.116,80.232, which is
  Perambur, 270 km adrift — making the line leap across the state and back.

Runs for buses, Metro or suburban rail. The upstream repo lists three data
limitations and has no suburban feed at all; this closes all four:

    MTC shapes straight-line          -> road-matched, 2.16M points
    CMRL schedules frequency-only     -> exact times from the harvested timetables
    CMRL track geometry unavailable   -> rail routed over OSM track (snap_rail.py)
    suburban rail absent              -> 804 routes with times and geometry

Writes a standard GTFS directory; `--zip` also packages it.

    python3 build_gtfs_clean.py --vt BUS    --out gtfs_clean/mtc      --zip
    python3 build_gtfs_clean.py --vt METRO  --out gtfs_clean/cmrl     --zip
    python3 build_gtfs_clean.py --vt SUBWAY --out gtfs_clean/suburban --zip
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import zipfile
from collections import Counter, OrderedDict, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
_H = os.environ.get('CHENNAI_ONE_HARVEST', 'harvest')
HARVEST = os.path.join(HERE, _H, 'routes')
TIMETABLES = os.path.join(HERE, _H, 'timetables')
SNAPSHOT = os.path.join(HERE, os.environ.get('CHENNAI_ONE_SNAPSHOT', 'pt_data.json'))
# GTFS has no service-tier field; put it on trips, which is where a rider-facing
# distinction between an ordinary and an a/c working belongs.
TIER_ORDER = ['ORDINARY', 'EXECUTIVE', 'EXPRESS', 'AC', 'NON_AC', 'SPECIAL']
CACHE = os.path.join(HERE, os.environ.get('CHENNAI_ONE_SNAP_CACHE', 'snap_cache'))
DEFAULT_OUT = os.path.join(HERE, 'gtfs_clean')

sys.path.insert(0, HERE)
import snap_routes as sr           # noqa: E402  stop cleaning + geometry cache
import build_map_layers as bml     # noqa: E402  stop clustering rules

FEED_VERSION = os.environ.get('CHENNAI_ONE_FEED_VERSION', 'chennai-one-2026-09-01')
RAIL_SHAPES = '/Users/admin/Desktop/projects/maps-site/mapsv2/data/metro_lines.geojson'

# GTFS route_type per mode, and the operator that actually runs it
MODES = {
    'BUS':    {'agency': 'MTC',  'type': 3,
               'name': 'Metropolitan Transport Corporation (Chennai)',
               'url': 'https://mtcbus.tn.gov.in'},
    'METRO':  {'agency': 'CMRL', 'type': 1,
               'name': 'Chennai Metro Rail Limited',
               'url': 'https://chennaimetrorail.org'},
    'SUBWAY': {'agency': 'SR',   'type': 2,
               'name': 'Southern Railway (Chennai Suburban)',
               'url': 'https://sr.indianrailways.gov.in'},
}


def canonical_stops(routes):
    """Cluster every stop occurrence into physical places. Returns
    (code -> place_id, place_id -> {name, lat, lon})."""
    raw = {}
    for r in routes:
        for s in r['stops']:
            raw[s['code']] = (s['lon'], s['lat'], s.get('name') or '')

    by_name = defaultdict(list)
    for c, (lon, lat, nm) in raw.items():
        by_name[bml.norm_name(nm)].append((c, lon, lat))

    groups = []
    for _, items in by_name.items():
        for g in bml.cluster([((lon, lat), c) for c, lon, lat in items]):
            groups.append([c for _, c in g])

    # second pass: same place spelled differently, and stacked points
    cen, nm = {}, {}
    for i, g in enumerate(groups):
        cen[i] = (sum(raw[c][0] for c in g) / len(g), sum(raw[c][1] for c in g) / len(g))
        nm[i] = Counter(raw[c][2] for c in g).most_common(1)[0][0]
    grid = defaultdict(list)
    for i, (lon, lat) in cen.items():
        grid[(round(lon, 3), round(lat, 3))].append(i)
    parent = list(range(len(groups)))

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
                d = bml.hav(cen[i], cen[j])
                if d <= bml.STACKED_M or (d <= bml.SAME_PLACE_M and (bml.tokens(nm[i]) & bml.tokens(nm[j]))):
                    a, b = find(i), find(j)
                    if a != b:
                        parent[a] = b

    merged = defaultdict(list)
    for i in range(len(groups)):
        merged[find(i)] += groups[i]

    code2place, places = {}, OrderedDict()
    for n, (_, codes) in enumerate(sorted(merged.items()), start=1):
        pid = f'S{n:05d}'
        names = Counter(raw[c][2] for c in codes)
        best = sorted(names.items(),
                      key=lambda kv: (-kv[1], kv[0].upper().endswith('- RETURN'), len(kv[0])))[0][0]
        places[pid] = {
            'name': re.sub(r'\s*-\s*[Rr]eturn$', '', best).strip(),
            'lat': sum(raw[c][1] for c in codes) / len(codes),
            'lon': sum(raw[c][0] for c in codes) / len(codes),
        }
        for c in codes:
            code2place[c] = pid
    return code2place, places


def secs(t: str) -> int:
    h, m, sec = (int(x) for x in t.split(':')[:3])
    return h * 3600 + m * 60 + sec


def hhmmss(v: int) -> str:
    return f'{v // 3600:02d}:{(v % 3600) // 60:02d}:{v % 60:02d}'


_DERIVED = {}


def derived_bus_timetable(code, stop_code, visit=0):
    """Bus times at any stop, from the first-stop timetable and the route's run times.

    Verified 2026-10-19 on 70V (4104): at every stop and for every trip, the
    published time equals the first-stop arrival + cumulative
    `timeTakenToTravelUpcomingStop`, with a 15 s dwell (departure = arrival + 15).
    So a harvest needs only the first stop — ~7.4k calls instead of ~150k. Times
    wrap at 24 h exactly as the API's own do; the midnight unwrap below handles it.
    Only trips this working owns (trip-id prefix) are derived."""
    if code not in _DERIVED:
        rows_by_stop = {}
        try:
            stops = json.load(open(os.path.join(HARVEST, f'BUS_{code}.json'))).get('stops') or []
        except Exception:
            stops = []
        if stops:
            f0 = os.path.join(TIMETABLES, f'BUS_{code}_fwd_{stops[0]["code"].replace("|", "_")}.json')
            try:
                first = (json.load(open(f0)) or {}).get('timetable') or []
            except Exception:
                first = []
            first = [r for r in first if r.get('tripId') and re.split(r'[-_]', r['tripId'])[0] == code
                     and r.get('timeOfArrival')]
            cum = 0
            for k, s_ in enumerate(stops):
                rows = []
                for r in first:
                    t = (secs(r['timeOfArrival']) + cum) % 86400
                    rows.append({**r, 'timeOfArrival': hhmmss(t), 'timeOfDeparture': hhmmss((t + 15) % 86400)})
                rows_by_stop.setdefault(s_['code'], []).append(rows)   # loops visit a stop twice
                cum += s_.get('timeTakenToTravelUpcomingStop') or 0
        _DERIVED[code] = rows_by_stop
    visits = _DERIVED[code].get(stop_code) or [[]]
    return visits[min(visit, len(visits) - 1)]


def timetable(vt, code, direction, stop_code, visit=0):
    p = os.path.join(TIMETABLES, f'{vt}_{code}_{direction}_{stop_code.replace("|", "_")}.json')
    if vt == 'BUS' and direction == 'fwd' and os.environ.get('CHENNAI_ONE_DERIVE_BUS') == '1':
        return derived_bus_timetable(code, stop_code, visit)
    if not os.path.exists(p) or os.path.getsize(p) < 3:
        return []
    try:
        return (json.load(open(p)) or {}).get('timetable') or []
    except Exception:
        return []


def load_mode(vt):
    """Routes of one mode, with the same stop cleaning snap_routes applies."""
    if vt == 'BUS':
        return [r for r in sr.load_routes() if not r.get('intercity')]
    pt = json.load(open(SNAPSHOT))
    out = []
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
        stops = [s for s in stops if s.get('lat') and s.get('lon')]
        stops, _ = sr.clean_stops(stops)
        if len(stops) < 2:
            continue
        out.append({'code': r['cd'], 'sn': (r.get('sN') or r['cd']).strip(),
                    'ln': r.get('lN') or '', 'stops': stops, 'trips': r.get('dTC') or 0})
    return out


def rail_shapes():
    """Track-snapped geometry per route code, from snap_rail.py's output."""
    if not os.path.exists(RAIL_SHAPES):
        return {}
    try:
        fc = json.load(open(RAIL_SHAPES))
    except Exception:
        return {}
    return {f['properties'].get('code'): f['geometry']['coordinates']
            for f in fc['features'] if f.get('geometry')}


def write(path, header, rows):
    with open(path, 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh, lineterminator='\n')
        w.writerow(header)
        w.writerows(rows)
    return sum(1 for _ in rows)


def load_roster(path):
    """Bus assigned to each scheduled trip, from a live_sweep.py capture.

    Chennai One 3.6.0's route endpoint lists the day's trips per working with the
    registration rostered to each (`vehicleNumber`) and its flags (`LF` low
    floor, `EV` electric). Its trip ids are internal, so trips are matched to the
    timetable on (working, first-stop exact time, tier); a trip the roster moved
    by minutes is left blank rather than guessed. It is one day's roster, so the
    registration goes in a `vehicle_number` column, not block_id: 9.6% of a bus's
    consecutive trips overlap on the published run times, which block_id forbids."""
    import gzip
    out = {}
    if not path:
        return out
    for line in gzip.open(path, 'rt'):
        rec = json.loads(line)
        rws = ((rec.get('data') or {}).get('legs') or [{}])[0].get('routeWithLiveVehicles') or []
        for rw in rws:
            for sc in rw.get('schedules') or []:
                eta = sc.get('eta') or []
                if not eta or not sc.get('vehicleNumber'):
                    continue
                key = (rw.get('routeCode') or rec['routeCode'], eta[0]['arrival_time'] % 86400,
                       sc.get('serviceTierType') or '')
                out[key] = (sc['vehicleNumber'], tuple(sc.get('serviceSubTypes') or ()))
                out.setdefault(key[:2] + ('*',), out[key])   # tier-agnostic fallback
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--vt', default='BUS', choices=sorted(MODES))
    ap.add_argument('--zip', action='store_true')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    mode = MODES[a.vt]
    AGENCY_ID = mode['agency']
    shapes_src = rail_shapes() if a.vt != 'BUS' else None
    roster = load_roster(os.environ.get('CHENNAI_ONE_ROSTER')) if a.vt == 'BUS' else {}
    rostered = 0
    if roster:
        print(f'roster: {len(roster)} scheduled trips with an assigned bus')

    routes = load_mode(a.vt)
    print(f'{a.vt}: {len(routes)} workings')

    code2place, places = canonical_stops(routes)
    print(f'stops: {len(code2place)} feed records -> {len(places)} physical stops')

    # routes.txt — one row per SERVICE
    by_service = defaultdict(list)
    for r in routes:
        by_service[r['sn']].append(r)
    route_rows = []
    for sn, ws in sorted(by_service.items()):
        longest = max(ws, key=lambda w: len(w['stops']))
        route_rows.append([sn, sn, longest['ln'], mode['type'], AGENCY_ID])
    # trips + shapes + stop_times, from the harvested timetables
    trip_rows, shape_rows, st_rows = [], [], []
    shaped = 0
    no_times = 0
    reversed_trips = 0
    clamped = 0
    tier_count = Counter()
    claimed = set()          # a trip belongs to one working, mode-wide
    all_codes = {x['code'] for x in routes}

    # Rail: decide up front which route owns each trip.
    #
    # A trip appears in the timetable of every route whose stops it passes — a
    # suburban train shows up under as many as 558 of the feed's route entries —
    # and its id names the one that runs it. Claiming first-come instead left
    # 772 of 800 suburban routes with no trips at all. But the prefix rule alone
    # drops 19 trips whose named route exists yet never lists them, so the owner
    # is the named route only when that route is one of the ones offering it.
    # Metro ids do not name a route at all and fall through to first-come.
    owner_of = {}
    if a.vt != 'BUS':
        # trip -> {route: stops at which that route lists it}
        offers = defaultdict(Counter)
        for r in routes:
            for s_ in r['stops']:
                for d_ in ('fwd', 'rev'):
                    for row in timetable(a.vt, r['code'], d_, s_['code']):
                        if row.get('tripId'):
                            offers[row['tripId']][r['code']] += 1
        for tid, codes in offers.items():
            pref = re.split(r'[-_]', tid)[0]
            # Metro ids name no route. Taking the lowest code handed whole Green
            # line trains to a short working that skips Koyambedu–Anna Nagar
            # East (2026-10 snapshot), so those four stations lost every time.
            # The owner is the route that lists the trip at the most stops.
            owner_of[tid] = pref if pref in codes else min(codes, key=lambda c: (-codes[c], c))
        byname = sum(1 for t, c in owner_of.items() if re.split(r'[-_]', t)[0] == c)
        print(f'trip ownership: {len(owner_of)} trips over {len(set(owner_of.values()))} '
              f'routes ({byname} named by their trip id, {len(owner_of) - byname} assigned)')
    for r in sorted(routes, key=lambda x: (x['sn'], x['code'])):
        sn, code, stops = r['sn'], r['code'], r['stops']

        shape_id = ''
        if shapes_src is not None:
            coords = shapes_src.get(code) or []
        else:
            cp = os.path.join(CACHE, code + '.json')
            coords = []
            if os.path.exists(cp):
                try:
                    coords = json.load(open(cp))['coords']
                except Exception:
                    coords = []
        if True:
            if len(coords) > 1:
                shape_id = f'shp_{code}'
                for i, c in enumerate(coords):
                    shape_rows.append([shape_id, f'{c[1]:.6f}', f'{c[0]:.6f}', i])
                shaped += 1

        # one GTFS trip per real scheduled trip; times come from each stop's own
        # timetable, so a trip only gets a stop_time where the source has one
        per_trip = defaultdict(dict)
        tiers = defaultdict(set)
        meta = {}
        # rail lists a train under whichever direction file it was harvested in,
        # so read both; buses already resolve by trip-id owner from fwd alone
        dirs = ('fwd',) if a.vt == 'BUS' else ('fwd', 'rev')
        seen = Counter()
        for idx, s_ in enumerate(stops):
            visit = seen[s_['code']]
            seen[s_['code']] += 1
            for row in [r_ for d_ in dirs for r_ in timetable(a.vt, code, d_, s_['code'], visit)]:
                tid = row.get('tripId')
                if not tid:
                    continue
                owner = owner_of.get(tid, re.split(r'[-_]', tid)[0])
                if owner != code:
                    continue
                per_trip[tid][idx] = (row.get('timeOfArrival'), row.get('timeOfDeparture'))
                tiers[tid].add(row.get('serviceTierType') or '')
                if tid not in meta:
                    parts = tid.split('-')
                    meta[tid] = (row.get('serviceTierType') or 'ORDINARY',
                                 1 if (len(parts) >= 3 and parts[2] == 'DOWN') else 0)
        if not per_trip:
            no_times += 1
            continue
        for tid, seq in per_trip.items():
            claimed.add(tid)
            tier, direction = meta[tid]
            tier = '/'.join(sorted(t for t in tiers[tid] if t)) or tier
            tier_count[tier] += 1
            trip_id = tid
            # Direction. Rail timetables are read from both the fwd and rev
            # files, and a trip harvested from the opposite one lists its times
            # against the working's stop order reversed — its clock runs
            # downwards, which the midnight unwrap below would otherwise read as
            # crossing midnight at every single stop (15:58 -> 39:57 -> 63:55).
            order = sorted(seq)
            raw = [secs(seq[i][0] or seq[i][1] or '') for i in order
                   if (seq[i][0] or seq[i][1])]
            up = sum(1 for x, y in zip(raw, raw[1:]) if y >= x)
            if len(raw) > 1 and up < (len(raw) - 1) / 2:
                order = order[::-1]
                direction = 1
                reversed_trips += 1

            # A trip that leaves at 22:25 and arrives after midnight wraps to
            # 00:xx in the feed. GTFS counts on through the service day, so the
            # clock is unwrapped here.
            base = 0
            prev = -1
            for n, idx in enumerate(order):
                arr, dep = seq[idx]
                out = []
                for t in (arr, dep or arr):
                    if not t:
                        out.append('')
                        continue
                    v = secs(t) + base
                    if v < prev:
                        if prev - v > 12 * 3600:
                            # a real midnight crossing: 23:5x -> 00:0x
                            base += 86400
                            v += 86400
                        else:
                            # a small step backwards is bad source data, not a
                            # new day. Four bus trips visit a stop twice and the
                            # per-stop timetable returns only the first visit, so
                            # their times oscillate; treating that as a midnight
                            # wrap ran the clock out to hour 103. Hold the
                            # previous value instead of inventing a day.
                            v = prev
                            clamped += 1
                    prev = v
                    out.append(hhmmss(v))
                st_rows.append([trip_id, out[0], out[1] or out[0],
                                code2place[stops[idx]['code']], n])
            t0 = secs(seq[order[0]][0] or seq[order[0]][1])
            veh = (roster.get((code, t0 % 86400, tier.split('/')[0]))
                   or roster.get((code, t0 % 86400, '*')))
            if veh:
                rostered += 1
            trip_rows.append([trip_id, sn, 'Regular', direction, shape_id, r['ln'], tier,
                              veh[0] if veh else '',
                              ('1' if 'LF' in veh[1] else '0') if veh else '0',
                              ('electric' if 'EV' in veh[1] else 'diesel') if veh else ''])

    # GTFS requires at least two stop times per trip. Some trips surface in the
    # timetable of only one stop of their working, which yields a single time
    # and no journey at all, so they are dropped rather than published broken.
    per = Counter(x[0] for x in st_rows)
    thin = {t for t, n in per.items() if n < 2}
    if thin:
        st_rows = [x for x in st_rows if x[0] not in thin]
        trip_rows = [t for t in trip_rows if t[0] not in thin]
        print(f'  dropped {len(thin)} trips with fewer than two stop times')

    # A route nothing is scheduled on is noise in a published feed: the feed
    # lists every origin-destination permutation of the suburban network as its
    # own route entry, and only the ones a train actually runs are real.
    live = {t[1] for t in trip_rows}
    dropped = [r for r in route_rows if r[0] not in live]
    route_rows = [r for r in route_rows if r[0] in live]
    write(os.path.join(a.out, 'routes.txt'),
          ['route_id', 'route_short_name', 'route_long_name', 'route_type', 'agency_id'],
          route_rows)
    print(f'routes.txt: {len(route_rows)} services'
          + (f' ({len(dropped)} dropped — nothing scheduled on them)' if dropped else ''))

    used_shapes = {t[4] for t in trip_rows if t[4]}
    before = len(shape_rows)
    shape_rows = [x for x in shape_rows if x[0] in used_shapes]
    if before != len(shape_rows):
        print(f'shapes.txt: dropped {before - len(shape_rows)} points on unused shapes')

    write(os.path.join(a.out, 'trips.txt'),
          ['trip_id', 'route_id', 'service_id', 'direction_id', 'shape_id',
           'trip_headsign', 'service_tier', 'vehicle_number', 'wheelchair_accessible', 'vehicle_fuel'],
          trip_rows)
    write(os.path.join(a.out, 'shapes.txt'),
          ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'], shape_rows)
    # only the stops something actually calls at
    used_stops = {x[3] for x in st_rows}
    write(os.path.join(a.out, 'stops.txt'),
          ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'],
          [[pid, p['name'], f"{p['lat']:.6f}", f"{p['lon']:.6f}"]
           for pid, p in places.items() if pid in used_stops])
    print(f'stops.txt: {len(used_stops)} stops '
          f'({len(places) - len(used_stops)} with nothing scheduled dropped)')

    write(os.path.join(a.out, 'stop_times.txt'),
          ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'], st_rows)
    print(f'trips.txt: {len(trip_rows)} scheduled trips ({no_times} workings had no '
          f'timetable, {reversed_trips} run their working in reverse)')
    if roster:
        print(f'  {rostered} trips carry the bus rostered to them (vehicle_number), '
              f'{sum(1 for t in trip_rows if t[9] == "electric")} on electric buses')
    if clamped:
        print(f'  {clamped} stop times held at the previous value — the source '
              'went backwards by less than a day')
    print(f'shapes.txt: {len(shape_rows)} points over {len(used_shapes)} shapes')
    print(f'stop_times.txt: {len(st_rows)}')
    print('  trips by tier: ' + ', '.join(f'{k} {v}' for k, v in tier_count.most_common()))

    write(os.path.join(a.out, 'agency.txt'),
          ['agency_id', 'agency_name', 'agency_url', 'agency_timezone', 'agency_lang'],
          [[AGENCY_ID, mode['name'], mode['url'], 'Asia/Kolkata', 'en']])
    write(os.path.join(a.out, 'calendar.txt'),
          ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
           'saturday', 'sunday', 'start_date', 'end_date'],
          [['Regular', 1, 1, 1, 1, 1, 1, 1, '20260101', '20271231']])
    write(os.path.join(a.out, 'feed_info.txt'),
          ['feed_publisher_name', 'feed_publisher_url', 'feed_lang',
           'feed_start_date', 'feed_end_date', 'feed_version'],
          [['Reclaim Chennai', 'https://maps.reclaimchennai.city', 'en',
            '20260101', '20271231', FEED_VERSION]])

    if a.zip:
        z = a.out.rstrip('/') + '.zip'
        with zipfile.ZipFile(z, 'w', zipfile.ZIP_DEFLATED) as zf:
            for f in sorted(os.listdir(a.out)):
                if f.endswith('.txt'):
                    zf.write(os.path.join(a.out, f), f)
        print(f'{z} · {os.path.getsize(z)/1048576:.1f} MB')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
