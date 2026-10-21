#!/usr/bin/env python3
"""Fill gaps in the Chennai One rail feeds from CUMTA's own published GTFS.

    enrich_from_cumta.py --cmrl FEED_DIR --cumta-cmrl "CMRL gtfs/" \
        --suburban FEED_DIR --cumta-suburban chennai.suburban.gtfs/ \
        [--cmrl-fares fares/cmrl_fares.csv]

CUMTA publishes static GTFS at https://test.cumta.org/datasets (Government Open
Data Licence - India). It comes from the same backend as the Chennai One app but
is about a year older (October 2025), so its timetables are not used where ours
exist. What it adds that our snapshot lacks:

  CMRL      station codes (stop_code, zone_id); entrances (location_type 2) with
            CMRL's own descriptions ("A2 ENTRANCE ... RAMP (NEAR BY LIFT)") and a
            pathway to the platform; fare_attributes / fare_rules by station zone
            (prices agree with every fare we harvested); the station pairs between
            the Blue and Green lines that our fare search could not price, added to
            fares/cmrl_fares.csv with source=cumta.
  Suburban  station codes; entrances and pathways; service days. Chennai One
            publishes one every-day calendar and no Sunday trains at all. CUMTA
            splits trains into daily, Monday-Saturday and Sunday-only. Shared trains
            (same trip id = same train service) take CUMTA's days; the 180 Sunday-only
            trains, absent from Chennai One, are added from CUMTA with its times.

Our stop ids are kept: each existing stop stays the boarding point (location_type
0) that stop_times use, and gains a parent station (STN_<code>) holding the
entrances (ENT_<cumta id>). Runs once per built feed: a feed already enriched
(feed_version ends "+cumta") is left alone.
"""
import argparse
import collections
import csv
import math
import os
import re
import sys

K = 111320


def rd(p):
    with open(p, encoding='utf-8-sig', newline='') as fh:
        return list(csv.DictReader(fh))


def wr(p, head, rows):
    lt = '\n'
    if os.path.exists(p):                          # keep the file's own line endings (shapes.txt is CRLF)
        with open(p, 'rb') as fh:
            lt = '\r\n' if fh.readline().endswith(b'\r\n') else '\n'
    with open(p, 'w', newline='') as fh:
        w = csv.DictWriter(fh, head, extrasaction='ignore', lineterminator=lt)
        w.writeheader()
        w.writerows(rows)


def dist(a_lat, a_lon, b_lat, b_lon):
    return math.hypot((a_lon - b_lon) * K * math.cos(math.radians(a_lat)), (a_lat - b_lat) * K)


def toks(s):
    s = re.sub(r'[^A-Z ]', ' ', (s or '').upper())
    return {t for t in s.split() if len(t) > 2 and t not in {'METRO', 'STATION', 'JUNCTION', 'ROAD'}}


def match_stations(ours, stations, label, max_m):
    """CUMTA station id -> our stop id: nearest within max_m, name-checked."""
    out, notes = {}, []
    for s in stations:
        la, lo = float(s['stop_lat']), float(s['stop_lon'])
        best = min(ours, key=lambda o: dist(la, lo, float(o['stop_lat']), float(o['stop_lon'])))
        d = dist(la, lo, float(best['stop_lat']), float(best['stop_lon']))
        if d > max_m:
            notes.append(f'  no stop of ours within {max_m} m of {s["stop_name"]} ({d:.0f} m)')
            continue
        if not toks(s['stop_name']) & toks(best['stop_name']) and d > 120:
            notes.append(f'  {s["stop_name"]} -> {best["stop_name"]}: {d:.0f} m, names differ')
        if best['stop_id'] in out.values():
            notes.append(f'  {s["stop_name"]}: {best["stop_name"]} already taken')
            continue
        out[s['stop_id']] = best['stop_id']
    print(f'{label}: {len(out)} of {len(stations)} CUMTA stations matched to our stops')
    for n in notes:
        print(n)
    return out


STOP_HEAD = ['stop_id', 'stop_code', 'stop_name', 'stop_desc', 'stop_lat', 'stop_lon', 'zone_id',
             'location_type', 'parent_station']


