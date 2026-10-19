#!/usr/bin/env python3
"""Daily Chennai One harvest on the server: new network snapshots + the day's bus roster.

    daily_harvest.py --out DIR [--rate 3] [--no-roster]

snapshots/  /assetManifest is checked; when CUMTA publishes a new network
            snapshot it is downloaded, sha256-verified and kept as
            pt_data_<publishedDate>.json, and CHANGED is written with what moved
            (routes added / removed) — the cue to run dataset/refresh.sh.
roster/     roster-YYYY-MM-DD.csv.gz: one row per scheduled bus trip of the day
            with the registration rostered to it —
            route_code, route_short_name, first_stop_time (IST), tier,
            vehicle_number, electric, low_floor
            From /multimodal/routeServiceability, one call per route (~3.7k calls,
            ~20 min at 3 req/s). Kept compact: no ETAs, no positions (those are
            in the live archive).

Session from CHENNAI_ONE_TOKEN / CHENNAI_ONE_SID (same EnvironmentFile as the
live collector).
"""
import argparse
import csv
import datetime as dt
import glob
import gzip
import hashlib
import io
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from live_collector import api, log, IST  # noqa: E402


def snapshot(out):
    d = os.path.join(out, 'snapshots')
    os.makedirs(d, exist_ok=True)
    c, j = api('/assetManifest?assetTypes=["PUBLIC_TRANSPORT_DATA"]&')
    if c != 200 or not j:
        log(f'manifest failed ({c})')
        return None
    a = j['assets'][0]
    day = a['publishedAt'][:10].replace('-', '')
    path = os.path.join(d, f'pt_data_{day}.json')
    if os.path.exists(path):
        log(f'snapshot {day} already held')
        return path
    raw = urllib.request.urlopen(a['url'], timeout=120).read()
    if hashlib.sha256(raw).hexdigest() != a['sha256']:
        log('snapshot sha256 mismatch — not saved')
        return None
    with open(path, 'wb') as fh:
        fh.write(raw)
    new = {r['cd'] for r in json.loads(raw)['rs'] if r['vt'] == 'BUS'}
    olds = sorted(p for p in glob.glob(os.path.join(d, 'pt_data_*.json')) if p != path)
    msg = f'new snapshot {day}: {len(new)} bus workings'
    if olds:
        old = {r['cd'] for r in json.load(open(olds[-1]))['rs'] if r['vt'] == 'BUS'}
        msg += f' (+{len(new - old)} / -{len(old - new)} vs {os.path.basename(olds[-1])})'
    with open(os.path.join(d, 'CHANGED'), 'a') as fh:
        fh.write(f'{dt.datetime.now(IST).isoformat(timespec="minutes")} {msg}\n')
    log(msg)
    return path


def roster(out, snap, rate):
    d = os.path.join(out, 'roster')
    os.makedirs(d, exist_ok=True)
    day = dt.datetime.now(IST).strftime('%Y-%m-%d')
    path = os.path.join(d, f'roster-{day}.csv.gz')
    if os.path.exists(path):
        log(f'roster {day} already held')
        return
    codes = [r['cd'] for r in json.load(open(snap))['rs'] if r['vt'] == 'BUS']
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(['route_code', 'route_short_name', 'first_stop_time', 'tier', 'vehicle_number', 'electric', 'low_floor'])
    rows = fails = 0
    for i, code in enumerate(codes):
        time.sleep(1 / rate)
        c, j = api('/multimodal/routeServiceability?', {'routeCodes': [{'legOrder': 0, 'routeCodes': [code]}]})
        if c != 200 or not j:
            fails += 1
            continue
        for rw in (j.get('legs') or [{}])[0].get('routeWithLiveVehicles') or []:
            if (rw.get('routeCode') or code) != code:
                continue
            for s in rw.get('schedules') or []:
                eta = s.get('eta') or []
                if not eta:
                    continue
                t = dt.datetime.fromtimestamp(eta[0]['arrival_time_unix'], IST).strftime('%H:%M:%S')
                sub = s.get('serviceSubTypes') or []
                w.writerow([code, rw.get('routeShortName') or '', t, s.get('serviceTierType') or '',
                            s.get('vehicleNumber') or '', int('EV' in sub), int('LF' in sub)])
                rows += 1
        if (i + 1) % 500 == 0:
            log(f'roster {i + 1}/{len(codes)} routes, {rows} trips')
    with gzip.open(path + '.tmp', 'wt') as fh:
        fh.write(buf.getvalue())
    os.replace(path + '.tmp', path)
    log(f'roster {day}: {rows} trips over {len(codes) - fails} routes ({fails} failed)')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--rate', type=float, default=3)
    ap.add_argument('--no-roster', action='store_true')
    a = ap.parse_args()
    snap = snapshot(a.out)
    if not snap:
        held = sorted(glob.glob(os.path.join(a.out, 'snapshots', 'pt_data_*.json')))
        snap = held[-1] if held else None
    if snap and not a.no_roster:
        roster(a.out, snap, a.rate)


if __name__ == '__main__':
    main()
