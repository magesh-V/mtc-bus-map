#!/usr/bin/env python3
"""Rider reports for the MTC map: how full a bus is, whether it kept time.

    report_api.py --dir ~/projects/mtc-live/reports [--port 5063]

    POST /api/report          {"kind", "value", "detail", "reg", "route", "sn", "stop", "stop_name", "lat", "lon"}
    GET  /api/recent?reg=K0038       reports on that bus, last 90 minutes
    GET  /api/recent?stop=<code>     reports made at that stop, last 90 minutes
    GET  /api/summary                counts by kind and value, last 7 days (dashboard)

Answers come from a fixed set of taps (KINDS), so nothing free-text is stored.
lat/lon are the bus's or the stop's position, never the rider's. The client IP
is used only in memory for a rate limit and is not written anywhere; each
report carries a salted hash that changes every day, enough to spot one phone
filing fifty reports and no more. Stdlib only; one JSONL file per IST day.
"""
import argparse
import collections
import datetime as dt
import glob
import hashlib
import json
import os
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
KINDS = {
    'seats': {'free': ['many', 'some', 'few'], 'standing': ['some', 'crowded', 'packed'], 'full': ['boarded', 'squeezed', 'left_behind']},
    'timing': {'on_time': [''], 'late': ['lt5', '5_15', '15_30', 'gt30'], 'early': ['lt5', '5_15', 'gt15'],
               'no_show': ['15', '30', '60'], 'skipped': ['did_not_stop', 'full']},
    'access': {'ramp_ok': [''], 'ramp_broken': [''], 'not_low_floor': ['']},
}
LIMIT, WINDOW = 30, 3600                    # reports per client per hour
SALT = {'day': None, 'v': ''}
hits = collections.defaultdict(collections.deque)
lock = threading.Lock()


def day_salt():
    d = dt.datetime.now(IST).date().isoformat()
    if SALT['day'] != d:
        SALT['day'], SALT['v'] = d, secrets.token_hex(16)
    return SALT['v']


def clean(s, n):
    return ''.join(ch for ch in str(s or '')[:n] if ch.isalnum() or ch in ' .,-_/()&|')


class H(BaseHTTPRequestHandler):
    server_version = 'mtc-reports'

    def log_message(self, *a):
        pass

    def send(self, code, obj):
        body = json.dumps(obj, separators=(',', ':')).encode()
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('cache-control', 'no-store')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def client(self):
        # behind Cloudflare and Caddy: the rider's address is in cf-connecting-ip
        return (self.headers.get('cf-connecting-ip') or self.headers.get('x-forwarded-for') or self.client_address[0]).split(',')[0].strip()

    def do_POST(self):
        if urlparse(self.path).path != '/api/report':
            return self.send(404, {'error': 'not found'})
        n = int(self.headers.get('content-length') or 0)
        if n <= 0 or n > 2000:
            return self.send(400, {'error': 'bad size'})
        try:
            r = json.loads(self.rfile.read(n))
        except ValueError:
            return self.send(400, {'error': 'bad json'})
        kind, value, detail = r.get('kind'), r.get('value'), r.get('detail') or ''
        if kind not in KINDS or value not in KINDS[kind] or detail not in KINDS[kind][value] + ['']:
            return self.send(400, {'error': 'unknown answer'})
        ip, now = self.client(), time.time()
        with lock:
            q = hits[ip]
            while q and now - q[0] > WINDOW:
                q.popleft()
            if len(q) >= LIMIT:
                return self.send(429, {'error': 'too many reports, thank you'})
            q.append(now)
        rec = {'t': int(now), 'kind': kind, 'value': value, 'detail': detail,
               'reg': clean(r.get('reg'), 12), 'route': clean(r.get('route'), 12), 'sn': clean(r.get('sn'), 16),
               'stop': clean(r.get('stop'), 24), 'stop_name': clean(r.get('stop_name'), 80),
               'who': hashlib.sha256((day_salt() + ip).encode()).hexdigest()[:10]}
        for k in ('lat', 'lon'):
            try:
                v = float(r.get(k))
                if (12 < v < 14) if k == 'lat' else (79 < v < 81):
                    rec[k] = round(v, 5)
            except (TypeError, ValueError):
                pass
        day = dt.datetime.now(IST).strftime('%Y-%m-%d')
        with lock, open(os.path.join(self.server.dir, f'reports-{day}.jsonl'), 'a') as fh:
            fh.write(json.dumps(rec, separators=(',', ':')) + '\n')
        return self.send(200, {'ok': True})

    def recent(self, since):
        out = []
        for p in sorted(glob.glob(os.path.join(self.server.dir, 'reports-*.jsonl')))[-2:]:
            for ln in open(p):
                try:
                    r = json.loads(ln)
                except ValueError:
                    continue
                if r['t'] >= since:
                    out.append(r)
        return out

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        now = time.time()
        if u.path == '/api/recent':
            reg, stop = clean(q.get('reg'), 12), clean(q.get('stop'), 24)
            if not reg and not stop:
                return self.send(400, {'error': 'reg or stop'})
            rows = [r for r in self.recent(now - 5400) if (reg and r['reg'] == reg) or (stop and r['stop'] == stop)]
            return self.send(200, {'reports': [[r['kind'], r['value'], r['detail'], int((now - r['t']) // 60), r.get('sn', '')] for r in rows[-20:]]})
        if u.path == '/api/summary':
            c = collections.Counter()
            for p in sorted(glob.glob(os.path.join(self.server.dir, 'reports-*.jsonl')))[-7:]:
                for ln in open(p):
                    try:
                        r = json.loads(ln)
                        c[(r['kind'], r['value'])] += 1
                    except ValueError:
                        pass
            return self.send(200, {'counts': [[k, v, n] for (k, v), n in c.most_common()]})
        return self.send(404, {'error': 'not found'})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', required=True)
    ap.add_argument('--port', type=int, default=5063)
    a = ap.parse_args()
    os.makedirs(a.dir, exist_ok=True)
    s = ThreadingHTTPServer(('0.0.0.0', a.port), H)
    s.dir = a.dir
    s.serve_forever()


if __name__ == '__main__':
    main()