def add_structure(feed, ours, smap, stations, entrances, code_of):
    """Parent stations around our stops, entrances under them, a pathway each."""
    by_id = {o['stop_id']: o for o in ours}
    st_of = {}
    new_stops, pathways = [], []
    for sid, our_id in smap.items():
        s, o = stations[sid], by_id[our_id]
        code = code_of(s)
        pid = f'STN_{code}'
        st_of[sid] = (pid, our_id)
        o.update(stop_code=code, parent_station=pid, location_type='0')
        new_stops.append({'stop_id': pid, 'stop_code': code, 'stop_name': o['stop_name'], 'stop_desc': '',
                          'stop_lat': s['stop_lat'], 'stop_lon': s['stop_lon'], 'zone_id': '',
                          'location_type': '1', 'parent_station': ''})
    n = 0
    for e in entrances:
        if e['parent_station'] not in st_of:
            continue
        pid, our_id = st_of[e['parent_station']]
        eid = f'ENT_{e["stop_id"]}'
        new_stops.append({'stop_id': eid, 'stop_code': '', 'stop_name': f'{by_id[our_id]["stop_name"]} {e["_label"]}'.strip(),
                          'stop_desc': e.get('_desc', ''), 'stop_lat': e['stop_lat'], 'stop_lon': e['stop_lon'],
                          'zone_id': '', 'location_type': '2', 'parent_station': pid})
        pathways.append({'pathway_id': f'PW_{e["stop_id"]}', 'from_stop_id': eid, 'to_stop_id': our_id,
                         'pathway_mode': '1', 'is_bidirectional': '1'})
        n += 1
    for o in ours:
        o.setdefault('location_type', '0')
    wr(os.path.join(feed, 'stops.txt'), STOP_HEAD, ours + new_stops)
    wr(os.path.join(feed, 'pathways.txt'), ['pathway_id', 'from_stop_id', 'to_stop_id', 'pathway_mode', 'is_bidirectional'], pathways)
    print(f'  {len(st_of)} parent stations, {n} entrances, {len(pathways)} pathways')
    return st_of


def cut_shape(feed, shapes, src, a, b, new_id):
    """The part of shape src between the points nearest stops a and b, as new_id."""
    if new_id in shapes:
        return new_id
    pts = shapes[src]
    near = lambda ll, lo=0: min(range(lo, len(pts)), key=lambda k: dist(ll[0], ll[1], pts[k][1], pts[k][2]))
    i = near(a)
    j = near(b, i)
    if j - i < 1 or dist(a[0], a[1], pts[i][1], pts[i][2]) > 300 or dist(b[0], b[1], pts[j][1], pts[j][2]) > 300:
        return ''
    shapes[new_id] = pts[i:j + 1]
    return new_id


def hms(t):
    h, m, s_ = map(int, t.split(':'))
    return h * 3600 + m * 60 + s_


def fmt(x):
    return f'{x // 3600:02d}:{x % 3600 // 60:02d}:{x % 60:02d}'


def subseq(a, b):
    it = iter(b)
    return all(x in it for x in a)


def mark(feed):
    fi = rd(os.path.join(feed, 'feed_info.txt'))
    if fi[0]['feed_version'].endswith('+cumta'):
        return False
    fi[0]['feed_version'] += '+cumta'
    wr(os.path.join(feed, 'feed_info.txt'), list(fi[0].keys()), fi)
    return True


def cmrl(feed, src, fares_csv):
    if not mark(feed):
        print('cmrl: already enriched'); return
    cs = rd(os.path.join(src, 'stops.txt'))
    stations = {s['stop_id']: s for s in cs if s['location_type'] == '1'}
    zone = {}                                       # station id -> CMRL station code (SCC ...)
    for s in cs:
        if s['location_type'] == '0' and s['zone_id'] and s['parent_station']:
            zone.setdefault(s['parent_station'], s['zone_id'])
    ents = []
    for s in cs:
        if s['location_type'] == '0' and 'ENTRANCE' in (s['stop_desc'] or '').upper():
            d = re.sub(r'\s+', ' ', s['stop_desc']).strip()
            m = re.match(r'([A-Z]\d+)\s+ENTRANCE', d.upper())
            ents.append(dict(s, _label=f'entrance {m.group(1)}' if m else 'entrance', _desc=d.title()))
    ours = rd(os.path.join(feed, 'stops.txt'))
    smap = match_stations(ours, [s for s in stations.values() if s['stop_id'] in zone], 'cmrl', 400)
    st_of = add_structure(feed, ours, smap, stations, ents, lambda s: zone[s['stop_id']])
    # zones = station codes, so fares can be keyed on them
    by_id = {o['stop_id']: o for o in rd(os.path.join(feed, 'stops.txt'))}
    for sid, (pid, our_id) in st_of.items():
        by_id[our_id]['zone_id'] = zone[sid]
    wr(os.path.join(feed, 'stops.txt'), STOP_HEAD, list(by_id.values()))
    known = {zone[s] for s in st_of}
    fa = rd(os.path.join(src, 'fare_attributes.txt'))
    fr = [r for r in rd(os.path.join(src, 'fare_rules.txt')) if r['origin_id'] in known and r['destination_id'] in known]
    for r in fr:
        r['route_id'] = ''
    used = {r['fare_id'] for r in fr}
    fa = [dict(r, transfers='', transfer_duration='', agency_id='CMRL') for r in fa if r['fare_id'] in used]
    ag = rd(os.path.join(feed, 'agency.txt'))
    for r in fa:
        r['agency_id'] = ag[0].get('agency_id', '') or ''
    wr(os.path.join(feed, 'fare_attributes.txt'), ['fare_id', 'price', 'currency_type', 'payment_method', 'transfers', 'agency_id'], fa)
    wr(os.path.join(feed, 'fare_rules.txt'), ['fare_id', 'origin_id', 'destination_id'], fr)
    print(f'  fares: {len(fa)} fare classes, {len(fr)} zone pairs')
    if fares_csv:
        price = {r['fare_id']: int(float(r['price'])) for r in fa}
        z2stop = {zone[s]: our for s, (_p, our) in st_of.items()}
        rows = rd(fares_csv)
        have = {(r['from_stop_id'], r['to_stop_id']) for r in rows}
        for r in rows:
            r['source'] = r.get('source') or 'chennai-one'
        agree = differ = 0
        fr_by = {(z2stop[r['origin_id']], z2stop[r['destination_id']]): price[r['fare_id']] for r in fr}
        for r in rows:
            p = fr_by.get((r['from_stop_id'], r['to_stop_id']))
            if p is not None:
                agree += p == int(r['ordinary_adult']); differ += p != int(r['ordinary_adult'])
        added = 0
        for (a, b), p in sorted(fr_by.items()):
            if a == b or (a, b) in have:
                continue
            rows.append({'from_stop_id': a, 'from_name': by_id[a]['stop_name'], 'to_stop_id': b, 'to_name': by_id[b]['stop_name'],
                         'ordinary_app_price': round(p * 0.8), 'ordinary_adult': p, 'source': 'cumta'})
            added += 1
        rows.sort(key=lambda r: (r['from_name'], r['to_name']))
        wr(fares_csv, ['from_stop_id', 'from_name', 'to_stop_id', 'to_name', 'ordinary_app_price', 'ordinary_adult', 'source'], rows)
        print(f'  cmrl_fares.csv: {agree} shared pairs agree, {differ} differ; {added} pairs added from CUMTA')


