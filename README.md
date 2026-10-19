# Chennai MTC bus map — live buses, observed traffic, open timetables

The code and data behind **[mtc.reclaimchennai.city](https://mtc.reclaimchennai.city)**: every MTC
bus route on one map, every live bus moving on it, how fast buses are actually moving road by
road, and the next bus at every stop. The GTFS feeds built from the same source are published in
[reclaimchennai/ChennaiGTFS](https://github.com/reclaimchennai/ChennaiGTFS/tree/chennai-one-feeds/data/chennai-one)
(MTC buses, CMRL Metro, Southern Railway suburban + MRTS).

Everything comes from **Chennai One**, the CUMTA multimodal app — the same data the app sends
to every rider's phone, read at a polite rate.

## What is on the map

| | |
|---|---|
| **Routes** | 970 MTC services over 3,713 scheduled workings, each road-matched (OSRM over OpenStreetMap). Tap a line for its workings, stops and timings. |
| **Departures by hour** | Two 12-hour dials per working: day (6 am–6 pm) and night (6 pm–6 am). |
| **Live buses** | Every bus Chennai One is tracking, drawn in its real livery — Switch EiV12 electric AC (red) and non-AC (cyan/purple), standard-floor diesel (sky blue), diesel AC, premium. Top-down at city zoom; a side view along the road at street zoom. Between GPS fixes each bus moves along its route on the app's own predicted stop times, dwelling at stops. Tap a bus for its next stops. |
| **Live arrivals** | Every stop card lists the tracked buses due in the next 90 minutes. |
| **Traffic (observed)** | Bus speed per stop-to-stop road segment from the live fleet's GPS — last hour, or typical by hour over the past week. Not a timetable estimate. |

## Layout

```
web/       the app as served (MapLibre GL, no build step)
  index.html app.js        route explorer
  buses.js                 livery artwork (canvas, no image files)
  live.js                  live buses + live arrivals
  traffic.js               observed-speed layer
  data/                    routes, stops, timings, segment geometry (see below)
server/    runs on the web host
  live_collector.py        polls the running routes, writes live/vehicles.json every 20 s,
                           archives every GPS fix and the road speed between fixes
  live_speeds.py           per-segment speed medians -> live/speeds.json (every 10 min)
  daily_harvest.py         new network snapshots + the day's bus roster (05:30 IST)
  fare_harvest.py          every class's fare per stop pair (/frfs/search quotes all classes at once)
  harvest_fast.py api.py   timetable harvest for a new snapshot
  live_sweep.py            one raw fleet-wide capture
  systemd/                 the units as deployed (user services; %h = home)
pipeline/  snapshot -> GTFS + map layers
  refresh.sh               the whole chain for one snapshot date
  build_gtfs_clean.py      GTFS for MTC / CMRL / suburban
  snap_routes.py snap_rail.py   road and track matching
  build_map_layers.py build_timings.py build_live_assets.py build_pr_bundle.py
  build_fare_tables.py     fare tables published in ChennaiGTFS data/chennai-one/fares
```

## Running it

The API needs a rider session: log in to the Chennai One app and copy the `token` and
`session_id` request headers into `server/session.env` (see `session.env.example`; keep it
`chmod 600`, never commit it). Sessions last days to weeks; when one expires the collector logs
`session rejected` — refresh the file and restart the service.

```bash
cd server && set -a && . ./session.env && set +a
python3 live_collector.py --stops ../web/data/route_stops.json --timings ../web/data/timings.json \
  --stop-dist ../web/data/stop_dist.json --archive archive --out ../web/live/vehicles.json --rate 4
python3 live_speeds.py --stops ../web/data/route_stops.json --archive archive --out ../web/live/speeds.json
```

Serve `web/` with any static server. To rebuild for a new network snapshot: harvest it with
`server/harvest_fast.py`, then `pipeline/refresh.sh <YYYYMMDD>` (needs `shapely`, `pyproj`).

## Method notes

- **One route per call.** Chennai One answers live positions per route
  (`POST /multimodal/routeServiceability`); extra routes in a request are ignored. The collector
  cycles through the routes inside their service window at 4 requests/s, so a full pass takes
  several minutes and a bus's GPS fix can be minutes old. Motion between fixes is the app's own
  ETA prediction, not ours.
- **Observed speed** is distance along the bus's own route between two consecutive GPS fixes,
  divided by the time between them — stops, signals and congestion included, i.e. the speed a
  rider gets. Each sample is credited to every stop-to-stop segment it spans and pooled across all
  routes using that road; medians, so one bus held at a depot gate does not paint a road red.
- **Bus timetables** need only each route's first stop: every stop's time is the first-stop time
  plus the route's cumulative stop-to-stop run times, 15 s dwell — identical to the per-stop
  timetables on all 6,351 trip-stops sampled.
- **Liveries** come from the feed's own flags (`EV`, `LF`, tier). Premium buses are booked
  separately in the app and have not appeared in the live feed yet.
- **What is not here:** buses that do not report GPS are not on the live layer, and the stop list
  shows only tracked buses. State (TNSTC/SETC) and private buses are not in Chennai One.

## Data in `web/data`

`mtc_routes.geojson` (route lines), `route_stops.json` (stops per working, keyed by route code),
`timings.json` (first/last/frequency/hourly departures per working), `bus_stops.geojson`,
`bus_termini.geojson`, `metro_lines.geojson`, `metro_stations.geojson`, `stop_dist.json`
(each stop's distance along its route), `seg_geo.json` (stop-to-stop road segments).
Built from the Chennai One network snapshot of 17 October 2026.

## Licence and attribution

Code: MIT (see `LICENSE`). Data: timetables, stops and routes originate from CUMTA / MTC / CMRL /
Southern Railway via Chennai One; route and track geometry is derived from © OpenStreetMap
contributors (ODbL), so the derived data is published under ODbL. Basemap © OpenFreeMap /
OpenMapTiles / OpenStreetMap. Attribute the source agencies if you use it.

Made by [Reclaim Chennai](https://reclaimchennai.city).
