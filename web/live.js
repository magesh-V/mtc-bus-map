/* Live buses — every MTC bus Chennai One is tracking, moving on the map.

   Data: live/vehicles.json, rewritten every ~20 s on the server by
   chennai_one/v36/live_collector.py, which cycles through the running routes at
   a polite rate. A full cycle takes minutes, so a bus's GPS fix can be a few
   minutes old — but each bus also carries the app's own predicted arrival at
   the stops ahead of it. A bus is therefore drawn by dead reckoning along its
   road-snapped route: from its last fix, through those predicted stop times.

   Two rules keep that honest (2026-10-20, after a field check that showed
   buses "confused about direction"):
     - a bus does not leave its fix before it has to. A bus waiting at a
       terminus for its next trip used to creep forward and then be pulled back
       by the next fix, sliding backwards on screen;
     - a bus is never drawn moving backwards. If a new fix shows the forecast
       ran ahead, the bus waits on the spot until reality catches up.
   On the archive, buses really do move along their listed working 71 % of the
   time and backwards only 1.4 %, so the route direction itself is right.

   Rendering is a WebGL custom layer, not a GeoJSON source: re-tiling a GeoJSON
   of thousands of points every frame is what made the page hot on phones.
   Positions are computed only for buses in (or near) view, the frame rate
   follows the zoom (a refresh every 2 s for the whole city, ~25 fps on a
   street), and nothing runs while the tab is hidden. Moving buses glow in
   their livery colour; AC buses carry a snowflake.

   Row (fmt 2): [reg, routeCode, lat, lon, bearing, fixEpoch, flags, [i, dt, i, dt, ...]]
   with dt seconds after the fix; older files carry [[i, etaEpoch], ...].
   i indexes ROUTE_STOPS[routeCode].d[0].s; flags a=AC e=electric l=low floor
   x=express p=premium u=waiting for its next trip.

   Loaded after app.js and buses.js; shares app.js's script scope (map,
   ROUTE_IDX, ROUTE_STOPS, openStop, selectRoute, showCard, tagHTML, $). */
