#!/usr/bin/env python3
"""Cut each rail trip's shape to run from its first stop to its last.

    fit_rail_shapes.py FEED_DIR [FEED_DIR ...]      (cmrl/, suburban/ of a built feed)

A rail trip takes its route's track geometry from snap_rail.py, and that runs
from end to end of the route's alignment: past the trip's own termini (Beach to
Kanchipuram ran 12.5 km on toward Arakkonam), and for trips that cover only part
of the route, along track they never use. Every trip's shape is therefore
re-cut here: walk the shape forward through the trip's stops in calling order
(each stop projected onto the track no earlier than the previous one) and keep
the part between the first stop's projection and the last's. A shape the stops
cannot be walked along in order — the other direction, or another line — is
tried reversed, then every other shape of the feed is tried, and the one whose
farthest stop is nearest the track wins.

Stations sit up to ~700 m from the track centreline (the station point is the
building), so a stop counts as on the track within OFF_MAX_M. Identical cuts are
shared; shapes no trip uses are dropped; shapes.txt keeps its line endings.
"""
import collections
import csv
import math
import os
import sys

OFF_MAX_M = 800
K = 111320.0


def rd(p):
    with open(p, encoding='utf-8-sig', newline='') as fh:
        return list(csv.DictReader(fh))


def wr(p, head, rows):
    lt = '\n'
    if os.path.exists(p):
        with open(p, 'rb') as fh:
            lt = '\r\n' if fh.readline().endswith(b'\r\n') else '\n'
    with open(p, 'w', newline='') as fh:
        w = csv.DictWriter(fh, head, extrasaction='ignore', lineterminator=lt)
        w.writeheader()
        w.writerows(rows)


class Line:
    def __init__(self, pts):
        self.pts = pts                                   # [(lat, lon)]
        lat0 = sum(p[0] for p in pts) / len(pts)
        self.cx = math.cos(math.radians(lat0)) * K
        self.xy = [(lo * self.cx, la * K) for la, lo in pts]

    def project(self, ll, k_from=0, t_from=0.0):
        """Nearest point at or after (k_from, t_from): (dist m, seg k, t)."""
        px, py = ll[1] * self.cx, ll[0] * K
        best = (float('inf'), k_from, t_from)
        for k in range(k_from, len(self.xy) - 1):
            (ax, ay), (bx, by) = self.xy[k], self.xy[k + 1]
            vx, vy = bx - ax, by - ay
            L2 = vx * vx + vy * vy
            t = ((px - ax) * vx + (py - ay) * vy) / L2 if L2 else 0.0
            t = max(t_from if k == k_from else 0.0, min(1.0, t))
            d = math.hypot(ax + t * vx - px, ay + t * vy - py)
            if d < best[0]:
                best = (d, k, t)
        return best

    def walk(self, stops):
        """Project the stops in order; (worst offset, start (k, t), end (k, t))."""
        d0, k, t = self.project(stops[0])
        start, worst = (k, t), d0
        for s in stops[1:]:
            d, k, t = self.project(s, k, t)
            worst = max(worst, d)
        return worst, start, (k, t)

    def cut(self, a, b):
        (k0, t0), (k1, t1) = a, b
        at = lambda k, t: (self.pts[k][0] + t * (self.pts[k + 1][0] - self.pts[k][0]),
                           self.pts[k][1] + t * (self.pts[k + 1][1] - self.pts[k][1]))
        out = [at(k0, t0)] + self.pts[k0 + 1:k1 + 1] + [at(k1, t1)]
        clean = [out[0]]
        for p in out[1:]:
            if abs(p[0] - clean[-1][0]) > 1e-7 or abs(p[1] - clean[-1][1]) > 1e-7:
                clean.append(p)
        return clean


def fit(feed):
    shapes = collections.defaultdict(list)
    for r in rd(os.path.join(feed, 'shapes.txt')):
        shapes[r['shape_id']].append((int(r['shape_pt_sequence']), float(r['shape_pt_lat']), float(r['shape_pt_lon'])))
    lines = {k: Line([(a, b) for _, a, b in sorted(v)]) for k, v in shapes.items()}
    rev = {}
    stop_ll = {s['stop_id']: (float(s['stop_lat']), float(s['stop_lon'])) for s in rd(os.path.join(feed, 'stops.txt'))}
    seq = collections.defaultdict(list)
    for r in rd(os.path.join(feed, 'stop_times.txt')):
        seq[r['trip_id']].append((int(r['stop_sequence']), r['stop_id']))
    trips = rd(os.path.join(feed, 'trips.txt'))
    thead = list(trips[0].keys())
    cuts, out_shapes, ncut = {}, {}, collections.Counter()
    stats = collections.Counter()
    worst_all = []

    def try_line(sid, line, stops):
        w, a, b = line.walk(stops)
        if (b[0], b[1]) <= (a[0], a[1]):
            return None
        return (w, sid, line, a, b)

    for t in trips:
        stops = [stop_ll[s] for _, s in sorted(seq[t['trip_id']])]
        cand = None
        own = t['shape_id']
        if own in lines:
            cand = try_line(own, lines[own], stops)
            if not cand or cand[0] > OFF_MAX_M:
                if own not in rev:
                    rev[own] = Line(lines[own].pts[::-1])
                r = try_line(own + '_r', rev[own], stops)
                if r and (not cand or r[0] < cand[0]):
                    cand = r
        if not cand or cand[0] > OFF_MAX_M:
            stats['searched other shapes'] += 1
            for sid, line in lines.items():
                for s2, l2 in ((sid, line), (sid + '_r', rev.setdefault(sid, Line(line.pts[::-1])))):
                    r = try_line(s2, l2, stops)
                    if r and r[0] <= OFF_MAX_M and (not cand or r[0] < cand[0]):
                        cand = r
        if not cand or cand[0] > OFF_MAX_M:
            stats['left without a shape' if not own else 'kept as it was (no fit)'] += 1
            if own:
                out_shapes.setdefault(own, lines[own].pts)
            continue
        w, src, line, a, b = cand
        key = (src, a[0], round(a[1], 4), b[0], round(b[1], 4))
        if key not in cuts:
            base = src[:-2] if src.endswith('_r') else src
            whole = a == (0, 0.0) and b[0] == len(line.pts) - 2 and b[1] > 0.9999 and not src.endswith('_r')
            ncut[base] += 1
            sid = base if whole and base not in out_shapes else f'{base}_{ncut[base]}'
            cuts[key] = sid
            out_shapes[sid] = line.cut(a, b)
        stats['fitted' if own else 'shape found for a trip without one'] += 1
        stats['reversed'] += src.endswith('_r')
        stats['borrowed another route\'s shape'] += bool(own) and (src[:-2] if src.endswith('_r') else src) != own
        t['shape_id'] = cuts[key]
        worst_all.append(w)
    wr(os.path.join(feed, 'trips.txt'), thead, trips)
    wr(os.path.join(feed, 'shapes.txt'), ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'],
       [{'shape_id': k, 'shape_pt_lat': f'{la:.6f}', 'shape_pt_lon': f'{lo:.6f}', 'shape_pt_sequence': i}
        for k in sorted(out_shapes) for i, (la, lo) in enumerate(out_shapes[k])])
    worst_all.sort()
    print(f'{feed}: {dict(stats)}; {len(shapes)} -> {len(out_shapes)} shapes; '
          f'farthest stop from its track: median {worst_all[len(worst_all) // 2]:.0f} m, max {worst_all[-1]:.0f} m')


if __name__ == '__main__':
    for d in sys.argv[1:]:
        fit(d)
