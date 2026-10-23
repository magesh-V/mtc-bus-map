/* Metro trains — where CMRL's timetable puts every train right now.

   Not live tracking: no one publishes live train positions in Chennai (not
   CMRL, not CUMTA, not the GTFS mirrors), so this is the timetable played on
   the map, and the layer, the legend and every popup say so. Metro runs close
   to its timetable, so it is a fair picture of where the trains are.

   data/metro_trains.json (pipeline/build_metro_trains.py) has, per train, its
   arrival and departure at every station and the distance along its own track
   shape. Between two stations a train speeds up out of one and slows into the
   next (an ease-in-out over the run, not an even speed with a dead stop); at a
   platform it waits until it leaves. The stations come from the same file, and
   a tapped station lists its next trains each way.

   Each train is a small DOM marker moved on every animation frame, so it glides
   instead of stepping: ~40 setLngLat calls a frame, no GeoJSON rebuilt and
   nothing sent to the map's workers. Far out, where a train moves less than a
   pixel a second, it is moved four times a second instead. The browser stops
   the frames on its own while the tab is hidden.

   Shares app.js's script scope (map, $, DATA, DATA_V). */
'use strict';
(() => {
  const K = 111320, IST = 19800;
  const COL = { Blue: '#0b63c5', Green: '#13955a', 'Green Direct': '#13955a' };
  const STN = '#5b3fb0';                       // the metro track's purple, a shade darker
  let on = (() => { try { return localStorage.getItem('mtcTrains') !== '0'; } catch (e) { return true; } })();
  let D = null, SH = null, raf = 0, last = 0, popup = null, popTrain = -1, popAt = 0, small = false, loading = null;
  const MK = new Map();                        // trip index -> { m: marker, el, dir }

  const css = document.createElement('style');
  css.textContent = `
    .tn { width: 24px; height: 24px; cursor: pointer; }
    .tn .dir { position: absolute; inset: -6px; pointer-events: none; transition: transform .25s linear; }
    .tn .dir::before { content: ''; position: absolute; left: 50%; top: 0; transform: translateX(-50%);
      border: 5px solid transparent; border-top: 0; border-bottom: 6px solid var(--c); filter: drop-shadow(0 -1px 0 #fff); }
    .tn .body { position: absolute; inset: 0; border-radius: 50%; background: var(--c); border: 2px solid #fff;
      box-shadow: 0 1px 4px rgba(0,0,0,.35); display: grid; place-items: center; }
    .tn .body svg { width: 14px; height: 14px; }
    .tn.at .body { box-shadow: 0 0 0 3px rgba(255,255,255,.75), 0 1px 4px rgba(0,0,0,.35); }
    .tn.sm { width: 11px; height: 11px; }
    .tn.sm .body { border-width: 1.5px; box-shadow: 0 1px 2px rgba(0,0,0,.3); }
    .tn.sm svg, .tn.sm .dir { display: none; }
    .tn-pop .maplibregl-popup-content { border-radius: 12px; padding: 9px 12px; font-size: 12.5px; line-height: 1.45; box-shadow: 0 6px 20px rgba(0,0,0,.18); }
    .tn-pop .ln { display: inline-block; padding: 1px 7px; border-radius: 6px; color: #fff; font-weight: 700; font-size: 11.5px; margin-right: 4px; }
    .tn-pop .nx { margin-top: 4px; font-variant-numeric: tabular-nums; }
    .tn-pop .nx b { font-weight: 700; }
    .tn-pop .note { color: var(--muted); font-size: 11px; margin-top: 3px; }
    @media (prefers-reduced-motion: reduce) { .tn .dir { transition: none; } }`;
  document.head.appendChild(css);
  // a metro train seen from the front, in white, upright whichever way the train is heading
  const GLYPH = `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="14" rx="4"/><path d="M5 10h14M9 13.5h.01M15 13.5h.01M8.5 21l1.5-4M15.5 21 14 17"/></svg>`;

  const nowS = () => (Date.now() / 1000 + IST) % 86400;
  const hm = s => { s = Math.round(s) % 86400; return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`; };
  // "WASHERMENPET METRO - WIMCO NAGAR DEPOT STATION" -> "Wimco Nagar Depot Station"
  const dest = h => (h.split(' - ').pop() || h).toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());

  function prep(coords) {
    const cx = Math.cos(coords[0][1] * Math.PI / 180) * K, n = coords.length;
    const xs = new Float64Array(n), ys = new Float64Array(n), cum = new Float64Array(n);
    for (let i = 0; i < n; i++) { xs[i] = coords[i][0] * cx; ys[i] = coords[i][1] * K; if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]); }
    return { xs, ys, cum, cx, n };
  }
  // the point d metres along a shape, in the shape's metric frame
  function xy(g, d, out) {
    const c = g.cum, n = g.n;
    d = d < 0 ? 0 : d > c[n - 1] ? c[n - 1] : d;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= d) lo = m; else hi = m; }
    const t = (d - c[lo]) / ((c[hi] - c[lo]) || 1);
    out[0] = g.xs[lo] + t * (g.xs[hi] - g.xs[lo]); out[1] = g.ys[lo] + t * (g.ys[hi] - g.ys[lo]);
  }
  /* Where the train is and which way its nose points: the heading is taken over
     the track 40 m behind to 40 m ahead, so it turns through a curve smoothly. */
  const _a = [0, 0], _b = [0, 0], _c = [0, 0];
  function at(g, d) {
    xy(g, d, _a); xy(g, d - 40, _b); xy(g, d + 40, _c);
    return [_a[0] / g.cx, _a[1] / K, (Math.atan2(_c[0] - _b[0], _c[1] - _b[1]) * 180 / Math.PI + 360) % 360];
  }

  // speed up out of a station and slow into the next: smoothstep over the run
  const ease = u => u * u * (3 - 2 * u);
  /* Where one train is at time t, or null if it is not running: the distance
     along its shape, and k, the knot of the station it is at or heading for. */
  function place(trip, t) {
    const k = trip[3], end = k.length - 4;
    if (t < k[2] || t > k[end + 1]) return null;          // before it leaves its first station, after it reaches its last
    for (let i = 0; i < end; i += 4) {
      if (t <= k[i + 2]) return { d: k[i + 3], k: i, at: true };                       // waiting at the platform
      if (t < k[i + 5]) return { d: k[i + 3] + (k[i + 7] - k[i + 3]) * ease((t - k[i + 2]) / ((k[i + 5] - k[i + 2]) || 1)), k: i + 4, at: false };
    }
    return { d: k[end + 3], k: end, at: true };
  }
  /* Does a trip run on day w (0 = Monday)? D.days holds calendar.txt's weekday
     patterns ("1111111", "1111110", "0000001"), so a Sunday-only train is not
     drawn on a Monday. A trip whose times run past midnight is also looked for
     at t + 24 h, on the day its service started. */
  const runs = (trip, w) => !D.days || D.days[trip[4] || 0][w] === '1';
  const today = () => (new Date(Date.now() + IST * 1000).getUTCDay() + 6) % 7;
  const placeNow = (trip, t, w = today()) => (runs(trip, w) && place(trip, t)) || (runs(trip, (w + 6) % 7) && place(trip, t + 86400));

  function marker(i) {
    const line = D.lines[D.trips[i][1]], el = document.createElement('div');
    el.className = 'tn' + (small ? ' sm' : '');
    el.style.setProperty('--c', COL[line] || STN);
    el.innerHTML = `<i class="dir"></i><b class="body">${GLYPH}</b>`;
    el.title = `${line} Line train (timetable)`;
    // after the tap reaches the map (whose click would close a popup opened now); popTrain after pop(), which clears it
    el.addEventListener('click', () => setTimeout(() => { if (MK.has(i)) { pop(MK.get(i).m.getLngLat(), trainInfo(i)); popTrain = i; } }, 0));
    const o = { el, dir: el.firstChild, b: null, m: new maplibregl.Marker({ element: el, subpixelPositioning: true }), added: false };   // whole-pixel snapping would make a slow train step
    MK.set(i, o);
    return o;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!D || now - last < (small ? 250 : 0)) return;
    last = now;
    const t = nowS(), w = today(), seen = new Set(), mb = map.getBearing();
    for (let i = 0; i < D.trips.length; i++) {
      const trip = D.trips[i], p = placeNow(trip, t, w);
      if (!p) continue;
      seen.add(i);
      const o = MK.get(i) || marker(i), [lon, lat, b] = at(SH[trip[0]], p.d);
      o.m.setLngLat([lon, lat]);
      if (!o.added) { o.m.addTo(map); o.added = true; }
      // the pointer turns the short way round, so a train never spins at a curve
      const nb = o.b == null ? b : o.b + ((b - o.b + 540) % 360 - 180);
      if (o.b == null || Math.abs(nb - o.b) > 0.5) { o.b = nb; o.dir.style.transform = `rotate(${nb - mb}deg)`; }
      o.el.classList.toggle('at', p.at);
      if (i === popTrain && popup) popup.setLngLat([lon, lat]);
    }
    for (const [i, o] of MK) if (!seen.has(i)) { o.m.remove(); MK.delete(i); if (i === popTrain && popup) { popup.remove(); popup = null; } }
    // the popup follows its train every frame; its words ("Next: Saidapet") once a second
    if (popTrain >= 0 && popup && now - popAt > 1000) { popAt = now; popup.setHTML(trainInfo(popTrain)); }
    // no train runs (about 23:30 to 04:50): look again in 30 s rather than every frame
    if (!seen.size) last = now + 30000;
  }

  const NOTE = `<div class="note">From CMRL's timetable — not live tracking</div>`;
  function trainInfo(i) {
    const trip = D.trips[i], t = nowS(), p = placeNow(trip, t);
    if (!p) return 'This train has finished its run.';
    const k = trip[3], line = D.lines[trip[1]], st = D.stations[k[p.k]];
    const tt = p.at ? k[p.k + 2] : k[p.k + 1];
    return `<span class="ln" style="background:${COL[line] || STN}">${line} Line</span> to <b>${dest(D.heads[trip[2]])}</b><br>`
      + (p.at ? `At <b>${st}</b>, leaves ${hm(tt)}` : `Next: <b>${st}</b> at ${hm(tt)}`) + NOTE;
  }
  // the next three departures towards each destination, from the timetable
  function stationInfo(n) {
    const t = nowS(), w = today(), by = new Map();
    for (const trip of D.trips) {
      if (!runs(trip, w)) continue;
      const k = trip[3];
      for (let i = 0; i < k.length - 4; i += 4) {           // not the last stop: nothing departs from there
        if (k[i] !== n) continue;
        let dep = k[i + 2];
        if (dep > 86400 && t < dep - 86400) dep -= 86400;    // an after-midnight departure, seen before midnight passes
        if (dep < t) break;
        const h = dest(D.heads[trip[2]]);
        (by.get(h) || by.set(h, []).get(h)).push(dep);
        break;
      }
    }
    // two trips in the same minute to the same place read as one train to a rider
    const rows = [...by.entries()].map(([h, ds]) => [h, [...new Set(ds.sort((a, b) => a - b).map(hm))].slice(0, 3), Math.min(...ds)])
      .sort((a, b) => a[2] - b[2]);
    return `<b>${D.stations[n]}</b>`
      + (rows.length ? rows.map(([h, ds]) => `<div class="nx">to <b>${h}</b>: ${ds.join(', ')}</div>`).join('')
        : `<div class="nx">No more trains today.</div>`) + NOTE;
  }
  const pop = (ll, html) => {
    if (popup) popup.remove();
    popup = new maplibregl.Popup({ className: 'tn-pop', closeButton: false, maxWidth: '270px', offset: 14 }).setLngLat(ll).setHTML(html).addTo(map);
    popup.on('close', () => { popTrain = -1; });
  };

  // far out a train is a plain dot, close in a badge with its symbol and heading
  const sizeAll = () => {
    const s = map.getZoom() < 11.5;
    if (s === small) return;
    small = s;
    for (const o of MK.values()) o.el.classList.toggle('sm', s);
  };

  const LAYERS = ['metro-stations', 'metro-station-labels'];
  function addLayers() {
    if (map.getSource('metro-stations')) return;
    map.addSource('metro-stations', { type: 'geojson', data: { type: 'FeatureCollection',
      features: D.spos.map(([lon, lat], n) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { n, name: D.stations[n] } })) } });
    // over the metro track and the bus routes, under the selected route, the bus stops and their labels
    const before = map.getLayer('sel-glow') ? 'sel-glow' : undefined;
    map.addLayer({ id: 'metro-stations', type: 'circle', source: 'metro-stations',
      paint: { 'circle-color': '#fff', 'circle-stroke-color': STN, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 5, 17, 7],
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1.4, 14, 2.4] } }, before);
    map.addLayer({ id: 'metro-station-labels', type: 'symbol', source: 'metro-stations', minzoom: 12.5,
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-padding': 2 },
      paint: { 'text-color': STN, 'text-halo-color': '#fff', 'text-halo-width': 1.6 } }, before);
    map.on('click', 'metro-stations', e => {
      if ((window.liveBusAt && window.liveBusAt(e.point)) || (window.trafficAt && window.trafficAt(e.point))
        || trainAt(e.point) || stopAt(e.point)) return;          // a bus, a speed segment, a train or a bus stop on top wins
      pop(e.features[0].geometry.coordinates, stationInfo(e.features[0].properties.n));
    });
    map.on('mouseenter', 'metro-stations', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'metro-stations', () => map.getCanvas().style.cursor = '');
    map.on('zoom', sizeAll);
    map.on('rotate', () => { const mb = map.getBearing(); for (const o of MK.values()) if (o.b != null) o.dir.style.transform = `rotate(${o.b - mb}deg)`; });
  }
  // a train marker within a finger's width of a map point (app.js lets it take the click)
  const trainAt = p => {
    for (const o of MK.values()) { const q = map.project(o.m.getLngLat()); if (Math.abs(q.x - p.x) < 13 && Math.abs(q.y - p.y) < 13) return true; }
    return false;
  };
  const hit = (p, layers) => map.queryRenderedFeatures([[p.x - 5, p.y - 5], [p.x + 5, p.y + 5]], { layers: layers.filter(id => map.getLayer(id)) }).length > 0;
  const stopAt = p => hit(p, ['stops']);
  // app.js: a train or a station takes the click from a route line, but a bus stop drawn over a station keeps its own
  window.trainAt = p => on && (trainAt(p) || (hit(p, ['metro-stations']) && !stopAt(p)));

  function show() {
    addLayers();
    LAYERS.forEach(id => map.setLayoutProperty(id, 'visibility', 'visible'));
    small = map.getZoom() < 11.5;
    cancelAnimationFrame(raf); last = 0; raf = requestAnimationFrame(frame);
  }
  function start() {
    if (D) return show();
    if (loading) return;                                       // a toggle while it downloads does not fetch it twice
    loading = fetch(`${DATA}/metro_trains.json?v=${DATA_V}`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(j => { D = j; SH = j.shapes.map(prep); if (on) show(); })
      .catch(err => console.warn('metro trains: could not load metro_trains.json', err))
      .finally(() => { loading = null; });
  }
  function stop() {
    cancelAnimationFrame(raf); raf = 0;
    for (const o of MK.values()) o.m.remove();
    MK.clear();
    if (popup) { popup.remove(); popup = null; }
    LAYERS.forEach(id => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', 'none'));
  }

  const btn = document.createElement('button');
  btn.className = 'lyr' + (on ? ' on' : '');
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="13" rx="4"/><path d="M5 10h14M9 13h.01M15 13h.01M7.5 16 5.5 21M16.5 16l2 5"/></svg><span>Metro trains (timetable)</span>`;
  const lm = $('layer-menu'), metroBtn = lm.querySelector('[data-lyr="metro"]');
  lm.insertBefore(btn, metroBtn ? metroBtn.nextSibling : null);
  btn.addEventListener('click', e => {
    e.stopPropagation();
    on = !on; btn.classList.toggle('on', on);
    try { localStorage.setItem('mtcTrains', on ? '1' : '0'); } catch (err) {}
    on ? start() : stop();
  });
  const boot = () => { if (on) start(); };
  if (map.loaded() && map.getSource('routes')) boot(); else map.once('idle', boot);
})();
