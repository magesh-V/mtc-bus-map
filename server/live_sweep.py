#!/usr/bin/env python3
"""One fleet-wide sweep of Chennai One's live route endpoint (app 3.6.0).

    POST /multimodal/routeServiceability?
    {"routeCodes": [{"legOrder": 0, "routeCodes": ["<code>"]}]}

returns, for one route code (extra codes in the list are ignored — one call per
route):

  liveVehicles  every bus on the route now: registration (`number`), GPS
                `position`, `bearing`, `locationUTCTimestamp`, `currentTripId`,
                tier, `serviceSubTypes` (LF = low floor, EV = electric) and a
                predicted arrival at each remaining stop (`eta[]`)
  schedules     the day's trips with the registration assigned to each
                (`vehicleNumber`), the same flags, and the scheduled time at
                every stop — i.e. the duty roster GTFS calls block_id

Times: `arrival_time_unix` is true epoch; `arrival_time` is the same instant
shifted by +5:30 (IST wall clock written as if it were UTC).

Writes one gzip JSONL line per route, raw response plus `routeCode` and
`fetched` (UTC). Rate-limited (default 5 req/s) — a full sweep of ~3.7k routes
takes ~12 min.

    python3 live_sweep.py SNAPSHOT OUT.jsonl.gz [--rate 5] [--workers 3] [--types BUS]
"""
import argparse
import datetime as dt
import gzip
import json
import pathlib
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from api import call  # noqa: E402


class Bucket:
    def __init__(self, rate):
        self.gap, self.next, self.lock = 1.0 / rate, time.monotonic(), threading.Lock()

    def wait(self):
        with self.lock:
            now = time.monotonic()
            t = max(now, self.next)
            self.next = t + self.gap
        time.sleep(max(0.0, t - now))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('snapshot')
    ap.add_argument('out')
    ap.add_argument('--rate', type=float, default=5)
    ap.add_argument('--workers', type=int, default=3)
    ap.add_argument('--types', default='BUS')
    a = ap.parse_args()
    types = set(a.types.split(','))
    codes = [r['cd'] for r in json.load(open(a.snapshot))['rs'] if r['vt'] in types]
    bucket, lock, stats = Bucket(a.rate), threading.Lock(), {'ok': 0, 'err': 0, 'auth': 0, 'live': 0, 'sched': 0}
    out = gzip.open(a.out, 'wt')
    t0 = time.time()

    def one(code):
        for attempt in range(3):
            bucket.wait()
            c, b = call('/multimodal/routeServiceability?', 'POST',
                        {'routeCodes': [{'legOrder': 0, 'routeCodes': [code]}]})
            if c == 200:
                break
            if c in (401, 403):
                stats['auth'] += 1
                if stats['auth'] > 10:
                    raise SystemExit('session rejected — refresh the token')
            time.sleep(2 * (attempt + 1))
        rec = {'routeCode': code, 'fetched': dt.datetime.now(dt.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'), 'status': c}
        try:
            rec['data'] = json.loads(b) if c == 200 else None
        except ValueError:
            rec['data'] = None
        rws = ((rec['data'] or {}).get('legs') or [{}])[0].get('routeWithLiveVehicles') or []
        with lock:
            stats['ok' if rec['data'] else 'err'] += 1
            stats['live'] += sum(len(r.get('liveVehicles') or []) for r in rws)
            stats['sched'] += sum(len(r.get('schedules') or []) for r in rws)
            out.write(json.dumps(rec, separators=(',', ':')) + '\n')
            n = stats['ok'] + stats['err']
            if n % 250 == 0:
                print(f"{n}/{len(codes)} {stats} {n / (time.time() - t0):.1f}/s", flush=True)

    with ThreadPoolExecutor(a.workers) as ex:
        list(ex.map(one, codes))
    out.close()
    print(f"done {len(codes)} routes in {time.time() - t0:.0f}s {stats}", flush=True)


if __name__ == '__main__':
    main()
