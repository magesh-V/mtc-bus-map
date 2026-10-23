#!/usr/bin/env bash
# Rebuild everything from one Chennai One snapshot.
#
#   ./refresh.sh 20261017 [ROSTER.jsonl.gz]
#
# Expects pt_data_<DATE>.json (from /assetManifest) and a finished
#   ../v36/harvest_fast.py pt_data_<DATE>.json harvest_<DATE> --types BUS
#   ../v36/harvest_fast.py pt_data_<DATE>.json harvest_<DATE> --types METRO,SUBWAY
# ROSTER is an optional ../v36/live_sweep.py capture; it adds vehicle_number (the bus
# rostered to each trip), wheelchair_accessible (low floor) and vehicle_fuel.
#
# Writes gtfs_clean/{mtc,cmrl,suburban}(.zip) and out_<DATE>/ (map layers);
# copy out_<DATE> into maps-site by hand after checking it.
set -euo pipefail
cd "$(dirname "$0")"
D=${1:?snapshot date, e.g. 20261017}
export CHENNAI_ONE_SNAPSHOT=pt_data_$D.json
export CHENNAI_ONE_HARVEST=harvest_$D
export CHENNAI_ONE_SNAP_CACHE=snap_cache_$D
export CHENNAI_ONE_SITE_OUT=$PWD/out_$D
export CHENNAI_ONE_DERIVE_BUS=1
export CHENNAI_ONE_FEED_VERSION=chennai-one-${D:0:4}-${D:4:2}-${D:6:2}
export CHENNAI_ONE_ROSTER=${2:-}

[ -d "$CHENNAI_ONE_SNAP_CACHE" ] || cp -Rp snap_cache "$CHENNAI_ONE_SNAP_CACHE"   # re-snaps only changed stop sequences
mkdir -p "out_$D/mapsv2"
python3 snap_routes.py --workers 3
python3 build_gtfs_clean.py --vt BUS    --out gtfs_clean/mtc      --zip
python3 build_gtfs_clean.py --vt METRO  --out gtfs_clean/cmrl     --zip
python3 build_gtfs_clean.py --vt SUBWAY --out gtfs_clean/suburban --zip
# station codes, entrances, CMRL fares, suburban service days and Sunday trains from CUMTA's GTFS
python3 enrich_from_cumta.py --cmrl gtfs_clean/cmrl --cumta-cmrl cumta_20260202/cmrl --suburban gtfs_clean/suburban --cumta-suburban cumta_20260202/suburban
# every rail trip's shape cut to run from its first stop to its last
python3 fit_rail_shapes.py gtfs_clean/cmrl gtfs_clean/suburban
# every metro train's stations, times and distance along its track, for the map's timetable layer
python3 build_metro_trains.py gtfs_clean/cmrl "out_$D/mapsv2/metro_trains.json"
python3 build_map_layers.py --out "out_$D/mapsv2"
python3 build_timings.py    --out "out_$D/mapsv2/timings.json"