'use strict';
(() => {
  const URL_ = 'live/vehicles.json', K = 111320;
  const MOBILE = matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency || 8) <= 4;
  const SAVE = !!(navigator.connection && navigator.connection.saveData);
  const CALM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const POLL_MS = MOBILE || SAVE ? 40000 : 20000;
  const lvOf = fl => BUSART.of(fl), lvCol = fl => BUSART.L[lvOf(fl)].key;
  let on = (() => { try { return localStorage.getItem('mtcLive') !== '0'; } catch (e) { return true; } })();
  let FEED = null, pollT = null, running = false, CODE_FEAT = null;
  const fetchT0 = Date.now();
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
    const n = coords.length, xs = new Float64Array(n), ys = new Float64Array(n), cum = new Float64Array(n);
    for (let i = 0; i < n; i++) { xs[i] = coords[i][0] * cx; ys[i] = coords[i][1] * K; if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]); }
    return { xs, ys, cum, cx, n };
  }
  // nearest point on the line between vertices [i0, i1]; returns {d, off, i}
  function project(g, lon, lat, i0 = 0, i1 = g.n - 1) {
    const px = lon * g.cx, py = lat * K;
    let bd = 0, bo = Infinity, bi = i0;
    for (let i = Math.max(0, i0), e = Math.min(i1, g.n - 1); i < e; i++) {
      const ax = g.xs[i], ay = g.ys[i], dx = g.xs[i + 1] - ax, dy = g.ys[i + 1] - ay, L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
      const o = Math.hypot(ax + t * dx - px, ay + t * dy - py);
      if (o < bo) { bo = o; bd = g.cum[i] + t * Math.sqrt(L); bi = i; }
    }
    return { d: bd, off: bo, i: bi };
  }
  function xy(g, d, out) {
    const c = g.cum, n = g.n;
    d = d < 0 ? 0 : d > c[n - 1] ? c[n - 1] : d;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= d) lo = m; else hi = m; }
    const t = (d - c[lo]) / ((c[hi] - c[lo]) || 1);
    out[0] = g.xs[lo] + t * (g.xs[hi] - g.xs[lo]); out[1] = g.ys[lo] + t * (g.ys[hi] - g.ys[lo]);
  }
  /* Where the bus is and which way its nose points: the heading is taken over
     the road just behind to just ahead, so it swings through a bend instead of
     snapping at every vertex. Writes lon, lat, heading into out. */
  const _a = [0, 0], _b = [0, 0], _c = [0, 0];
  function at(g, d, out) {
    xy(g, d, _a); xy(g, d - 18, _b); xy(g, d + 32, _c);
    out[0] = _a[0] / g.cx; out[1] = _a[1] / K;
    out[2] = (Math.atan2(_c[0] - _b[0], _c[1] - _b[1]) * 180 / Math.PI + 360) % 360;
  }
  // route line + where along it each stop sits; only built for buses in view
  function geo(code) {
    if (GEO.has(code)) return GEO.get(code);
    const f = codeFeat(code), st = stopsOf(code);
    if (!st || st.length < 2 || !CODE_FEAT) return null;
    let coords = f && f.geometry && (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.coordinates);
    if (!coords || coords.length < 2) coords = st.map(s => [s[3], s[2]]);
    const g = prep(coords);
    let seg = 0, prev = 0;
    g.stopD = st.map(s => {
      // search a window ahead of the previous stop first; the whole line only if that misses
      let p = project(g, s[3], s[2], seg, seg + 400);
      if (p.off > 80) { const q = project(g, s[3], s[2]); if (q.off < p.off - 40) p = q; }
      const d = Math.max(prev, p.d); prev = d; seg = Math.max(seg, p.i);
      return d;
    });
    GEO.set(code, g);
    return g;
  }

  /* ── tracks: (time, distance) knots per bus, built lazily when in view ── */
  const CRUISE = 5.5;                 // m/s, ~20 km/h: how long a bus needs to reach its next stop
  function makeTrack(tr) {
    tr.ready = true;
    const [, code, lat, lon, , fix, fl, eta] = tr.v;
    const g = geo(code);
    if (!g) { tr.ready = !(ROUTE_STOPS && CODE_FEAT); return; }   // retry once data has loaded
    tr.g = g;
    if (!eta.length) return;
    const first = g.stopD[eta[0][0]];
    if (first == null) return;
    let segMax = 1;
    while (segMax < g.n - 1 && g.cum[segMax] < first) segMax++;
    const p = project(g, lon, lat, 0, segMax + 1);
    if (p.off > 150) return;          // off its route (depot, diversion): drawn at the GPS fix
    const d0 = Math.min(p.d, first), knots = [[fix, d0]];
    for (const [i, t] of eta) {
      const d = g.stopD[i], last = knots[knots.length - 1];
      if (d == null || t <= last[0] || d < last[1]) continue;
      knots.push([t, d]);
    }
    // leave the fix only when it must to make the first predicted stop
    if (knots.length > 1) {
      const need = (knots[1][1] - d0) / CRUISE;
      knots[0][2] = Math.max(fix, knots[1][0] - need);
    }
    tr.knots = knots;
    tr.upcoming = fl.includes('u');
  }
  /* Distance along the route at time t: dwell at each stop, smoothstep between
     stops, and never less than what is already on screen (tr.hold). */
  const DWELL = 14;
  function dOf(tr, t) {
    const k_ = tr.knots;
    let d = k_[0][1];
    if (t >= k_[k_.length - 1][0]) d = k_[k_.length - 1][1];
    else if (t > k_[0][0]) {
      for (let k = 1; k < k_.length; k++) {
        if (t <= k_[k][0]) {
          const [t0, d0] = k_[k - 1], [t1, d1] = k_[k];
          const dep = k > 1 ? t0 + Math.min(DWELL, 0.3 * (t1 - t0)) : (k_[0][2] || t0);
          const u = Math.max(0, Math.min(1, (t - dep) / ((t1 - dep) || 1)));
          d = d0 + (d1 - d0) * (k > 1 ? u * u * (3 - 2 * u) : u * (2 - u));
          break;
        }
      }
    }
    if (tr.hold != null) { if (d < tr.hold) d = tr.hold; else tr.hold = null; }
    return d;
  }
  const _p = [0, 0, 0];
  function posOf(tr, t, out = _p) {
    if (!tr.ready) makeTrack(tr);
    if (!tr.knots) { out[0] = tr.v[3]; out[1] = tr.v[2]; out[2] = tr.v[4] || 0; return out; }
    tr.lastD = dOf(tr, t);
    at(tr.g, tr.lastD, out);
    return out;
  }

  function parse(j) {
    // fmt 2 ships eta as [i, dt, i, dt ...]; expand to [[i, epoch], ...] once per poll
    if (j.fmt === 2) for (const v of j.v) {
      const f = v[7], out = [];
      for (let k = 0; k + 1 < f.length; k += 2) out.push([f[k], v[5] + f[k + 1]]);
      v[7] = out;
    }
    return j;
  }
  function ingest(j) {
    const t = now(), prev = new Map(TRACK);
    TRACK.clear();
    for (const v of j.v) {
      const tr = { v, ready: false, g: null, knots: null, lastD: null, hold: null, moving: 0 };
      const old = prev.get(v[0]);
      if (old && old.v[1] === v[1] && old.lastD != null) {
        // same bus, same working, drawn before: keep it from jumping backwards
        posOf(tr, t, [0, 0, 0]);
        if (tr.knots && tr.lastD < old.lastD - 25 && old.lastD - tr.lastD < 1500) tr.hold = old.lastD;
        tr.moving = old.moving;
      }
      TRACK.set(v[0], tr);
    }
  }

  /* ── crowding (estimated) ──
     No crowd or ticket counts are published for MTC buses, and Chennai One's
     crowd field is empty. What is real and hourly: when the city travels —
     CMRL's ticket entries by hour (weekday and weekend averages over 44 days
     of the CMRL Commuter Archive, Sept–Oct 2026) — and how many buses each
     working runs in that hour (its timetable). Crowding is the ratio of the
     two: the hour's share of the day's riders over the hour's share of the
     route's buses. A route that runs few buses at 9 am rates crowded; one
     with a big peak fleet does not. An estimate, labelled as one. */
  const DEM_WD = [0.01, 0, 0, 0, 0.27, 0.93, 2.41, 3.92, 7.53, 11.08, 7.71, 4.39, 4.16, 4.67, 5.17, 4.44, 4.86, 6.73, 10.12, 9.44, 6.16, 3.69, 1.83, 0.47];
  const DEM_WE = [0.01, 0, 0, 0, 0.39, 1.35, 2.61, 3.56, 4.81, 6.18, 6.33, 5.54, 5.57, 5.62, 6.74, 6.49, 6.77, 7.33, 8.4, 7.94, 6.16, 4.67, 2.81, 0.71];
  const CROWD_NAMES = ['Seats free', 'Seats taken', 'Standing room only'];
  let timingsAsked = false;
  function ensureTimings() {
    if (TIMINGS !== undefined || timingsAsked) return;
    timingsAsked = true;
    fetch(`data/timings.json?v=${DATA_V}`).then(r => r.ok ? r.json() : {}).then(j => { if (TIMINGS === undefined) TIMINGS = j; crowdCache.clear(); }).catch(() => {});
  }
  function crowdRatio(code, h, weekend) {
    const tm = TIMINGS && TIMINGS[code]; if (!tm || !tm.hours) return null;
    const S = tm.hours, tot = S.reduce((a, b) => a + b, 0); if (!tot) return null;
    const sup = (S[h] * 0.5 + (S[(h + 23) % 24] + S[(h + 1) % 24]) * 0.25) / tot;
    const dem = (weekend ? DEM_WE : DEM_WD)[h] / 100;
    return Math.min(3, dem / Math.max(sup, 0.5 / tot));
  }
  const crowdCache = new Map();
  function crowdOf(code, h) {
    const k = code + ':' + h;
    if (crowdCache.has(k)) return crowdCache.get(k);
    const d = new Date(Date.now() + 19800000), we = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    const r = crowdRatio(code, h, we);
    const out = r == null ? null : { r, level: r < 0.75 ? 0 : r < 1.3 ? 1 : 2, p: 1 / (1 + Math.exp(-(r - 1.15) * 3.5)), we };
    if (TIMINGS) crowdCache.set(k, out);
    return out;
  }
  const PEOPLE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
  const CROWD_COL = ['#2fa35a', '#e0a100', '#d6402b'];

  /* ── WebGL layer ── */
  const VS = `
    attribute vec2 a_pos; attribute vec2 a_off; attribute vec2 a_uv; attribute float a_rot; attribute vec4 a_col;
    uniform mat4 u_matrix; uniform vec2 u_view; uniform float u_bearing;
    varying vec2 v_uv; varying vec4 v_col;
    void main() {
      vec4 p = u_matrix * vec4(a_pos, 0.0, 1.0);
      float r = radians(a_rot) - u_bearing * step(-500.0, a_rot);
      if (a_rot < -500.0) r = 0.0;
      vec2 o = vec2(a_off.x * cos(r) - a_off.y * sin(r), a_off.x * sin(r) + a_off.y * cos(r));
      p.xy += vec2(o.x, -o.y) * 2.0 / u_view * p.w;
      gl_Position = p; v_uv = a_uv; v_col = a_col;
    }`;
  const FS = `
    precision mediump float; uniform sampler2D u_tex; varying vec2 v_uv; varying vec4 v_col;
    void main() { gl_FragColor = texture2D(u_tex, v_uv) * v_col; }`;
  const STRIDE = 12;                       // pos2 off2 uv2 rot1 col4 + pad1
  let vbuf = new Float32Array(STRIDE * 6 * 4096), nverts = 0, ref = [0.5, 0.5], UV = null;
  const hex = h => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
  const COLS = {};
  const mercX = lng => (lng + 180) / 360;
  const mercY = lat => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))) / 360;

  function quad(mx, my, w, h, uv, rot, r, g, b, a, dy = 0, dx = 0) {
    if ((nverts + 6) * STRIDE > vbuf.length) { const nb = new Float32Array(vbuf.length * 2); nb.set(vbuf); vbuf = nb; }
    const x0 = -w / 2 + dx, x1 = w / 2 + dx, y0 = -h / 2 + dy, y1 = h / 2 + dy;
    const P = [[x0, y0, uv[0], uv[1]], [x1, y0, uv[2], uv[1]], [x1, y1, uv[2], uv[3]], [x0, y0, uv[0], uv[1]], [x1, y1, uv[2], uv[3]], [x0, y1, uv[0], uv[3]]];
    for (const [ox, oy, u, v] of P) {
      const o = nverts++ * STRIDE;
      vbuf[o] = mx; vbuf[o + 1] = my; vbuf[o + 2] = ox; vbuf[o + 3] = oy; vbuf[o + 4] = u; vbuf[o + 5] = v;
      vbuf[o + 6] = rot; vbuf[o + 7] = r * a; vbuf[o + 8] = g * a; vbuf[o + 9] = b * a; vbuf[o + 10] = a;
    }
  }

  const glLayer = {
    id: 'live-gl', type: 'custom', renderingMode: '2d',
    onAdd(m, gl) {
      const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); return s; };
      const pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
      this.pr = pr; this.buf = gl.createBuffer();
      this.loc = {};
      for (const a of ['a_pos', 'a_off', 'a_uv', 'a_rot', 'a_col']) this.loc[a] = gl.getAttribLocation(pr, a);
      for (const u of ['u_matrix', 'u_view', 'u_bearing', 'u_tex']) this.loc[u] = gl.getUniformLocation(pr, u);
      const at = BUSISO.atlas(MOBILE ? 1.0 : 1.25, MOBILE ? 2048 : 4096); UV = at.uv;
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, at.canvas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.dirty = true;
    },
    render(gl, matrix) {
      if (!on || !nverts) return;
      const l = this.loc;
      gl.useProgram(this.pr);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      if (this.dirty) { gl.bufferData(gl.ARRAY_BUFFER, vbuf.subarray(0, nverts * STRIDE), gl.DYNAMIC_DRAW); this.dirty = false; }
      const F = 4;
      const attr = (n, size, off) => { gl.enableVertexAttribArray(l[n]); gl.vertexAttribPointer(l[n], size, gl.FLOAT, false, STRIDE * F, off * F); };
      attr('a_pos', 2, 0); attr('a_off', 2, 2); attr('a_uv', 2, 4); attr('a_rot', 1, 6); attr('a_col', 4, 7);
      // positions are relative to `ref` for float precision; fold the offset into the matrix
      const M = Array.from(matrix), rx = ref[0], ry = ref[1];
      M[12] = matrix[0] * rx + matrix[4] * ry + matrix[12]; M[13] = matrix[1] * rx + matrix[5] * ry + matrix[13];
      M[14] = matrix[2] * rx + matrix[6] * ry + matrix[14]; M[15] = matrix[3] * rx + matrix[7] * ry + matrix[15];
      gl.uniformMatrix4fv(l.u_matrix, false, new Float32Array(M));
      const cv = map.getCanvas();
      gl.uniform2f(l.u_view, cv.clientWidth, cv.clientHeight);
      gl.uniform1f(l.u_bearing, map.getBearing() * Math.PI / 180);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex); gl.uniform1i(l.u_tex, 0);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, nverts);
    },
  };

  /* ── per-update: positions of buses in view -> vertex buffer ── */
  const lerp = (z, pts) => { if (z <= pts[0][0]) return pts[0][1]; for (let i = 1; i < pts.length; i++) if (z <= pts[i][0]) { const [z0, a] = pts[i - 1], [z1, b] = pts[i]; return a + (b - a) * (z - z0) / (z1 - z0); } return pts[pts.length - 1][1]; };
  const fl0 = v => v[6] || '';
  let VIS = [];                            // [reg, lng, lat, halfSize] of what was drawn, for clicks and labels
  const P3 = [0, 0, 0];
  function update() {
    if (!on || !FEED || !UV) return;
    const t = now(), z = map.getZoom(), b = map.getBounds();
    const padX = (b.getEast() - b.getWest()) * 0.2 + 0.01, padY = (b.getNorth() - b.getSouth()) * 0.2 + 0.01;
    const W = b.getWest() - padX, E = b.getEast() + padX, S_ = b.getSouth() - padY, N = b.getNorth() + padY;
    const city = z < 11.5, bearing = map.getBearing();
    // 3D sprites: CW x CH logical px, anchored where the wheels meet the road
    const s = lerp(z, [[9, 0.16], [12, 0.22], [14, 0.38], [16, 0.62], [18, 1.0]]);
    const [CW, CH] = BUSISO.CELL, [, AY] = BUSISO.ANCHOR;
    const bw = CW * s, bh = CH * s, lift = -(AY - CH / 2) * s;
    const glowR = 12 * 9 * s * 1.35;
    const snowZ = z >= 12.5, snowPx = lerp(z, [[12.5, 10], [15, 14], [18, 18]]);
    const hourNow = new Date(Date.now() + 19800000).getUTCHours();
    const pulseT = CALM ? 0 : t * 2.4;
    ref = [mercX((b.getWest() + b.getEast()) / 2), mercY((b.getNorth() + b.getSouth()) / 2)];
    const glows = [], buses = [], snows = [], zzs = [];
    VIS = [];
    for (const [reg, tr] of TRACK) {
      const v = tr.v;
      // cull on the fix first (cheap); a bus moves a few km at most between polls
      if (reg !== selReg && (v[3] < W - 0.05 || v[3] > E + 0.05 || v[2] < S_ - 0.05 || v[2] > N + 0.05)) continue;
      if (reg !== selReg && !passes(v[6])) continue;
      const prevD = tr.lastD;
      if (city && !tr.ready) {
        // city view: the GPS fix as-is — no route geometry built, nothing to animate
        P3[0] = v[3]; P3[1] = v[2]; P3[2] = v[4] || 0;
        if (!fl0(v).includes('u')) tr.moving = t;
      } else posOf(tr, t, P3);
      const lng = P3[0], lat = P3[1], h = P3[2];
      if (reg !== selReg && (lng < W || lng > E || lat < S_ || lat > N)) continue;
      if (tr.lastD != null && prevD != null && tr.lastD - prevD > 0.05) tr.moving = t; // moved since last update
      const mx = mercX(lng) - ref[0], my = mercY(lat) - ref[1];
      const fl = v[6], lv = lvOf(fl), col = COLS[lv] || (COLS[lv] = hex(BUSART.L[lv].key));
      const isMoving = t - (tr.moving || 0) < 3, sel = reg === selReg;
      if (isMoving || sel) {
        const ph = (reg.charCodeAt(1) * 7 + reg.charCodeAt(reg.length - 1) * 13) % 628 / 100;
        const a = sel ? 0.55 : (0.30 + 0.14 * Math.sin(pulseT + ph)) * (z < 12 ? 0.6 : 1);
        glows.push([mx, my, glowR * (sel ? 1.5 : 1), col, a]);
      }
      const dir = Math.round((((h - bearing) % 360 + 360) % 360) / 22.5) % 16;
      const cr = crowdOf(v[1], hourNow), lvl = cr ? cr.level : 1;
      buses.push([mx, my, `${lv}:${dir}:${lvl}`]);
      // parked at a terminus (or waiting for its next trip): it sleeps
      if (z >= 13 && t - (tr.moving || 0) > 90) {
        const st = stopsOf(v[1]);
        let sleep = fl.includes('u');
        if (!sleep && st && st.length > 1) {
          const cx = K * Math.cos(lat * Math.PI / 180), far = s_ => Math.hypot((s_[3] - lng) * cx, (s_[2] - lat) * K);
          sleep = Math.min(far(st[0]), far(st[st.length - 1])) < 250;
        }
        if (sleep) zzs.push([mx, my, (reg.charCodeAt(reg.length - 1) % 10) / 10]);
      }
      if (snowZ && fl.includes('a')) snows.push([mx, my, -(AY * s + snowPx * 0.55)]);
      VIS.push([reg, lng, lat, Math.max(14, 12 * 9 * s * 0.45)]);
    }
    nverts = 0;
    for (const [mx, my, r, c, a] of glows) quad(mx, my, r, r, UV.glow, -1000, c[0], c[1], c[2], a);
    buses.sort((p, q) => p[1] - q[1]);              // back to front: farther (higher on screen) first
    for (const [mx, my, key] of buses) quad(mx, my, bw, bh, UV[key], -1000, 1, 1, 1, 1, lift);
    for (const [mx, my, dy] of snows) quad(mx, my, snowPx, snowPx, UV.snow, -1000, 1, 1, 1, 1, dy);
    // three z's drifting up and fading, out of phase with each other and other buses
    if (UV.zzz) for (const [mx, my, ph0] of zzs) for (let k = 0; k < 3; k++) {
      const ph = ((CALM ? 0.5 : t * 0.45) + k / 3 + ph0) % 1, sz = (10 + 10 * ph) * Math.max(1, s * 1.8);
      quad(mx, my, sz, sz, UV.zzz, -1000, 1, 1, 1, Math.sin(Math.PI * ph) * 0.95, -(AY * s + 4 + 26 * ph), 6 + 12 * ph);
    }
    glLayer.dirty = true;
    map.triggerRepaint();
  }

  // route numbers: a light symbol layer, refreshed twice a second, street zooms only
  let lastLabel = 0;
  function labels(force) {
    const src = map.getSource('live-lbl'); if (!src) return;
    const z = map.getZoom(), t = performance.now();
    if (!force && t - lastLabel < 500) return;
    lastLabel = t;
    const feats = z < 14 || !on ? [] : VIS.slice(0, 400).map(([reg, lng, lat]) => {
      const tr = TRACK.get(reg);
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { sn: snOf(tr.v[1]), c: lvCol(tr.v[6]) } };
    });
    src.setData({ type: 'FeatureCollection', features: feats });
  }

  /* Pace: how often bus positions are recomputed. The map itself redraws on
     every pan or zoom regardless; this is only the animation clock. */
  function interval() {
    const z = map.getZoom();
    if (CALM || SAVE) return 3000;
    if (z < 11) return 2000;
    if (z < 13) return MOBILE ? 500 : 250;
    return MOBILE ? 50 : 33;
  }
  let lastU = 0;
  function loop(ts) {
    if (!running) return;
    requestAnimationFrame(loop);
    if (document.hidden || !FEED) return;
    if (ts - lastU < interval()) return;
    lastU = ts;
    update(); labels();
  }
  map.on('moveend', () => { if (running) { update(); labels(true); } });

  function addLayers() {
    if (map.getLayer('live-gl')) return;
    map.addLayer(glLayer);
    map.addSource('live-lbl', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'live-num', type: 'symbol', source: 'live-lbl', minzoom: 14,
      layout: { 'text-field': ['get', 'sn'], 'text-font': ['Noto Sans Bold'], 'text-size': 11,
        'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-optional': true, 'text-padding': 1 },
      paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#fff', 'text-halo-width': 1.6 } });
  }
  // clicks: the nearest drawn bus within reach of the tap
  function busAt(p) {
    if (!on || !running) return null;
    let best = null, bd = Infinity;
    for (const [reg, lng, lat, half] of VIS) {
      const q = map.project([lng, lat]), d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < Math.max(14, half) && d < bd) { bd = d; best = reg; }
    }
    return best;
  }
  window.liveBusAt = p => !!busAt(p);
  map.on('click', e => { const r = busAt(e.point); if (r) openBus(r); });
  let hoverT = 0;
  map.on('mousemove', e => {
    if (performance.now() - hoverT < 80) return; hoverT = performance.now();
    if (busAt(e.point)) map.getCanvas().style.cursor = 'pointer';
    else if (map.getCanvas().style.cursor === 'pointer' && !map.queryRenderedFeatures(e.point).length) map.getCanvas().style.cursor = '';
  });
  const snOf = code => { const f = codeFeat(code); return f ? (f.properties.sn || f.properties.route_name) : code; };

  /* ── polling ── */
  function poll() {
    if (document.hidden) return;
    fetch(`${URL_}?t=${Math.floor(Date.now() / 10000)}`).then(r => r.ok ? r.json() : null).then(j => {
      if (!j || !Array.isArray(j.v)) throw 0;
      FEED = parse(j);
      ingest(FEED); update(); labels(true); pill();
      if (cardStop) paintStopArrivals();
      if (cardBus) paintBus(cardBus, false);
    }).catch(() => { pill(true); });
  }
  function ensureStops() {
    if (ROUTE_STOPS !== undefined) return Promise.resolve();
    return fetch(`data/route_stops.json?v=${DATA_V}`).then(r => r.ok ? r.json() : {}).then(j => { if (ROUTE_STOPS === undefined) ROUTE_STOPS = j; })
      .catch(() => {});
  }
  function start() {
    ensureTimings();
    addLayers();
    map.setLayoutProperty('live-num', 'visibility', 'visible');
    ensureStops().then(() => { for (const tr of TRACK.values()) tr.ready = false; GEO.clear(); });
    poll();
    clearInterval(pollT);
    pollT = setInterval(poll, POLL_MS);
    if (!running) { running = true; requestAnimationFrame(loop); }
    pill();
  }
  function stop() {
    clearInterval(pollT); pollT = null; running = false;
    nverts = 0; VIS = []; map.triggerRepaint();
    if (map.getLayer('live-num')) { map.setLayoutProperty('live-num', 'visibility', 'none'); }
    pill();
    if (cardStop) paintStopArrivals();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && on) poll(); });

  /* ── filters in the top pill: tap a bus type to hide or show it, or show
     only wheelchair-accessible buses. LIVE itself stays a status. ── */
  const GROUPS = [['diesel', 'bus', 'Diesel'], ['dieselAC', 'snow', 'AC'], ['ev', 'bolt', 'Electric'], ['evAC', 'bolt', 'Electric AC']];
  const groupOf = fl => { const lv = lvOf(fl); return lv === 'premium' ? 'evAC' : lv; };
  const FILT = (() => { try { const j = JSON.parse(localStorage.getItem('mtcLiveFilter') || '{}'); return { off: j.off || [], wc: !!j.wc }; } catch (e) { return { off: [], wc: false }; } })();
  const saveFilt = () => { try { localStorage.setItem('mtcLiveFilter', JSON.stringify(FILT)); } catch (e) {} };
  const passes = fl => !FILT.off.includes(groupOf(fl)) && (!FILT.wc || fl.includes('l'));
  const filtered = () => FILT.off.length > 0 || FILT.wc;

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
    @keyframes lpulse { 70% { box-shadow: 0 0 0 7px rgba(240,27,72,0); } 100% { box-shadow: 0 0 0 0 rgba(240,27,72,0); } }
    @media (prefers-reduced-motion: reduce) { #live-pill .dot { animation: none; } }
    .lv-row { display: grid; grid-template-columns: auto 1fr auto; gap: 4px 10px; align-items: center; padding: 7px 2px; border-bottom: 1px solid #efe9de; }
    .lv-row:last-child { border-bottom: 0; }
    .lv-row .when { font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
    .lv-row .when small { display: block; font-weight: 400; color: var(--muted); font-size: 11px; }
    .lv-row .meta { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lv-row .meta b { color: #333; font-weight: 600; }
    .lv-chip { display: inline-block; font-size: 10.5px; font-weight: 700; padding: 1px 6px; border-radius: 5px; margin-right: 4px; color: #fff; vertical-align: 1px; }
    .lv-hero { display: grid; place-items: center; padding: 4px 0 2px; }
    .lv-hero img { width: min(300px, 86%); height: auto; }
    .lv-crowd { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 13px; padding: 2px 2px 8px; }
    .lv-crowd span:last-child { color: var(--muted); font-size: 12px; }
    .lv-bars { display: flex; align-items: flex-end; gap: 2px; height: 46px; padding: 0 2px; }
    .lv-bars i { flex: 1; border-radius: 2px 2px 0 0; min-height: 2px; }
    .lv-axis { display: flex; justify-content: space-between; font-size: 10px; color: var(--muted); padding: 3px 2px 0; font-variant-numeric: tabular-nums; }
    .lv-hero img { width: min(230px, 66%); margin: -14px 0 -10px; }
    #card .chead { padding-right: 84px; }
    #card .lv-share { right: 48px; display: none; place-items: center; }
    #card .lv-share.on { display: grid; }
    #lv-toast { position: fixed; left: 50%; bottom: calc(28px + env(safe-area-inset-bottom)); transform: translate(-50%, 20px); opacity: 0; z-index: 950;
      background: #1c1c1e; color: #fff; font-size: 13px; padding: 9px 14px; border-radius: 999px; transition: opacity .2s, transform .2s; pointer-events: none; }
    #lv-toast.show { opacity: 1; transform: translate(-50%, 0); }
    .lv-busline { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 2px; }
    #lv-busbar { margin-bottom: 10px; }
    #lv-busbar .lv-report { margin-top: 0; }
    .rail.lv-live li.passed .rl.out .dot { background: var(--red); }
    .rail.lv-live li.passed .lbl.out .nm { color: #9a958b; }
    .rail.lv-live li.next .rl.out .dot { background: var(--red); animation: lvblink 1.1s ease-in-out infinite; }
    .rail.lv-live li.next .lbl.out .nm { color: var(--red); font-weight: 800; }
    @keyframes lvblink { 0%, 100% { box-shadow: 0 0 0 0 rgba(240,27,72,.55); background: var(--red); } 50% { box-shadow: 0 0 0 7px rgba(240,27,72,0); background: #fff; } }
    .rail.lv-live .cap.next .capdot { animation: lvblink 1.1s ease-in-out infinite; }
    .lv-eta { display: block; font-size: 11px; font-weight: 700; color: var(--red); font-variant-numeric: tabular-nums; margin-top: 1px; }
    .rail.lv-live li:not(.next) .lv-eta { color: var(--muted); font-weight: 600; }
    @media (prefers-reduced-motion: reduce) { .rail.lv-live li.next .rl.out .dot, .rail.lv-live .cap.next .capdot { animation: none; } }
    .lv-ico { display: inline-grid; place-items: center; width: 19px; height: 19px; border-radius: 6px; color: #fff; margin-right: 4px; vertical-align: -4px; }
    .lv-ico.ac { color: #1677d2; box-shadow: inset 0 0 0 1.2px #8cc6f5; }
    .lv-ico.ac svg { stroke-width: 2.4; }
    .lv-f[data-g="dieselAC"] i { background: #e4f3ff !important; color: #1677d2; box-shadow: inset 0 0 0 1px #8cc6f5; }
    .lv-f[data-g="dieselAC"].off i { background: #cfcac0 !important; color: #fff; box-shadow: none; }
    #live-pill { pointer-events: auto; max-width: calc(100vw - 150px); }
    #live-pill .lv-live { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
    #live-pill .key { display: flex; gap: 3px; margin-left: 2px; color: #555; overflow-x: auto; scrollbar-width: none; }
    #live-pill .key::-webkit-scrollbar { display: none; }
    .lv-f { display: inline-flex; align-items: center; gap: 4px; border: 0; background: none; font: inherit; font-size: 12px; color: #444; padding: 3px 6px; border-radius: 999px; cursor: pointer; white-space: nowrap; }
    .lv-f:hover { background: #f1ece2; }
    .lv-f i { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 5px; color: #fff; }
    .lv-f.off { color: #aaa; text-decoration: line-through; }
    .lv-f.off i { background: #cfcac0 !important; }
    .lv-f.wc { border: 1px solid #d9e3f7; }
    .lv-f.wc.on { background: #1f5fd6; color: #fff; border-color: #1f5fd6; }
    @media (max-width: 640px) { .lv-f span { display: none; } .lv-f { padding: 3px 4px; } }
    .lv-stop { cursor: pointer; border-radius: 8px; transition: background .15s; }
    .lv-stop:hover, .lv-stop:focus-visible { background: #f3eee4; outline: none; }
    .lv-pin { color: #f01b48; display: inline-flex; }
    .lv-report { display: inline-flex; align-items: center; gap: 5px; float: right; margin: -6px 0 0; border: 1px solid #e3dccd; background: #fff; color: #444;
      font: inherit; font-size: 12px; font-weight: 600; border-radius: 999px; padding: 4px 10px; cursor: pointer; }
    .lv-report:hover { border-color: #f01b48; color: #f01b48; }
    .lv-stophead { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 2px 0 6px; }
    .lv-backbtn { display: inline-flex; align-items: center; gap: 5px; border: 0; background: #f3eee4; color: #333; font: inherit; font-size: 12.5px; font-weight: 600; border-radius: 999px; padding: 5px 11px; cursor: pointer; }
    .lv-said { display: flex; align-items: center; gap: 6px; font-size: 12.5px; padding: 4px 2px; color: #333; }
    .lv-said span { margin-left: auto; color: var(--muted); font-size: 11.5px; white-space: nowrap; }
    #card { transition: opacity .17s ease, transform .17s ease; }
    #card.lv-out { opacity: 0; transform: translateX(14px); }
    #card.lv-in { animation: lvin .26s cubic-bezier(.32,.72,0,1); }
    @keyframes lvin { from { opacity: 0; transform: translateX(-14px); } to { opacity: 1; transform: none; } }
    #lv-sheet { position: fixed; inset: 0; z-index: 900; background: rgba(20,20,24,.32); display: none; align-items: flex-end; justify-content: center; }
    #lv-sheet.open { display: flex; animation: lvfade .18s ease; }
    @keyframes lvfade { from { opacity: 0; } }
    .lv-sheetbox { width: min(440px, 100%); max-height: 86vh; overflow: auto; background: #fffdf8; border-radius: 20px 20px 0 0; padding: 14px 16px calc(18px + env(safe-area-inset-bottom));
      box-shadow: 0 -10px 40px rgba(0,0,0,.2); animation: lvup .26s cubic-bezier(.32,.72,0,1); }
    @media (min-width: 700px) { #lv-sheet { align-items: center; } .lv-sheetbox { border-radius: 20px; } }
    @keyframes lvup { from { transform: translateY(40px); opacity: 0; } }
    .lv-sheethead { display: grid; grid-template-columns: 32px 1fr 32px; align-items: center; text-align: center; font-size: 16px; }
    .lv-x { border: 0; background: #f3eee4; width: 30px; height: 30px; border-radius: 50%; cursor: pointer; display: grid; place-items: center; font-size: 14px; color: #444; }
    .lv-sub { text-align: center; font-size: 12.5px; color: var(--muted); margin: 6px 0 10px; }
    .lv-glabel { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 12px 2px 6px; }
    .lv-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; }
    .lv-tiles.two { grid-template-columns: 1fr 1fr; margin-top: 12px; }
    .lv-tile { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; min-height: 84px; padding: 10px 8px; border: 1.5px solid #e7e0d2;
      background: #fff; border-radius: 14px; font: inherit; font-size: 13px; font-weight: 600; color: #222; cursor: pointer; text-align: center; transition: transform .08s, border-color .15s; }
    .lv-tile:hover { border-color: #f01b48; }
    .lv-tile:active { transform: scale(.96); }
    .lv-tile svg { color: #f01b48; }
    .lv-thanks { display: flex; gap: 12px; align-items: center; font-size: 13.5px; color: #333; padding: 6px 2px; }
    .lv-thanks svg { color: #2fa35a; flex: none; }
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
    const paused = FEED && FEED.v.length === 0;               // the collector has no buses (source down or paused)
    const stale = err || !FEED || age > 180 || paused;
    pillEl.classList.toggle('stale', stale);
    const shown = FEED ? FEED.v.filter(v => passes(v[6])).length : 0;
    const count = FEED ? (filtered() ? `${shown.toLocaleString('en-IN')} of ${FEED.v.length.toLocaleString('en-IN')}` : FEED.v.length.toLocaleString('en-IN')) + ' buses' : '';
    pillEl.innerHTML = `<span class="lv-live"><span class="dot"></span><b>LIVE</b>` + (paused
      ? `<span>paused — reconnecting to the live feed</span>`
      : FEED ? `<span>${count}${stale ? ` · ${Math.round(age / 60)} min old` : ''}</span>`
      : `<span>${err ? 'live feed unavailable' : 'connecting…'}</span>`) + `</span>`
      + `<span class="key">${GROUPS.map(([g, icon, name]) => `<button class="lv-f${FILT.off.includes(g) ? ' off' : ''}" data-g="${g}" aria-pressed="${!FILT.off.includes(g)}" title="${FILT.off.includes(g) ? 'Show' : 'Hide'} ${name} buses"><i style="background:${BUSART.L[g].key}">${ic(icon, 10)}</i><span>${name}</span></button>`).join('')}`
      + `<button class="lv-f wc${FILT.wc ? ' on' : ''}" data-wc aria-pressed="${FILT.wc}" title="${FILT.wc ? 'Show all buses' : 'Show only wheelchair-accessible buses'}"><i style="background:#1f5fd6">${ic('access', 10)}</i><span>Accessible</span></button></span>`;
  }
  pillEl.addEventListener('click', e => {
    const b = e.target.closest('.lv-f'); if (!b) return;
    if (b.dataset.g) {
      const g = b.dataset.g, i = FILT.off.indexOf(g);
      if (i >= 0) FILT.off.splice(i, 1); else FILT.off.push(g);
      if (FILT.off.length === GROUPS.length) FILT.off = FILT.off.filter(x => x !== g);   // never hide everything
    } else FILT.wc = !FILT.wc;
    saveFilt(); pill(); update(); labels(true);
    if (cardStop) paintStopArrivals();
  });
  setInterval(() => on && FEED && pill(), 15000);

  /* ── cards ── */
  const hhmm = t => new Date(t * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const inMin = t => { const m = Math.round((t - now()) / 60); return m <= 0 ? 'due' : `${m} min`; };
  /* Lucide icons (ISC licence), the set the rest of the map uses */
  const ICON = {
    access: '<circle cx="16" cy="4" r="1"/><path d="m18 19 1-7-6 1"/><path d="m5 8 3-3 5.5 3-2.36 3.5"/><path d="M4.24 14.5a5 5 0 0 0 6.88 6"/><path d="M13.76 17.5a5 5 0 0 0-6.88-6"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
    seat: '<path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/><path d="M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z"/><path d="M5 18v2"/><path d="M19 18v2"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    full: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    late: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
    early: '<polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/>',
    noshow: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>',
    skip: '<path d="m15 9-6 6"/><path d="M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586z"/><path d="m9 9 6 6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    snow: '<line x1="2" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="22"/><path d="m20 16-4-4 4-4"/><path d="m4 8 4 4-4 4"/><path d="m16 4-4 4-4-4"/><path d="m8 20 4-4 4 4"/>',
    bolt: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/>',
    bus: '<path d="M8 6v6M15 6v6M2 12h19.6M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/>',
  };
  const ic = (k, sz = 16) => `<svg viewBox="0 0 24 24" width="${sz}" height="${sz}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
  /* Bus features as icon badges, not words: a bolt for electric, a snowflake
     for AC, the metro app's step-free icon for low floor (every low-floor bus,
     AC or not, has a ramp). A diesel non-AC bus has no badge at all. */
  const badge = (k, bg, title, cls = '') => `<span class="lv-ico${cls}" style="background:${bg}" title="${title}" aria-label="${title}">${ic(k, 12)}</span>`;
  const chips = fl => {
    const lv = lvOf(fl);
    return (fl.includes('e') ? badge('bolt', lv === 'evAC' || lv === 'premium' ? '#e2343c' : '#5a2ad0', 'Electric') : '')
      // AC: a blue snowflake on ice, so it never reads as the solid-blue wheelchair badge
      + (fl.includes('a') ? badge('snow', '#e4f3ff', 'AC', ' ac') : '')
      + (fl.includes('l') ? badge('access', '#1f5fd6', 'Low floor with a ramp — wheelchair accessible') : '')
      + (fl.includes('p') ? `<span class="lv-chip" style="background:#b3803f">Premium</span>` : '')
      + (fl.includes('x') ? `<span class="lv-chip" style="background:#b8860b">Express</span>` : '')
      + (fl.includes('u') ? `<span class="lv-chip" style="background:#8a8a8e">Waiting for next trip</span>` : '');
  };
  const ago = s => s < 90 ? `${Math.max(0, Math.round(s))} s` : `${Math.round(s / 60)} min`;

  /* ── shareable state: the address bar always holds a link to what is open,
     and the Share button hands out the short link whose card WhatsApp, X and
     Facebook can show (/r /s /b, served by share_api.py) ── */
  const ORIGIN = 'https://mtc.reclaimchennai.city';
  let SHARE = null;
  function setShare(q, short, title) {
    SHARE = { url: ORIGIN + short, title };
    try { history.replaceState(null, '', q ? '?' + q : location.pathname); } catch (e) {}
    shareBtn.classList.toggle('on', !!q);
  }
  const shareBtn = document.createElement('button');
  shareBtn.className = 'cclose lv-share'; shareBtn.setAttribute('aria-label', 'Share'); shareBtn.title = 'Share';
  shareBtn.innerHTML = ic('share', 15);
  $('card-close').after(shareBtn);
  const toast = msg => {
    let t = $('lv-toast');
    if (!t) { t = document.createElement('div'); t.id = 'lv-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200);
  };
  shareBtn.addEventListener('click', async e => {
    e.stopPropagation();
    if (!SHARE) return;
    if (navigator.share) { try { await navigator.share({ title: SHARE.title, text: SHARE.title, url: SHARE.url }); return; } catch (err) { if (err && err.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(SHARE.url); toast('Link copied'); } catch (err) { toast(SHARE.url); }
  });

  /* One card for a bus: its own header (route, destination, registration, GPS
     age, badges, report, crowding) on top of the route card of the working it
     is running — workings, timings and the stop diagram — with the bus's
     progress drawn on that diagram. The map stays where the rider was looking. */
  function openBus(reg) {
    const tr = TRACK.get(reg); if (!tr) return;
    const code = tr.v[1], sn = snOf(code);
    if (selStopMarker) { selStopMarker.remove(); selStopMarker = null; }
    const cam = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
    if (ROUTE_IDX[sn]) { baseSelect(sn, code); map.stop(); map.jumpTo(cam); } else showCard();
    selReg = reg; cardBus = reg; cardStop = null;
    paintBus(reg, true); showBusRoute(code); update();
    setShare(`bus=${encodeURIComponent(reg)}`, `/b/${encodeURIComponent(reg)}`, `Bus ${reg} on route ${snOf(tr.v[1])} — live on the Chennai MTC map`);
  }
  // trace the bus's own working on the map, the way tapping a route does
  function showBusRoute(code) {
    const f = codeFeat(code); if (!f || !map.getSource('sel')) return;
    const sn = snOf(code);
    selMarkers.forEach(m => m.remove()); selMarkers = [];
    map.getSource('sel').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: f.geometry, properties: { ...f.properties, color: f.properties.color || hashColor(sn) } }] });
    map.setPaintProperty('routes', 'line-opacity', 0.18);
    map.setPaintProperty('sel-line', 'line-width', 5);
    map.setPaintProperty('sel-glow', 'line-width', 14); map.setPaintProperty('sel-glow', 'line-blur', 8);
    map.setLayoutProperty('sel-arrows', 'visibility', 'visible');
  }
  function paintBus(reg, first) {
    const tr = TRACK.get(reg);
    if (!tr) { const bb = $('lv-busbar'); if (bb) bb.innerHTML = '<div class="lv-note">This bus is no longer reporting.</div>'; return; }
    const [, code, , , , fix, fl] = tr.v, sn = snOf(code), st = stopsOf(code) || [];
    const f = codeFeat(code), dest = f ? f.properties.destinatio : (st.length ? st[st.length - 1][1] : '');
    $('card-title').innerHTML = `${tagHTML(sn, f && f.properties.category)}<span class="ttl"><span>→ ${dest || ''}</span></span>`;
    $('card-sub').innerHTML = `<span class="lv-busline">${chips(fl)}Bus <b>${reg}</b> &middot; GPS ${ago(now() - fix)} ago</span>`;
    let bar = $('lv-busbar');
    if (!bar || first) {
      if (bar) bar.remove();
      bar = document.createElement('div'); bar.id = 'lv-busbar';
      $('card-body').prepend(bar);
    }
    const hNow = new Date(Date.now() + 19800000).getUTCHours(), cr = crowdOf(code, hNow);
    let crowdHTML = '';
    if (cr) {
      const bars = Array.from({ length: 24 }, (_, h) => crowdRatio(code, h, cr.we));
      const mx = Math.max(1.6, ...bars.filter(x => x != null));
      crowdHTML = `<div class="seclbl">Crowding now · estimated</div>`
        + `<div class="lv-crowd"><span style="color:${CROWD_COL[cr.level]}">${PEOPLE} <b>${CROWD_NAMES[cr.level]}</b></span>`
        + `<span>${Math.round(cr.p * 100)}% chance you'll stand</span></div>`
        + `<div class="lv-bars" title="Estimated crowding by hour on this working">${bars.map((x, h) => `<i style="height:${x == null ? 2 : Math.max(2, 100 * x / mx)}%;background:${x == null ? '#e7e2d6' : CROWD_COL[x < 0.75 ? 0 : x < 1.3 ? 1 : 2]};${h === hNow ? 'outline:1.5px solid #1c1c1e;outline-offset:1px' : ''}"></i>`).join('')}</div>`
        + `<div class="lv-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>`;
    }
    bar.innerHTML = `<button class="lv-report" id="lv-report">${ic('flag', 14)}Report</button><div id="lv-said"></div>${crowdHTML}`;
    $('lv-report').addEventListener('click', () => report({ reg, route: code, sn, fl, stop: '', stop_name: '', lat: tr.v[2], lon: tr.v[3] }));
    said({ reg });
    railProgress(first);
  }

  /* The bus's progress on the stop diagram: stops behind it filled, the stop it
     is heading for blinking, the rest hollow with their predicted times. Runs on
     every poll and every few seconds, so the blink moves on as the bus does. */
  function railProgress(scroll, tries = 0) {
    if (!cardBus) return;
    const tr = TRACK.get(cardBus), rail = $('stops-wrap') && $('stops-wrap').querySelector('.rail');
    if (!tr || !rail) { if (tries < 20) setTimeout(() => railProgress(scroll, tries + 1), 250); return; }
    const t = now(), eta = new Map(tr.v[7].map(([i, et]) => [i, et]));
    const upcoming = tr.v[7].filter(([, et]) => et > t - 20).map(([i]) => i);
    const next = upcoming.length ? Math.min(...upcoming) : Infinity;
    rail.classList.add('lv-live');
    rail.querySelectorAll('[data-i]').forEach(el => {
      const i = +el.dataset.i;
      el.classList.toggle('passed', i < next);
      el.classList.toggle('next', i === next);
      if (el.tagName === 'LI' || el.classList.contains('capname')) {
        let e = el.querySelector('.lv-eta');
        const et = eta.get(i);
        if (et != null && i >= next) {
          if (!e) { e = document.createElement('span'); e.className = 'lv-eta'; (el.querySelector('.lbl.out') || el).appendChild(e); }
          e.textContent = `${inMin(et)} · ${hhmm(et)}`;
        } else if (e) e.remove();
      }
    });
    if (!rail._lvWired) {
      rail._lvWired = true;
      rail.addEventListener('click', ev => {
        const el = ev.target.closest('[data-i]'); if (!el || !cardBus) return;
        const t2 = TRACK.get(cardBus), s2 = t2 && stopsOf(t2.v[1]);
        if (s2 && s2[+el.dataset.i]) goToStop(s2[+el.dataset.i], cardBus);
      });
    }
    if (scroll) { const n = rail.querySelector('li.next'); if (n) setTimeout(() => n.scrollIntoView({ block: 'center', behavior: 'smooth' }), 120); }
  }
  setInterval(() => { if (cardBus && !document.hidden) railProgress(false); }, 5000);

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
    const hidden = arr.filter(a => !passes(a.fl)).length;
    arr.splice(0, arr.length, ...arr.filter(a => passes(a.fl)));
    const rows = arr.slice(0, 12).map(a => {
      const f = codeFeat(a.code), dest = f ? f.properties.destinatio : '';
      return `<div class="lv-row" data-reg="${a.reg}" style="cursor:pointer">${tagHTML(snOf(a.code), f && f.properties.category)}`
        + `<span class="meta">→ <b>${dest || ''}</b><br>${chips(a.fl)}${a.reg}${(c => c ? ` <span title="${CROWD_NAMES[c.level]} (estimated)" style="color:${CROWD_COL[c.level]}">${PEOPLE}</span>` : '')(crowdOf(a.code, new Date(a.et * 1000 + 19800000).getUTCHours()))}</span>`
        + `<span class="when">${inMin(a.et)}<small>${hhmm(a.et)}</small></span></div>`;
    }).join('');
    box.innerHTML = `<div class="seclbl">Live arrivals · next 90 min</div>`
      + (rows || `<div class="lv-note">No tracked bus is due here in the next 90 minutes. Not every bus reports its position.</div>`)
      + (hidden ? `<div class="lv-note">${hidden} more bus${hidden === 1 ? '' : 'es'} hidden by the filters in the top bar.</div>` : '')
      + (rows ? `<div class="lv-note">Estimated from each bus's GPS (MTC app feed) and its distance to the stop. Tap a bus to follow it.</div>` : '');
    box.querySelectorAll('[data-reg]').forEach(el => el.addEventListener('click', () => {
      const tr = TRACK.get(el.dataset.reg); if (!tr) return;
      openBus(el.dataset.reg);
      const p = posOf(tr, now(), [0, 0, 0]); map.flyTo({ center: [p[0], p[1]], zoom: Math.max(map.getZoom(), 14), duration: 700 });
    }));
  }

  // add a live section to every stop card
  const baseOpenStop = openStop;
  openStop = function (f, opts = {}) {
    baseOpenStop(f);
    cardBus = null; selReg = null;
    cardStop = f.geometry.coordinates;
    if (opts.fly) map.flyTo({ center: cardStop, zoom: Math.max(map.getZoom(), 16), duration: 1100, essential: true });
    const head = document.createElement('div');
    head.className = 'lv-stophead';
    head.innerHTML = (opts.fromBus ? `<button class="lv-backbtn" id="lv-back">${ic('back', 14)}Bus ${opts.fromBus}</button>` : '<span></span>')
      + `<button class="lv-report" id="lv-report-stop" style="margin:0">${ic('flag', 14)}Report</button>`;
    const box = document.createElement('div'); box.id = 'lv-arrivals'; box.style.marginBottom = '12px';
    const saidBox = document.createElement('div'); saidBox.id = 'lv-said';
    $('card-body').prepend(head, saidBox, box);
    if (opts.fromBus) $('lv-back').addEventListener('click', () => swapCard(() => {
      const tr = TRACK.get(opts.fromBus); if (!tr) return;
      openBus(opts.fromBus);
      const p = posOf(tr, now(), [0, 0, 0]); map.flyTo({ center: [p[0], p[1]], zoom: Math.max(map.getZoom(), 15), duration: 900 });
    }));
    const keys = stopKeys(cardStop[0], cardStop[1]);
    const stopCode = keys.length ? stopsOf(keys[0][0])[keys[0][1]][0] : '';
    const stopName = f.properties['Stop Name'] || '';
    $('lv-report-stop').addEventListener('click', () => report({ stop: stopCode, stop_name: stopName, lat: cardStop[1], lon: cardStop[0], atStop: true }));
    if (stopCode) said({ stop: stopCode });
    paintStopArrivals();
    const key = `${cardStop[1].toFixed(5)},${cardStop[0].toFixed(5)}`;
    setShare(`stop=${key}`, `/s/${key}`, `${stopName} — live bus arrivals on the Chennai MTC map`);
  };

  /* bus card -> stop card: fly to the stop and slide the card across */
  function swapCard(fn) {
    const c = $('card');
    c.classList.add('lv-out');
    setTimeout(() => { fn(); c.classList.remove('lv-out'); c.classList.add('lv-in'); setTimeout(() => c.classList.remove('lv-in'), 260); }, 170);
  }
  function goToStop(s, fromBus) {
    if (!s) return;
    const [code, name, lat, lon] = s;
    // the map's stop pins are merged by place; take the one at this stop
    let best = null, bd = 120;
    for (const f of (STOPS && STOPS.features) || []) {
      const c = f.geometry.coordinates, d = Math.hypot((c[0] - lon) * K * Math.cos(lat * Math.PI / 180), (c[1] - lat) * K);
      if (d < bd) { bd = d; best = f; }
    }
    const f = best || { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { 'Stop Name': name, 'route name': '[]' } };
    swapCard(() => openStop(f, { fly: true, fromBus }));
  }

  /* ── rider reports: tap, tap, done ── */
  const SAY = {
    seats: { label: 'How full is it?', opts: {
      free: ['seat', 'Seats free', { many: 'Lots of seats', some: 'A few seats', few: 'One or two' }],
      standing: ['users', 'Standing', { some: 'A few standing', crowded: 'Crowded aisle', packed: 'Packed' }],
      full: ['full', 'Full', { boarded: 'I got on', squeezed: 'Squeezed in', left_behind: "Couldn't get on" }] } },
    timing: { label: 'Is it on time?', opts: {
      on_time: ['clock', 'On time', null],
      late: ['late', 'Late', { lt5: 'Under 5 min', '5_15': '5–15 min', '15_30': '15–30 min', gt30: '30+ min' }],
      early: ['early', 'Early', { lt5: 'Under 5 min', '5_15': '5–15 min', gt15: '15+ min' }],
      no_show: ['noshow', "Didn't come", { 15: 'Waited 15 min', 30: 'Waited 30 min', 60: 'An hour or more' }],
      skipped: ['skip', "Didn't stop", { did_not_stop: 'Drove past', full: 'Too full to stop' }] } },
    access: { label: 'Ramp and access', opts: {
      ramp_ok: ['access', 'Ramp worked', null], ramp_broken: ['access', "Ramp didn't work", null], not_low_floor: ['access', 'Not low floor', null] } },
  };
  const sheet = document.createElement('div');
  sheet.id = 'lv-sheet';
  document.body.appendChild(sheet);
  sheet.addEventListener('click', e => { if (e.target === sheet) sheet.classList.remove('open'); });
  function report(ctx) {
    const pickBus = () => {
      // at a stop: which bus? (the next arrivals here, or none listed)
      const keys = stopKeys(ctx.lon, ctx.lat), want = new Set(keys.map(k => k[0])), t = now(), arr = [];
      for (const [reg, tr] of TRACK) if (want.has(tr.v[1])) {
        const e = tr.v[7].find(([i, et]) => keys.some(k => k[0] === tr.v[1] && k[1] === i) && et > t - 600 && et < t + 2400);
        if (e) arr.push([e[1], reg, tr]);
      }
      arr.sort((a, b) => a[0] - b[0]);
      return arr.slice(0, 6);
    };
    const tile = (k, icon, label, cls = '') => `<button class="lv-tile ${cls}" data-k="${k}">${ic(icon, 26)}<span>${label}</span></button>`;
    const frame = (title, body, back) => {
      sheet.innerHTML = `<div class="lv-sheetbox" role="dialog" aria-label="Report">`
        + `<div class="lv-sheethead">${back ? `<button class="lv-x" data-back>${ic('back', 18)}</button>` : '<span></span>'}<b>${title}</b><button class="lv-x" data-close>✕</button></div>`
        + `<div class="lv-sub">${ctx.sn ? `${tagHTML(ctx.sn)} ` : ''}${ctx.reg ? `Bus <b>${ctx.reg}</b>` : ''}${ctx.stop_name ? ` · ${ctx.stop_name}` : ''}</div>${body}</div>`;
      sheet.querySelector('[data-close]').onclick = () => sheet.classList.remove('open');
      if (back) sheet.querySelector('[data-back]').onclick = back;
      sheet.classList.add('open');
    };
    const send = (kind, value, detail) => {
      frame('Sending…', '<div class="lv-note">One moment.</div>');
      fetch('api/report', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, value, detail, reg: ctx.reg || '', route: ctx.route || '', sn: ctx.sn || '', stop: ctx.stop || '', stop_name: ctx.stop_name || '', lat: ctx.lat, lon: ctx.lon }) })
        .then(r => r.ok ? r.json() : Promise.reject(r.status))
        .then(() => {
          frame('Thank you', `<div class="lv-thanks">${ic('check', 34)}<div>Saved. Other riders see it for the next 90 minutes, and it helps check the crowding estimate.</div></div>`
            + `<div class="lv-tiles two"><button class="lv-tile" data-again>${ic('flag', 22)}<span>Report something else</span></button><button class="lv-tile" data-done>${ic('check', 22)}<span>Done</span></button></div>`);
          sheet.querySelector('[data-again]').onclick = step1;
          sheet.querySelector('[data-done]').onclick = () => sheet.classList.remove('open');
          said(ctx.reg ? { reg: ctx.reg } : { stop: ctx.stop }, true);
        })
        .catch(e => frame("Couldn't send", `<div class="lv-note">${e === 429 ? 'That is a lot of reports from this phone — thank you, please try later.' : 'No connection to the server. Please try again.'}</div>`, step1));
    };
    const step2 = (kind, value) => {
      const [icon, label, more] = SAY[kind].opts[value];
      if (!more) return send(kind, value, '');
      frame(label, `<div class="lv-tiles">${Object.entries(more).map(([d, l]) => tile(d, icon, l)).join('')}</div>`, step1);
      sheet.querySelectorAll('.lv-tile').forEach(b => b.onclick = () => send(kind, value, b.dataset.k));
    };
    const step1 = () => {
      const groups = Object.entries(SAY).filter(([k]) => k !== 'access' || ctx.fl == null || ctx.fl.includes('l'))
        .map(([k, g]) => `<div class="lv-glabel">${g.label}</div><div class="lv-tiles">${Object.entries(g.opts)
          .filter(([v]) => ctx.atStop || v !== 'no_show').map(([v, [icon, label]]) => tile(`${k}:${v}`, icon, label)).join('')}</div>`).join('');
      frame('Report', groups, ctx.atStop ? () => { Object.assign(ctx, { reg: '', route: '', sn: '', fl: undefined }); pick(); } : null);
      sheet.querySelectorAll('.lv-tile').forEach(b => b.onclick = () => { const [k, v] = b.dataset.k.split(':'); step2(k, v); });
    };
    const pick = () => {
      const buses = pickBus();
      frame('Which bus?', `<div class="lv-tiles">${buses.map(([et, reg, tr]) => `<button class="lv-tile" data-reg="${reg}">${tagHTML(snOf(tr.v[1]))}<span>${reg} · ${inMin(et)}</span></button>`).join('')}`
        + `<button class="lv-tile" data-reg="">${ic('noshow', 26)}<span>A bus that isn't listed</span></button></div>`);
      sheet.querySelectorAll('[data-reg]').forEach(b => b.onclick = () => {
        const tr = TRACK.get(b.dataset.reg);
        if (tr) Object.assign(ctx, { reg: b.dataset.reg, route: tr.v[1], sn: snOf(tr.v[1]), fl: tr.v[6] });
        step1();
      });
    };
    ctx.atStop && !ctx.reg ? pick() : step1();
  }
  // what riders said recently, on the bus or stop card
  const NAMES = {};
  for (const [k, g] of Object.entries(SAY)) for (const [v, [, l, more]] of Object.entries(g.opts)) { NAMES[k + ':' + v] = l; for (const [d, dl] of Object.entries(more || {})) NAMES[`${k}:${v}:${d}`] = dl; }
  function said(q, fresh) {
    const box = $('lv-said'); if (!box) return;
    const qs = q.reg ? `reg=${encodeURIComponent(q.reg)}` : `stop=${encodeURIComponent(q.stop)}`;
    fetch(`api/recent?${qs}&t=${fresh ? Date.now() : Math.floor(Date.now() / 60000)}`).then(r => r.ok ? r.json() : null).then(j => {
      if (!j || !j.reports || !j.reports.length || !$('lv-said')) return;
      const last = j.reports.slice(-3).reverse();
      $('lv-said').innerHTML = `<div class="seclbl">Riders said</div>` + last.map(([k, v, d, m, sn]) =>
        `<div class="lv-said">${ic(SAY[k].opts[v][0], 14)}<b>${NAMES[k + ':' + v]}</b>${d ? ` · ${NAMES[`${k}:${v}:${d}`]}` : ''}${sn && !q.reg ? ` · ${sn}` : ''}<span>${m < 1 ? 'just now' : m + ' min ago'}</span></div>`).join('');
    }).catch(() => {});
  }
  $('card-close').addEventListener('click', () => { cardStop = cardBus = selReg = null; update(); setShare('', '', ''); });
  const baseSelect = selectRoute;
  selectRoute = function (...a) {
    cardStop = cardBus = selReg = null;
    const out = baseSelect.apply(this, a);
    const sn = a[0], e = ROUTE_IDX[sn], w = a[1] || (e && e.code) || '';
    if (sn) setShare(`route=${encodeURIComponent(sn)}${w ? `&w=${w}` : ''}`, `/r/${encodeURIComponent(sn)}${w ? `?w=${w}` : ''}`, `Route ${sn}${e && e.source ? ` · ${e.source} → ${e.dest}` : ''} — Chennai MTC map`);
    return out;
  };

  /* ── deep links: ?route= / ?stop= / ?bus= open what was shared ── */
  (() => {
    const q = new URLSearchParams(location.search);
    const route = q.get('route'), w = q.get('w'), stop = q.get('stop'), bus = q.get('bus');
    if (!route && !stop && !bus) return;
    const until = (ok, then, ms = 40000) => { const t0 = Date.now(); const tick = () => { if (ok()) then(); else if (Date.now() - t0 < ms) setTimeout(tick, 250); else if (bus) toast('That bus is not reporting its position right now'); }; tick(); };
    if (route) until(() => ROUTE_IDX[route] && dataReady, () => selectRoute(route, w || undefined));
    else if (stop) until(() => STOPS && dataReady, () => {
      const [lat, lon] = stop.split(',').map(Number);
      let best = null, bd = 170;
      for (const f of STOPS.features) { const c = f.geometry.coordinates, d = Math.hypot((c[0] - lon) * K * Math.cos(lat * Math.PI / 180), (c[1] - lat) * K); if (d < bd) { bd = d; best = f; } }
      if (best) openStop(best, { fly: true });
    });
    else if (bus) {
      if (!on) setOn(true);
      // wait for the map data and the live feed; give the feed 30 s to bring this bus in
      until(() => FEED && dataReady && Object.keys(ROUTE_IDX).length && (TRACK.has(bus) || Date.now() - fetchT0 > 30000), () => {
        if (!TRACK.has(bus)) { toast('That bus is not reporting its position right now'); return; }
        openBus(bus);
        const p = posOf(TRACK.get(bus), now(), [0, 0, 0]); map.flyTo({ center: [p[0], p[1]], zoom: 15, duration: 1200 });
      }, 60000);
    }
  })();

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
