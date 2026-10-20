/* MTC buses in 3D, for the live map.

   Each livery (BUSART.L) is modelled as a real bus — 12 m long, 2.6 m wide,
   3.1 m tall — and drawn under a fixed camera tilted 50° from overhead, at 16
   headings. The faces are textured, not flat-shaded:

     sides   the livery: glass band or separate windows, stripe, skirt, bolt,
             wheels; doors only on the left (kerb) side, as on Indian buses
     front   windscreen with the driver on the right, amber LED board, lamps,
             the black mask of the electrics
     rear    rear window and tail lamps
     roof    roof colour, with the battery housing (electric) and AC pod as
             boxes of their own

   lit from the north-west, with a soft ground shadow. Passengers show through
   the glass at three crowd levels — empty, seats taken, packed with standees —
   so a full bus looks full when zoomed in.

   Everything is rendered once into a texture atlas for live.js's WebGL layer:
   5 liveries x 16 headings x 3 crowd levels. No image files. */
'use strict';
const BUSISO = (() => {
  const LEN = 12, WID = 2.6, HGT = 3.1;          // metres
  const PX = 9, TILT = 50 * Math.PI / 180;         // sprite px per metre; camera tilt from overhead
  const CW = 140, CH = 110, AX = 70, AY = 64;      // sprite cell (logical px) and ground anchor
  const COS = Math.cos(TILT), SIN = Math.sin(TILT);
  const TOCAM = [0, -SIN, COS];                    // direction to the camera (east, north, up)
  const LIGHT = (() => { const v = [-0.45, 0.55, 0.8], n = Math.hypot(...v); return v.map(x => x / n); })();
  const U = 10;                                    // texture units per metre
  const SKIN = ['#b98463', '#8d5a3b', '#c99872', '#a0694a', '#7a4a2e'];
  const CLOTH = ['#e9e4d8', '#3b5b8c', '#c0392b', '#2e7d5b', '#f0c419', '#7d3c98', '#ffffff', '#d35400', '#34495e', '#e84393'];

  function rnd(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  function rr(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
  }
  function tex(w, h, k, draw) {
    const c = document.createElement('canvas'); c.width = w * k; c.height = h * k;
    const g = c.getContext('2d'); g.scale(k, k); draw(g); return c;
  }

  /* people behind glass, between u0..u1, glass from v0 to v1 */
  function people(g, r, u0, u1, v0, v1, crowd, skip) {
    if (!crowd) return;
    const seats = [];
    for (let u = u0 + 2.5; u < u1 - 2; u += 4.2) if (!skip.some(([a, b]) => u > a - 1.5 && u < b + 1.5)) seats.push(u);
    g.save(); g.globalAlpha = 0.78;
    const fig = (u, headV, w) => {
      g.fillStyle = CLOTH[(r() * CLOTH.length) | 0];
      rr(g, u - w / 2, headV + 1.5, w, v1 - headV, 1.2); g.fill();
      g.fillStyle = SKIN[(r() * SKIN.length) | 0];
      g.beginPath(); g.arc(u, headV, 1.35, 0, 2 * Math.PI); g.fill();
      g.fillStyle = '#1d1b1a'; g.beginPath(); g.arc(u, headV - 0.45, 1.25, Math.PI, 2 * Math.PI); g.fill();   // hair
    };
    for (const u of seats) if (crowd === 2 || r() < 0.55) fig(u + (r() - .5), v0 + 6.6, 3.3);       // seated
    if (crowd === 2) {                                                                              // standing
      for (let u = u0 + 4; u < u1 - 3; u += 3.1) fig(u + (r() - .5) * 1.2, v0 + 3.4 + r() * 0.8, 2.8);
    }
    g.restore();
  }

  /* side texture: rear at u=0, front at u=120; roof edge at v=0, ground at v=31 */
  function sideTex(v, crowd, doors, seed) {
    return tex(LEN * U, HGT * U, 4, g => {
      const r = rnd(seed), BOT = 28.5, W = LEN * U;
      // body
      rr(g, 0.3, 0.3, W - 0.6, BOT - 0.3, 2.2); g.fillStyle = v.body; g.fill();
      g.save(); rr(g, 0.3, 0.3, W - 0.6, BOT - 0.3, 2.2); g.clip();
      g.fillStyle = v.roof; g.fillRect(0, 0, W, 2.4);
      const doorAt = doors ? [[52, 60], [102, 110]] : [];
      if (v.panel) {
        g.fillStyle = v.glass; g.fillRect(0, 2.4, W, 12.6);
        people(g, r, 3, 101, 2.4, 15, crowd, doorAt);
        g.fillStyle = 'rgba(255,255,255,.13)';
        for (let u = 16; u < 100; u += 15) g.fillRect(u, 3, 0.6, 11.5);
      } else {
        for (let u = 4; u < 98; u += 12.2) {
          if (doorAt.some(([a, b]) => u + 10 > a && u < b)) continue;
          g.fillStyle = v.glass; rr(g, u, 3.4, 10.2, 10.6, 1.2); g.fill();
          g.save(); rr(g, u, 3.4, 10.2, 10.6, 1.2); g.clip();
          people(g, r, u - 2, u + 12.5, 3.4, 14, crowd, []);
          g.restore();
        }
      }
      // glass sheen
      const sh = g.createLinearGradient(0, 2.4, 0, 15); sh.addColorStop(0, 'rgba(255,255,255,.22)'); sh.addColorStop(.35, 'rgba(255,255,255,0)');
      g.fillStyle = sh; g.fillRect(0, 2.4, W, 12.6);
      g.fillStyle = v.stripe; g.fillRect(0, 15.6, W, 1.4);
      g.fillStyle = v.skirt; g.fillRect(0, 23, W, BOT - 23);
      if (v.panel && v.skirt !== v.body) { g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(0, 22.2, W, 0.8); }
      if (v.bolt) {
        g.fillStyle = v.bolt; g.beginPath();
        g.moveTo(18, 17.5); g.lineTo(12, 25.5); g.lineTo(16, 25.5); g.lineTo(13.5, 31); g.lineTo(21, 22.5); g.lineTo(17, 22.5); g.lineTo(20, 17.5); g.closePath(); g.fill();
      }
      for (const [a, b] of doorAt) {
        g.fillStyle = v.panel ? '#22262b' : '#4a5864'; rr(g, a, 3, b - a, BOT - 4, 0.8); g.fill();
        if (crowd === 2) { g.globalAlpha = .75; people(g, r, a - 1, b + 1, 3, 15, 2, []); g.globalAlpha = 1; }
        g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect((a + b) / 2 - 0.3, 3.5, 0.6, BOT - 5);
      }
      // nose and tail: black mask on the electrics
      if (v.mask !== v.body) { g.fillStyle = v.mask; g.fillRect(W - 6, 0, 6, BOT - 5); }
      g.fillStyle = '#ffe9a8'; g.fillRect(W - 1.4, 18, 1.4, 3);
      g.fillStyle = '#e8403a'; g.fillRect(0, 18, 1.2, 3);
      g.restore();
      // wheels with arches
      for (const u of [24, 92]) {
        g.fillStyle = '#121417'; g.beginPath(); g.arc(u, 26, 6.2, Math.PI, 0); g.fill();
        g.fillStyle = '#1e2226'; g.beginPath(); g.arc(u, 26, 5, 0, 2 * Math.PI); g.fill();
        g.fillStyle = '#aeb4ba'; g.beginPath(); g.arc(u, 26, 2.4, 0, 2 * Math.PI); g.fill();
        g.fillStyle = '#5f656b'; g.beginPath(); g.arc(u, 26, 0.9, 0, 2 * Math.PI); g.fill();
      }
    });
  }
  /* front: viewer's left (u=0) is the bus's right side, where the driver sits */
  function frontTex(v, crowd) {
    return tex(WID * U, HGT * U, 6, g => {
      const W = WID * U, BOT = 28.5;
      rr(g, 0.3, 0.3, W - 0.6, BOT - 0.3, 2.5); g.fillStyle = v.mask === v.body ? v.body : v.mask; g.fill();
      g.fillStyle = '#1a1f25'; rr(g, 1.4, 1, W - 2.8, 3.2, 0.6); g.fill();                 // LED board
      g.fillStyle = '#ffb42e'; for (let u = 2.4; u < W - 2.4; u += 1.15) g.fillRect(u, 1.9, 0.6, 1.4);
      g.fillStyle = v.glass === '#33404a' ? '#2a3640' : '#20262d'; rr(g, 1.2, 5, W - 2.4, 12, 1.2); g.fill();   // windscreen
      g.fillStyle = '#c99872'; g.beginPath(); g.arc(6.5, 10.5, 1.5, 0, 2 * Math.PI); g.fill();      // driver
      g.fillStyle = '#e9e4d8'; rr(g, 4.5, 12, 4, 5, 1); g.fill();
      if (crowd === 2) for (let u = 11; u < 23; u += 3.2) { g.fillStyle = '#b98463'; g.beginPath(); g.arc(u, 9.5, 1.1, 0, 2 * Math.PI); g.fill(); }
      const sh = g.createLinearGradient(0, 5, W, 17); sh.addColorStop(0, 'rgba(255,255,255,.28)'); sh.addColorStop(.4, 'rgba(255,255,255,0)');
      g.fillStyle = sh; rr(g, 1.2, 5, W - 2.4, 12, 1.2); g.fill();
      g.fillStyle = v.body; g.fillRect(0.3, 21, W - 0.6, BOT - 21);
      g.fillStyle = v.stripe; g.fillRect(0.3, 20, W - 0.6, 1);
      g.fillStyle = '#fff4cf'; rr(g, 1.2, 22.5, 3.4, 2, 0.6); g.fill(); rr(g, W - 4.6, 22.5, 3.4, 2, 0.6); g.fill();
      g.fillStyle = '#f4f4f4'; g.fillRect(W / 2 - 3, 25.2, 6, 1.8);                              // number plate
      g.fillStyle = '#121417'; g.fillRect(2, BOT, 4.5, 2.5); g.fillRect(W - 6.5, BOT, 4.5, 2.5);  // tyres
    });
  }
  function rearTex(v) {
    return tex(WID * U, HGT * U, 6, g => {
      const W = WID * U, BOT = 28.5;
      rr(g, 0.3, 0.3, W - 0.6, BOT - 0.3, 2); g.fillStyle = v.body; g.fill();
      g.fillStyle = v.roof; g.fillRect(0.3, 0.3, W - 0.6, 2.2);
      g.fillStyle = v.glass; rr(g, 3, 4, W - 6, 8, 1); g.fill();
      g.fillStyle = v.skirt; g.fillRect(0.3, 23, W - 0.6, BOT - 23);
      g.fillStyle = '#e8403a'; rr(g, 1, 16, 2.4, 5, 0.6); g.fill(); rr(g, W - 3.4, 16, 2.4, 5, 0.6); g.fill();
      g.fillStyle = '#f4f4f4'; g.fillRect(W / 2 - 3, 24.5, 6, 1.8);
      g.fillStyle = '#121417'; g.fillRect(2, BOT, 4.5, 2.5); g.fillRect(W - 6.5, BOT, 4.5, 2.5);
    });
  }

  /* ── projection ── */
  function proj(e, n, z) { return [AX + PX * e, AY - PX * (n * COS + z * SIN)]; }
  function frame(h) {
    const r = h * Math.PI / 180, f = [Math.sin(r), Math.cos(r)], l = [-Math.cos(r), Math.sin(r)];
    return (a, b, z) => proj(a * f[0] + b * l[0], a * f[1] + b * l[1], z);
  }
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  function shade(g, poly, normal, k = 1) {
    const lit = 0.66 + 0.34 * Math.max(0, dot(normal, LIGHT));
    if (lit < 0.999) { g.fillStyle = `rgba(10,12,20,${((1 - lit) * k).toFixed(3)})`; fill(g, poly); }
  }
  function fill(g, poly) { g.beginPath(); poly.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.fill(); }
  // texture (tw x th units) onto the parallelogram O, O+A (u axis), O+B (v axis)
  function mapTex(g, base, c, tw, th, O, A, B, poly) {
    g.save();
    g.beginPath(); poly.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.clip();
    const [s, ox, oy] = base;
    g.setTransform(s * A[0] / tw, s * A[1] / tw, s * B[0] / th, s * B[1] / th, ox + s * O[0], oy + s * O[1]);
    g.drawImage(c, 0, 0, tw, th);
    g.restore();
  }
  const sub = (p, q) => [p[0] - q[0], p[1] - q[1]];

  // a plain box (roof equipment): a in [a0,a1], b in [b0,b1], z in [z0,z1]
  function box(g, P, h, a0, a1, b0, b1, z0, z1, col) {
    const r = h * Math.PI / 180, f = [Math.sin(r), Math.cos(r), 0], l = [-Math.cos(r), Math.sin(r), 0];
    const faces = [
      [[a1, b0], [a1, b1], f], [[a0, b1], [a0, b0], f.map(x => -x)],
      [[a0, b1], [a1, b1], l], [[a1, b0], [a0, b0], l.map(x => -x)],
    ];
    g.fillStyle = col;
    for (const [[pa, pb], [qa, qb], nrm] of faces) {
      if (dot(nrm, TOCAM) <= 0) continue;
      const poly = [P(pa, pb, z0), P(qa, qb, z0), P(qa, qb, z1), P(pa, pb, z1)];
      g.fillStyle = col; fill(g, poly); shade(g, poly, nrm, 1.1);
    }
    const top = [P(a0, b0, z1), P(a1, b0, z1), P(a1, b1, z1), P(a0, b1, z1)];
    g.fillStyle = col; fill(g, top);
    g.fillStyle = 'rgba(255,255,255,.12)'; fill(g, top);
  }

  /* one bus at heading h (degrees clockwise from screen-up) into g, scale s at (ox, oy) */
  function bus(g, base, v, T, h) {
    const P = frame(h), r = h * Math.PI / 180;
    const f = [Math.sin(r), Math.cos(r), 0], l = [-Math.cos(r), Math.sin(r), 0];
    const A = LEN / 2, B = WID / 2;
    const [s, ox, oy] = base;
    g.setTransform(s, 0, 0, s, ox, oy);
    // soft ground shadow, thrown a little to the south-east
    const sx = 0.5, sy = -0.4, Psh = (a, b) => { const p = P(a, b, 0); return [p[0] + sx * PX, p[1] - sy * PX * COS]; };
    g.fillStyle = 'rgba(20,20,30,.13)'; fill(g, [Psh(-A - .5, -B - .5), Psh(A + .5, -B - .5), Psh(A + .5, B + .5), Psh(-A - .5, B + .5)]);
    g.fillStyle = 'rgba(20,20,30,.22)'; fill(g, [Psh(-A, -B), Psh(A, -B), Psh(A, B), Psh(-A, B)]);
    // vertical faces: [top-left, u-axis end, v-axis end] with their textures
    const faces = [
      { n: l.map(x => -x), tl: P(-A, -B, HGT), tr: P(A, -B, HGT), bl: P(-A, -B, 0), c: T.right, tw: LEN * U, th: HGT * U },
      { n: l, tl: P(-A, B, HGT), tr: P(A, B, HGT), bl: P(-A, B, 0), c: T.left, tw: LEN * U, th: HGT * U },
      { n: f, tl: P(A, -B, HGT), tr: P(A, B, HGT), bl: P(A, -B, 0), c: T.front, tw: WID * U, th: HGT * U },
      { n: f.map(x => -x), tl: P(-A, B, HGT), tr: P(-A, -B, HGT), bl: P(-A, B, 0), c: T.rear, tw: WID * U, th: HGT * U },
    ];
    for (const F of faces) {
      if (dot(F.n, TOCAM) <= 0) continue;
      const br = [F.tr[0] + F.bl[0] - F.tl[0], F.tr[1] + F.bl[1] - F.tl[1]];
      const poly = [F.tl, F.tr, br, F.bl];
      mapTex(g, base, F.c, F.tw, F.th, F.tl, sub(F.tr, F.tl), sub(F.bl, F.tl), poly);
      g.setTransform(s, 0, 0, s, ox, oy);
      shade(g, poly, F.n);
    }
    // roof, slightly rounded by an inset highlight
    const roof = [P(-A, -B, HGT), P(A, -B, HGT), P(A, B, HGT), P(-A, B, HGT)];
    g.fillStyle = v.roof; fill(g, roof);
    g.fillStyle = 'rgba(255,255,255,.16)'; fill(g, [P(-A + .4, -B + .5, HGT), P(A - .4, -B + .5, HGT), P(A - .4, B - .5, HGT), P(-A + .4, B - .5, HGT)]);
    if (v.mask !== v.body) { g.fillStyle = v.mask; fill(g, [P(A - .55, -B, HGT), P(A, -B, HGT), P(A, B, HGT), P(A - .55, B, HGT)]); }
    // roof equipment, back to front so nearer boxes overlap farther ones
    const eq = [];
    if (v.ev) eq.push([-3.6, 1.6, -0.95, 0.95, 0.32, v.roof]);
    if (v.ac) eq.push([v.ev ? 2.2 : -1.2, v.ev ? 4.2 : 1.2, -0.85, 0.85, 0.42, '#e9eef3']);
    if (!v.ev && !v.ac) eq.push([-0.6, 0.6, -0.5, 0.5, 0.12, '#cfe3f0']);
    eq.sort((p, q) => dot([f[0] * (p[0] + p[1]) / 2, f[1] * (p[0] + p[1]) / 2, 0], TOCAM) - dot([f[0] * (q[0] + q[1]) / 2, f[1] * (q[0] + q[1]) / 2, 0], TOCAM));
    for (const [a0, a1, b0, b1, hh, col] of eq) box(g, P, h, a0, a1, b0, b1, HGT, HGT + hh, col);
    // crisp outline of the silhouette edges
    g.strokeStyle = 'rgba(18,20,26,.45)'; g.lineWidth = 0.6; g.lineJoin = 'round';
    g.beginPath(); roof.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.stroke();
  }

  const texCache = new Map();
  function textures(lv, crowd) {
    const k = lv + crowd;
    if (!texCache.has(k)) {
      const v = BUSART.L[lv], seed = lv.length * 97 + crowd * 13;
      texCache.set(k, { right: sideTex(v, crowd, false, seed), left: sideTex(v, crowd, true, seed + 7), front: frontTex(v, crowd), rear: rearTex(v) });
    }
    return texCache.get(k);
  }

  /* Atlas for the WebGL layer: cells of CW x CH logical px at `scale`, keyed
     `${livery}:${dir}:${crowd}` (dir 0..15 = heading dir*22.5° from screen-up),
     plus 'glow' and 'snow'. Returns {canvas, uv, cell: [CW, CH], anchor: [AX, AY]}. */
  function atlas(scale = 1.25, maxW = 4096) {
    const keys = Object.keys(BUSART.L), cw = Math.round(CW * scale), ch = Math.round(CH * scale);
    const cols = Math.floor(maxW / cw), n = keys.length * 16 * 3 + 2, rows = Math.ceil(n / cols);
    const c = document.createElement('canvas'); c.width = cols * cw; c.height = rows * ch;
    const g = c.getContext('2d'), uv = {};
    let i = 0;
    const cell = key => { const x = (i % cols) * cw, y = Math.floor(i / cols) * ch; i++; uv[key] = [x / c.width, y / c.height, (x + cw) / c.width, (y + ch) / c.height]; return [x, y]; };
    for (const lv of keys) for (let crowd = 0; crowd < 3; crowd++) {
      const T = textures(lv, crowd);
      for (let d = 0; d < 16; d++) {
        const [x, y] = cell(`${lv}:${d}:${crowd}`);
        g.save(); g.beginPath(); g.rect(x, y, cw, ch); g.clip();
        bus(g, [scale, x, y], BUSART.L[lv], T, d * 22.5);
        g.restore(); g.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
    // glow and snowflake from the flat set
    const flat = BUSART.atlas(), fu = flat.uv, fc = flat.canvas;
    for (const k of ['glow', 'snow']) {
      const [x, y] = cell(k), [u0, v0, u1, v1] = fu[k];
      const sw = (u1 - u0) * fc.width, sh = (v1 - v0) * fc.height, side = Math.min(cw, ch);
      g.drawImage(fc, u0 * fc.width, v0 * fc.height, sw, sh, x, y, side, side);
      uv[k] = [x / c.width, y / c.height, (x + side) / c.width, (y + side) / c.height];
    }
    return { canvas: c, uv, cell: [CW, CH], anchor: [AX, AY] };
  }
  // a single sprite as an image, for the bus card
  function portrait(lv, crowd, h = 112.5, scale = 2.4) {
    const c = document.createElement('canvas'); c.width = CW * scale; c.height = CH * scale;
    bus(c.getContext('2d'), [scale, 0, 0], BUSART.L[lv], textures(lv, crowd), h);
    return c.toDataURL('image/png');
  }
  return { atlas, portrait, CELL: [CW, CH], ANCHOR: [AX, AY] };
})();