def suburban(feed, src):
    if not mark(feed):
        print('suburban: already enriched'); return
    cs = rd(os.path.join(src, 'stops.txt'))
    stations = {s['stop_id']: s for s in cs if s['location_type'] == '1'}
    parent = {s['stop_id']: s['parent_station'] or s['stop_id'] for s in cs}
    ents = [dict(s, _label=f'entrance {s["stop_name"]}', _desc='') for s in cs if s['location_type'] == '2']
    ours = rd(os.path.join(feed, 'stops.txt'))
    smap = match_stations(ours, list(stations.values()), 'suburban', 400)
    add_structure(feed, ours, smap, stations, ents, lambda s: s['stop_code'] or s['stop_id'])

    # service days
    cal = {r['service_id']: r for r in rd(os.path.join(src, 'calendar.txt'))}
    ctrips = {t['trip_id']: t for t in rd(os.path.join(src, 'trips.txt'))}
    NAME = {'1111111': 'Daily', '1111110': 'MonSat', '0000001': 'Sunday'}
    def days(sid):
        c = cal[sid]
        return ''.join(c[d] for d in ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'))
    trips = rd(os.path.join(feed, 'trips.txt'))
    thead = list(trips[0].keys())
    ours_cal = rd(os.path.join(feed, 'calendar.txt'))[0]
    used = collections.Counter()
    for t in trips:
        ct = ctrips.get(t['trip_id'])
        if ct and days(ct['service_id']) in NAME:
            t['service_id'] = NAME[days(ct['service_id'])]
        used[t['service_id']] += 1

    # the Sunday-only trains Chennai One does not carry
    routes = rd(os.path.join(feed, 'routes.txt'))
    rhead = list(routes[0].keys())
    rids = {r['route_id'] for r in routes}
    croutes = {r['route_id']: r for r in rd(os.path.join(src, 'routes.txt'))}
    cst = collections.defaultdict(list)
    for r in rd(os.path.join(src, 'stop_times.txt')):
        cst[r['trip_id']].append(r)
    ours_ids = {t['trip_id'] for t in trips}
    stop_of = {cid: smap.get(parent.get(cid)) for cid in parent}
    st = rd(os.path.join(feed, 'stop_times.txt'))
    sthead = list(st[0].keys())
    seq_shape = {}
    by_trip = collections.defaultdict(list)
    for r in st:
        by_trip[r['trip_id']].append(r)
    for t in trips:
        seq = tuple(r['stop_id'] for r in sorted(by_trip[t['trip_id']], key=lambda r: int(r['stop_sequence'])))
        seq_shape.setdefault(seq, (t['shape_id'], t['direction_id']))
    shapes = collections.defaultdict(list)
    for r in rd(os.path.join(feed, 'shapes.txt')):
        shapes[r['shape_id']].append((int(r['shape_pt_sequence']), float(r['shape_pt_lat']), float(r['shape_pt_lon'])))
    for k in shapes:
        shapes[k].sort()
    nshapes = len(shapes)
    stop_ll = {o['stop_id']: (float(o['stop_lat']), float(o['stop_lon'])) for o in rd(os.path.join(feed, 'stops.txt'))}
    added, skipped, new_routes = 0, 0, 0
    for tid, ct in sorted(ctrips.items()):
        if tid in ours_ids or days(ct['service_id']) != '0000001':
            continue
        rows = sorted(cst[tid], key=lambda r: int(r['stop_sequence']))
        mapped = [stop_of.get(r['stop_id']) for r in rows]
        if len(rows) < 2 or not all(mapped):
            skipped += 1
            continue
        cr = croutes[ct['route_id']]
        if ct['route_id'] not in rids:
            routes.append({**{k: '' for k in rhead}, 'route_id': cr['route_id'], 'route_short_name': cr['route_short_name'],
                           'route_long_name': cr['route_long_name'], 'route_type': '2', 'agency_id': routes[0]['agency_id']})
            rids.add(ct['route_id']); new_routes += 1
        shape, direc = seq_shape.get(tuple(mapped), ('', ''))
        if not shape:
            # a longer train of ours that calls at this one's termini in the same order runs
            # the same track: cut its shape between them (fast or slow, the rails are the same)
            for seq, sd in seq_shape.items():
                if not sd[0] or mapped[0] not in seq or mapped[-1] not in seq:
                    continue
                i, j = seq.index(mapped[0]), seq.index(mapped[-1])
                if i < j and (subseq(mapped, seq[i:j + 1]) or subseq(seq[i:j + 1], mapped)):
                    shape = cut_shape(feed, shapes, sd[0], stop_ll[mapped[0]], stop_ll[mapped[-1]], f'shp_{ct["route_id"]}')
                    direc = sd[1]
                    if shape:
                        break
        trips.append({**{k: '' for k in thead}, 'trip_id': tid, 'route_id': ct['route_id'], 'service_id': 'Sunday',
                      'direction_id': direc or '0', 'shape_id': shape, 'trip_headsign': cr['route_long_name'],
                      'service_tier': 'FIRST_CLASS/SECOND_CLASS', 'wheelchair_accessible': '0'})
        day, last = 0, -1
        for i, (r, s) in enumerate(zip(rows, mapped)):
            arr, dep = hms(r['arrival_time'] or r['departure_time']), hms(r['departure_time'] or r['arrival_time'])
            if arr + day < last:                     # CUMTA writes a train past midnight as 00:xx again
                day += 86400
            arr += day
            dep += day + (86400 if dep + day < arr else 0)
            last = dep
            st.append({'trip_id': tid, 'arrival_time': fmt(arr), 'departure_time': fmt(dep), 'stop_id': s, 'stop_sequence': str(i)})
        used['Sunday'] += 1
        added += 1
    base = {k: ours_cal[k] for k in ('start_date', 'end_date')}
    calrows = []
    for sid, pat in (('Regular', '1111111'), ('Daily', '1111111'), ('MonSat', '1111110'), ('Sunday', '0000001')):
        if used.get(sid):
            calrows.append({'service_id': sid, **dict(zip(('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'), pat)), **base})
    wr(os.path.join(feed, 'calendar.txt'), list(rd(os.path.join(feed, 'calendar.txt'))[0].keys()), calrows)
    wr(os.path.join(feed, 'trips.txt'), thead, trips)
    wr(os.path.join(feed, 'routes.txt'), rhead, routes)
    wr(os.path.join(feed, 'stop_times.txt'), sthead, st)
    if len(shapes) > nshapes:
        wr(os.path.join(feed, 'shapes.txt'), ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'],
           [{'shape_id': k, 'shape_pt_lat': f'{la:.6f}', 'shape_pt_lon': f'{lo:.6f}', 'shape_pt_sequence': i}
            for k, pts in shapes.items() for i, (_q, la, lo) in enumerate(pts)])
    print(f'  service days: {dict(used)}; {added} Sunday-only trains added ({new_routes} new routes, '
          f'{sum(1 for t in trips if t["service_id"] == "Sunday" and t["shape_id"])} with a shape), {skipped} not mappable')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cmrl'); ap.add_argument('--cumta-cmrl')
    ap.add_argument('--suburban'); ap.add_argument('--cumta-suburban')
    ap.add_argument('--cmrl-fares', default='')
    a = ap.parse_args()
    if a.cmrl:
        cmrl(a.cmrl, a.cumta_cmrl, a.cmrl_fares)
    if a.suburban:
        suburban(a.suburban, a.cumta_suburban)


if __name__ == '__main__':
    sys.exit(main())
