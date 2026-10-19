#!/usr/bin/env python3
"""Harvest the Oct-2026 Chennai One network the cheap way.

Per working: the route detail (stop sequence, coordinates, waypoints, and the
per-stop run time `timeTakenToTravelUpcomingStop`) and the timetable at its
FIRST stop. Verified 2026-10-19 on 70V (4104): the time at stop k equals the
first-stop departure + cumulative run time - 15 s for every trip at every stop
(only the midnight wrap differs), so per-stop timetables are redundant for
buses — ~7.4k calls instead of ~150k.

Rail does not follow that rule (Southern Railway run times vary by trip), so for
METRO/SUBWAY this fetches every stop, both directions, like harvest_all.py.

Usage: harvest_fast.py SNAPSHOT OUTDIR [--types BUS] [--workers 4]
"""
import json, os, sys, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from api import call

snap, out = sys.argv[1], sys.argv[2]
types = sys.argv[sys.argv.index("--types") + 1].split(",") if "--types" in sys.argv else ["BUS"]
workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 4
q = lambda s: urllib.parse.quote(s, safe="")
RT, TT = os.path.join(out, "routes"), os.path.join(out, "timetables")
os.makedirs(RT, exist_ok=True); os.makedirs(TT, exist_ok=True)
routes = [r for r in json.load(open(snap))["rs"] if r["vt"] in types]
auth_fail = 0

def fetch(path, f):
    global auth_fail
    if os.path.exists(f) and os.path.getsize(f) > 2: return True
    for a in range(3):
        code, body = call(path)
        if code == 200: break
        if code in (401, 403) or ("token" in body.lower() and "error" in body.lower()):
            auth_fail += 1; return False
        time.sleep(2 + 3 * a)
    if code != 200: return False
    open(f, "w").write(body); return True

def run(jobs, label):
    t0 = time.time(); ok = 0
    with ThreadPoolExecutor(workers) as ex:
        for i, r in enumerate(ex.map(lambda j: fetch(*j), jobs), 1):
            ok += bool(r)
            if auth_fail > 10: print("AUTH FAILURES — token expired; refresh and re-run", flush=True); sys.exit(2)
            if i % 500 == 0 or i == len(jobs):
                print(f"{label} {i}/{len(jobs)} ok={ok} {i/max(time.time()-t0,1):.1f}/s", flush=True)

run([(f'/frfs/route/{r["cd"]}/?city=Chennai&platformType="MULTIMODAL"&vehicleType="{r["vt"]}"&',
      os.path.join(RT, f'{r["vt"]}_{r["cd"]}.json')) for r in routes], "routes")
jobs = []
for r in routes:
    try: st = json.load(open(os.path.join(RT, f'{r["vt"]}_{r["cd"]}.json'))).get("stops") or []
    except Exception: continue
    if not st: continue
    if r["vt"] == "BUS":
        s = st[0]
        jobs.append((f'/timetable/{r["cd"]}/stop/{q(s["code"])}/?vehicleType="BUS"&toCode={q(st[-1]["code"])}&',
                     os.path.join(TT, f'BUS_{r["cd"]}_fwd_{s["code"].replace("|", "_")}.json')))
    else:
        for d, to in (("fwd", st[-1]["code"]), ("rev", st[0]["code"])):
            for s in st:
                jobs.append((f'/timetable/{r["cd"]}/stop/{q(s["code"])}/?vehicleType="{r["vt"]}"&toCode={q(to)}&',
                             os.path.join(TT, f'{r["vt"]}_{r["cd"]}_{d}_{s["code"].replace("|", "_")}.json')))
run(jobs, "timetables")
print("HARVEST COMPLETE", flush=True)
