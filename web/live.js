/* Live buses — every MTC bus Chennai One is tracking, moving on the map.

   Data: live/vehicles.json, rewritten every ~20 s on the server by
   chennai_one/v36/live_collector.py, which cycles through the running routes at
   a polite rate. A full cycle takes minutes, so a bus's GPS fix can be a few
   minutes old — but each bus also carries the app's own predicted arrival at
   every stop still ahead of it. A bus is therefore drawn by dead reckoning
   along its road-snapped route: from its last fix, through those predicted
   stop times. Between polls the motion is the operator's own forecast, and
   each new poll pulls the bus back onto its real position.

   Row: [reg, routeCode, lat, lon, bearing, fixEpoch, flags, [[stopIdx, etaEpoch], ...]]
   stopIdx indexes ROUTE_STOPS[routeCode].d[0].s; flags a=AC e=electric l=low floor x=express.

   Loaded after app.js and shares its script scope (map, ROUTE_IDX, ROUTE_STOPS,
   openStop, selectRoute, showCard, tagHTML, $). */
'use strict';
(() => {
  const URL_ = 'live/vehicles.json';
  const POLL_MS = 20000, FRAME_MS = 100, K = 111320;
  const lvOf = fl => BUSART.of(fl), lvCol = fl => BUSART.L[lvOf(fl)].key;
  let on = (() => { try { return localStorage.getItem('mtcLive') !== '0'; } catch (e) { return true; } })();
  let FEED = null, fetchedAt = 0, pollT = null, frameT = null, CODE_FEAT = null;
  let selReg = null, cardStop = null, cardBus = null;
  const GEO = new Map(), TRACK = new Map();
  const now = () => Date.now() / 1000;

  /* ── geometry: route lines as distance-along polylines ── */
  function codeFeat(code) {
    if (!CODE_FEAT) {
      if (!Object.keys(ROUTE_IDX).length) return null;
      CODE_FEAT = new Map();
      Object.values(ROUTE_IDX).forEach(e => e.works.forEach(w => CODE_FEAT.set(String(w.properties.code), w)));
    }
    return CODE_FEAT.get(code) || null;
  }
  function stopsOf(code) {
    const r = ROUTE_STOPS && ROUTE_STOPS[code];
    return r && r.d && r.d[0] ? r.d[0].s : null;
  }
  function prep(coords) {
    const cx = Math.cos(coords[0][1] * Math.PI / 180) * K;
    const pts = coords.map(c => [c[0] * cx, c[1] * K]), cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return { coords, pts, cum, cx };
  }
  // nearest point on the line between segments [i0, i1); returns {d, off, i}
  function project(g, lon, lat, i0 = 0, i1 = g.pts.length - 1) {
    const px = lon * g.cx, py = lat * K;
    let best = { d: 0, off: Infinity, i: i0 };
    for (let i = Math.max(0, i0); i < Math.min(i1, g.pts.length - 1); i++) {
      const [ax, ay] = g.pts[i], [bx, by] = g.pts[i + 1], dx = bx - ax, dy = by - ay;
      const L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
      const off = Math.hypot(ax + t * dx - px, ay + t * dy - py);
      if (off < best.off) best = { d: g.cum[i] + t * Math.sqrt(L), off, i };
    }
    return best;
  }
  // point on the line at distance d, in projected metres
  function xy(g, d) {
    const c = g.cum, n = c.length;
    d = Math.max(0, Math.min(c[n - 1], d));
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= d) lo = m; else hi = m; }
    const t = (d - c[lo]) / ((c[hi] - c[lo]) || 1), a = g.pts[lo], b = g.pts[hi];
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  }
  /* Where the bus is and which way its nose points. The heading is taken over
     the road just behind to just ahead of the bus rather than from the vertex
     pair it sits on, so it swings through a bend instead of snapping at every
     vertex of the snapped line. */
  function at(g, d) {
    const [x, y] = xy(g, d), [ax, ay] = xy(g, d - 18), [bx, by] = xy(g, d + 32);
    const h = (Math.atan2(bx - ax, by - ay) * 180 / Math.PI + 360) % 360;
    return [[x / g.cx, y / K], h];
  }
  // the route line, plus where along it each stop sits (kept in running order)
  function geo(code) {
    if (GEO.has(code)) return GEO.get(code);
    const f = codeFeat(code), st = stopsOf(code);
    if (!st || st.length < 2 || !CODE_FEAT) return null;   // not loaded yet: try again next frame
    let coords = f && f.geometry && (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.coordinates);
    if (!coords || coords.length < 2) coords = st.map(s => [s[3], s[2]]);
    const g = prep(coords);
    let seg = 0, prev = 0;
    g.stopD = st.map(s => {
      let p = project(g, s[3], s[2], seg);
      if (p.off > 80) { const q = project(g, s[3], s[2]); if (q.off < p.off - 40) p = q; }
      const d = Math.max(prev, p.d); prev = d; seg = Math.max(seg, p.i);
      return d;
    });
    GEO.set(code, g);
    return g;
  }

  /* ── tracks: (time, distance) knots per bus, rebuilt on each poll ── */
  function buildTracks() {
    // where each bus is drawn right now, so the new track can blend from it
    const t0 = now(), was = new Map();
    for (const [reg, tr] of TRACK) if (tr.knots) was.set(reg, [tr.v[1], dOf(tr, t0)]);
    TRACK.clear();
    if (!FEED) return;
    for (const v of FEED.v) {
      const [reg, code, lat, lon, , fix, , eta] = v;
      const g = geo(code);
      const tr = { v, g, knots: null };
      if (g && eta.length) {
        const first = g.stopD[eta[0][0]];
        const segMax = Math.max(1, g.cum.findIndex(c => c >= first) + 1);
        const p = project(g, lon, lat, 0, segMax);
        if (p.off < 300) {
          const knots = [[fix, Math.min(p.d, first)]];
          for (const [i, t] of eta) {
            const d = g.stopD[i];
            if (d == null || t <= knots[knots.length - 1][0] || d < knots[knots.length - 1][1]) continue;
            knots.push([t, d]);
          }
          tr.knots = knots;
          const w = was.get(reg);
          if (w && w[0] === code) {
            const off = w[1] - dOf(tr, t0);
            if (Math.abs(off) < 2500) { tr.off = off; tr.offT = t0; }
          }
        }
      }
      TRACK.set(reg, tr);
    }
  }
  /* Distance along the route at time t. Between two predicted stop times the
     bus does not glide at constant speed: it waits at the stop (DWELL), pulls
     away, cruises and slows into the next one (smoothstep). From the GPS fix,
     which is mid-road, it is already moving (ease-out). When a new poll
     moves a bus, the difference is blended away over BLEND seconds rather than
     teleporting it. */
  const DWELL = 14, BLEND = 4;
  function dOf(tr, t) {
    const k_ = tr.knots;
    let d = k_[0][1];
    if (t >= k_[k_.length - 1][0]) d = k_[k_.length - 1][1];
    else if (t > k_[0][0]) {
      for (let k = 1; k < k_.length; k++) {
        if (t <= k_[k][0]) {
          const [t0, d0] = k_[k - 1], [t1, d1] = k_[k];
          const dep = k > 1 ? t0 + Math.min(DWELL, 0.3 * (t1 - t0)) : t0;
          const u = Math.max(0, Math.min(1, (t - dep) / ((t1 - dep) || 1)));
          d = d0 + (d1 - d0) * (k > 1 ? u * u * (3 - 2 * u) : u * (2 - u));
          break;
        }
      }
    }
    if (tr.off) {
      const f = 1 - (t - tr.offT) / BLEND;
      if (f > 0) d += tr.off * f * f; else tr.off = 0;
    }
    return d;
  }
  function posOf(tr, t) {
    if (!tr.knots) return [[tr.v[3], tr.v[2]], tr.v[4] || 0];
    return at(tr.g, dOf(tr, t));
  }

  /* ── drawing ── */
  function addLayers() {
    if (map.getSource('live')) return;
    BUSART.register(map);
    map.addSource('live', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'live-halo', type: 'circle', source: 'live', filter: ['==', ['get', 'sel'], 1],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 9, 15, 18], 'circle-color': ['get', 'c'], 'circle-opacity': 0.22, 'circle-blur': 0.4 } });
    /* City zooms: a top-down bus turning with the road. From z15.5 the
       side view takes over, laid along the road and facing the way it goes. */
    const SIDE_Z = 15.5;
    map.addLayer({ id: 'live-bus', type: 'symbol', source: 'live',
      layout: {
        'icon-image': ['step', ['zoom'], ['concat', 'top-', ['get', 'lv']], SIDE_Z,
          ['concat', 'side-', ['get', 'lv'], ['case', ['<', ['get', 'h'], 180], '-r', '-l']]],
        // side view: the right-facing sprite turned h-90 for eastward headings,
        // the left-facing one turned h-270 for westward — the bus lies along the
        // road with its nose forward and is never drawn upside down
        'icon-rotate': ['step', ['zoom'], ['get', 'h'], SIDE_Z,
          ['case', ['<', ['get', 'h'], 180], ['-', ['get', 'h'], 90], ['-', ['get', 'h'], 270]]],
        'icon-rotation-alignment': 'map',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.2, 12, 0.3, 14, 0.45, 15.4, 0.62, 15.5, 0.5, 18, 0.85],
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'symbol-sort-key': ['get', 'sel'] } });
    map.addLayer({ id: 'live-num', type: 'symbol', source: 'live', minzoom: 13,
      layout: { 'text-field': ['get', 'sn'], 'text-font': ['Noto Sans Bold'], 'text-size': 11,
        'text-offset': ['step', ['zoom'], ['literal', [0, 1.5]], 15.5, ['literal', [0, 1.35]]],
        'text-anchor': 'top', 'text-optional': true, 'text-padding': 1 },
      paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#fff', 'text-halo-width': 1.6 } });
    // a moving 10-px bus is hard to hit exactly, so the nearest one within 12 px takes the click
    map.on('click', e => {
      const hits = busesNear(e.point);
      if (!hits.length) return;
      const pt = f => map.project(f.geometry.coordinates);
      hits.sort((x, y) => Math.hypot(pt(x).x - e.point.x, pt(x).y - e.point.y) - Math.hypot(pt(y).x - e.point.x, pt(y).y - e.point.y));
      openBus(hits[0].properties.reg);
    });
    map.on('mouseenter', 'live-bus', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'live-bus', () => map.getCanvas().style.cursor = '');
  }
  const busesNear = p => map.getLayer('live-bus') && map.getLayoutProperty('live-bus', 'visibility') !== 'none'
    ? map.queryRenderedFeatures([[p.x - 12, p.y - 12], [p.x + 12, p.y + 12]], { layers: ['live-bus'] }) : [];
  window.liveBusAt = p => busesNear(p).length > 0;
  const snOf = code => { const f = codeFeat(code); return f ? (f.properties.sn || f.properties.route_name) : code; };
  function frame() {
    if (!on || !FEED || document.hidden) return;
    if (TRACK.size === 0 || [...TRACK.values()].some(tr => !tr.g && stopsOf(tr.v[1]))) buildTracks();
    const t = now(), feats = [];
    const z = map.getZoom(), b = z >= 12 ? map.getBounds() : null;
    const pad = b ? Math.max(b.getEast() - b.getWest(), b.getNorth() - b.getSouth()) * 0.25 : 0;
    for (const [reg, tr] of TRACK) {
      if (b && reg !== selReg && (tr.v[3] < b.getWest() - pad - .05 || tr.v[3] > b.getEast() + pad + .05
          || tr.v[2] < b.getSouth() - pad - .05 || tr.v[2] > b.getNorth() + pad + .05)) continue;
      const [ll, h] = posOf(tr, t);
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ll },
        properties: { reg, h, lv: lvOf(tr.v[6]), c: lvCol(tr.v[6]), sn: snOf(tr.v[1]), sel: reg === selReg ? 1 : 0 } });
    }
    const src = map.getSource('live');
    if (src) src.setData({ type: 'FeatureCollection', features: feats });
  }

  // ~30 fps at street zooms (only buses on screen are moved), 10 fps city-wide
  let lastF = 0;
  function loop(ts) {
    if (!frameT) return;
    requestAnimationFrame(loop);
    const gap = map.getZoom() >= 14 ? 33 : FRAME_MS;
    if (ts && ts - lastF < gap) return;
    lastF = ts || 0;
    frame();
  }

  /* ── polling ── */
  function poll() {
    fetch(`${URL_}?t=${Math.floor(Date.now() / 10000)}`).then(r => r.ok ? r.json() : null).then(j => {
      if (!j || !Array.isArray(j.v)) throw 0;
      FEED = j; fetchedAt = Date.now();
      buildTracks(); frame(); pill();
      if (cardStop) paintStopArrivals();
      if (cardBus) paintBus(cardBus);
    }).catch(() => { pill(true); });
  }
  function ensureStops() {
    if (ROUTE_STOPS !== undefined) return Promise.resolve();
    return fetch(`data/route_stops.json?v=${DATA_V}`).then(r => r.ok ? r.json() : {}).then(j => { if (ROUTE_STOPS === undefined) ROUTE_STOPS = j; })
      .catch(() => {});
  }
  function start() {
    addLayers();
    ['live-bus', 'live-num', 'live-halo'].forEach(id => map.setLayoutProperty(id, 'visibility', 'visible'));
    ensureStops().then(() => { GEO.clear(); buildTracks(); });
    poll();
    clearInterval(pollT);
    pollT = setInterval(poll, POLL_MS);
    if (!frameT) { frameT = 1; loop(); }
    pill();
  }
  function stop() {
    clearInterval(pollT); pollT = frameT = null;
    ['live-bus', 'live-num', 'live-halo'].forEach(id => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', 'none'));
    pill();
    if (cardStop) paintStopArrivals();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && on) poll(); });

  /* ── status pill ── */
  const css = document.createElement('style');
  css.textContent = `
    #live-pill { position: fixed; z-index: 590; left: 50%; transform: translateX(-50%); top: calc(14px + env(safe-area-inset-top));
      display: none; align-items: center; gap: 8px; padding: 6px 11px 6px 9px; border-radius: 999px;
      background: rgba(255,255,255,.94); box-shadow: 0 2px 10px rgba(0,0,0,.16); font-size: 12px; color: #333;
      font-variant-numeric: tabular-nums; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
    #live-pill.show { display: flex; }
    #live-pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #f01b48; box-shadow: 0 0 0 0 rgba(240,27,72,.5); animation: lpulse 1.8s infinite; }
    #live-pill.stale .dot { background: #aaa; animation: none; }
    #live-pill b { font-weight: 700; letter-spacing: .04em; }
    #live-pill .key { display: flex; gap: 7px; margin-left: 2px; color: #666; }
    #live-pill .key i { display: inline-block; width: 6px; height: 13px; border-radius: 3px 3px 1.5px 1.5px; margin-right: 3px; vertical-align: -1px; }
    @keyframes lpulse { 70% { box-shadow: 0 0 0 7px rgba(240,27,72,0); } 100% { box-shadow: 0 0 0 0 rgba(240,27,72,0); } }
    @media (max-width: 640px) { #live-pill .key { display: none; } }
    .lv-row { display: grid; grid-template-columns: auto 1fr auto; gap: 4px 10px; align-items: center; padding: 7px 2px; border-bottom: 1px solid #efe9de; }
    .lv-row:last-child { border-bottom: 0; }
    .lv-row .when { font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
    .lv-row .when small { display: block; font-weight: 400; color: var(--muted); font-size: 11px; }
    .lv-row .meta { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lv-row .meta b { color: #333; font-weight: 600; }
    .lv-chip { display: inline-block; font-size: 10.5px; font-weight: 700; padding: 1px 6px; border-radius: 5px; margin-right: 4px; color: #fff; vertical-align: 1px; }
    .lv-hero { display: grid; place-items: center; padding: 4px 0 2px; }
    .lv-hero img { width: min(300px, 86%); height: auto; }
    .lv-note { font-size: 12px; color: var(--muted); padding: 6px 2px 2px; }
    .lv-btn { margin-top: 6px; border: 0; background: #f6f1e7; color: #333; font-weight: 600; border-radius: 9px; padding: 8px 12px; cursor: pointer; font-size: 13px; }
    .lv-btn:hover { background: #efe8da; }
  `;
  document.head.appendChild(css);
  const pillEl = document.createElement('div');
  pillEl.id = 'live-pill';
  document.body.appendChild(pillEl);
  function pill(err) {
    if (!on) { pillEl.classList.remove('show'); return; }
    pillEl.classList.add('show');
    const age = FEED ? Math.max(0, Math.round(now() - FEED.t)) : null;
    const stale = err || !FEED || age > 180;
    pillEl.classList.toggle('stale', stale);
    pillEl.innerHTML = `<span class="dot"></span><b>LIVE</b>` + (FEED
      ? `<span>${FEED.v.length.toLocaleString('en-IN')} buses${stale ? ` · ${Math.round(age / 60)} min old` : ''}</span>`
      : `<span>${err ? 'live feed unavailable' : 'connecting…'}</span>`)
      + `<span class="key">${['diesel', 'dieselAC', 'ev', 'evAC'].map(k => `<span><i style="background:${BUSART.L[k].key}"></i>${BUSART.L[k].name}</span>`).join('')}</span>`;
  }
  setInterval(() => on && FEED && pill(), 15000);

  /* ── cards ── */
  const hhmm = t => new Date(t * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const inMin = t => { const m = Math.round((t - now()) / 60); return m <= 0 ? 'due' : `${m} min`; };
  const chips = fl => {
    const v = BUSART.L[lvOf(fl)];
    return `<span class="lv-chip" style="background:${v.key}">${v.name}</span>`
      + (fl.includes('l') ? `<span class="lv-chip" style="background:#6b6b6b">Low floor</span>` : '')
      + (fl.includes('x') ? `<span class="lv-chip" style="background:#b8860b">Express</span>` : '');
  };
  const ago = s => s < 90 ? `${Math.max(0, Math.round(s))} s` : `${Math.round(s / 60)} min`;

  function openBus(reg) {
    const tr = TRACK.get(reg); if (!tr) return;
    selReg = reg; cardBus = reg; cardStop = null;
    if (selStopMarker) { selStopMarker.remove(); selStopMarker = null; }
    showCard(); paintBus(reg); frame();
  }
  function paintBus(reg) {
    const tr = TRACK.get(reg);
    if (!tr) { $('card-body').innerHTML = '<div class="lv-note">This bus is no longer reporting.</div>'; return; }
    const [, code, , , , fix, fl, eta] = tr.v, sn = snOf(code), st = stopsOf(code) || [];
    const f = codeFeat(code), dest = f ? f.properties.destinatio : (st.length ? st[st.length - 1][1] : '');
    $('card-title').innerHTML = `${tagHTML(sn, f && f.properties.category)}<span class="ttl"><span>→ ${dest || ''}</span></span>`;
    $('card-sub').innerHTML = `Bus <b>${reg}</b> &middot; GPS ${ago(now() - fix)} ago<div style="margin-top:5px">${chips(fl)}</div>`;
    const t = now();
    const rows = eta.filter(([, et]) => et > t - 30).slice(0, 14).map(([i, et]) =>
      `<div class="lv-row"><span></span><span class="meta"><b>${(st[i] && st[i][1]) || 'Stop'}</b></span><span class="when">${inMin(et)}<small>${hhmm(et)}</small></span></div>`).join('');
    const facing = posOf(tr, now())[1];
    $('card-body').innerHTML = `<div class="lv-hero"><img alt="${BUSART.L[lvOf(fl)].name} bus" src="${BUSART.portrait(lvOf(fl), facing >= 180)}"></div>`
      + `<div class="seclbl">Next stops (predicted)</div>`
      + (rows || '<div class="lv-note">At the end of its trip.</div>')
      + `<button class="lv-btn" id="lv-route">Show route ${sn}</button>`;
    $('lv-route').addEventListener('click', () => { cardBus = null; selectRoute(sn, code); });
  }

  // which route-stop entries sit at this physical stop (stops are merged by location on the map)
  let STOP_GRID = null;
  function stopKeys(lon, lat) {
    if (!ROUTE_STOPS) return [];
    if (!STOP_GRID) {
      STOP_GRID = new Map();
      for (const [code, r] of Object.entries(ROUTE_STOPS)) {
        const s = r.d && r.d[0] ? r.d[0].s : [];
        s.forEach((x, i) => {
          const k = `${Math.round(x[2] * 500)},${Math.round(x[3] * 500)}`;
          if (!STOP_GRID.has(k)) STOP_GRID.set(k, []);
          STOP_GRID.get(k).push([code, i, x[2], x[3]]);
        });
      }
    }
    const out = [], gy = Math.round(lat * 500), gx = Math.round(lon * 500);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
      for (const e of STOP_GRID.get(`${gy + dy},${gx + dx}`) || [])
        if (Math.hypot((e[3] - lon) * K * Math.cos(lat * Math.PI / 180), (e[2] - lat) * K) < 70) out.push(e);
    return out;
  }
  function paintStopArrivals() {
    const box = $('lv-arrivals'); if (!box || !cardStop) return;
    if (!on) {
      box.innerHTML = `<div class="seclbl">Live arrivals</div><div class="lv-note">Live buses are switched off.</div><button class="lv-btn" id="lv-on">Show live buses</button>`;
      $('lv-on').addEventListener('click', () => setOn(true));
      return;
    }
    if (!FEED || ROUTE_STOPS === undefined) { box.innerHTML = `<div class="seclbl">Live arrivals</div><div class="lv-note">Loading live buses…</div>`; ensureStops().then(paintStopArrivals); return; }
    const keys = stopKeys(cardStop[0], cardStop[1]);
    const want = new Map(); keys.forEach(([code, i]) => { if (!want.has(code)) want.set(code, new Set()); want.get(code).add(i); });
    const t = now(), arr = [];
    for (const [reg, tr] of TRACK) {
      const s = want.get(tr.v[1]); if (!s) continue;
      for (const [i, et] of tr.v[7]) if (s.has(i) && et > t - 30 && et < t + 5400) { arr.push({ reg, code: tr.v[1], et, fl: tr.v[6] }); break; }
    }
    arr.sort((a, b) => a.et - b.et);
    const rows = arr.slice(0, 12).map(a => {
      const f = codeFeat(a.code), dest = f ? f.properties.destinatio : '';
      return `<div class="lv-row" data-reg="${a.reg}" style="cursor:pointer">${tagHTML(snOf(a.code), f && f.properties.category)}`
        + `<span class="meta">→ <b>${dest || ''}</b><br>${chips(a.fl)}${a.reg}</span>`
        + `<span class="when">${inMin(a.et)}<small>${hhmm(a.et)}</small></span></div>`;
    }).join('');
    box.innerHTML = `<div class="seclbl">Live arrivals · next 90 min</div>`
      + (rows || `<div class="lv-note">No tracked bus is due here in the next 90 minutes. Not every bus reports its position.</div>`)
      + (rows ? `<div class="lv-note">Predicted by Chennai One from each bus's GPS. Tap a bus to follow it.</div>` : '');
    box.querySelectorAll('[data-reg]').forEach(el => el.addEventListener('click', () => {
      const tr = TRACK.get(el.dataset.reg); if (!tr) return;
      openBus(el.dataset.reg);
      const [ll] = posOf(tr, now()); map.flyTo({ center: ll, zoom: Math.max(map.getZoom(), 14), duration: 700 });
    }));
  }

  // add a live section to every stop card
  const baseOpenStop = openStop;
  openStop = function (f) {
    baseOpenStop(f);
    cardBus = null; selReg = null;
    cardStop = f.geometry.coordinates;
    const box = document.createElement('div'); box.id = 'lv-arrivals'; box.style.marginBottom = '12px';
    $('card-body').prepend(box);
    paintStopArrivals();
  };
  $('card-close').addEventListener('click', () => { cardStop = cardBus = selReg = null; frame(); });
  const baseSelect = selectRoute;
  selectRoute = function (...a) { cardStop = cardBus = selReg = null; return baseSelect.apply(this, a); };

  /* ── toggle in the layer menu ── */
  const btn = document.createElement('button');
  btn.className = 'lyr' + (on ? ' on' : '');
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.9 16.1a10 10 0 0 1 0-14.2"/><path d="M7.8 13.2a6 6 0 0 1 0-8.4"/><circle cx="12" cy="9" r="2"/><path d="M16.2 4.8a6 6 0 0 1 0 8.4"/><path d="M19.1 1.9a10 10 0 0 1 0 14.2"/><path d="M9.5 22 12 13l2.5 9"/></svg><span>Live buses</span>`;
  $('layer-menu').prepend(btn);
  function setOn(v) {
    on = v; btn.classList.toggle('on', on);
    try { localStorage.setItem('mtcLive', on ? '1' : '0'); } catch (e) {}
    if (on) start(); else stop();
    if (cardStop) paintStopArrivals();
  }
  btn.addEventListener('click', e => { e.stopPropagation(); setOn(!on); });

  const boot = () => { if (on) start(); else pill(); };
  if (map.loaded() && map.getSource('routes')) boot(); else map.once('idle', boot);
})();
