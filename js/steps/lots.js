// Step 18 — lots: every block is cut into strip lots along its streets,
// narrow at the front and deep, the way medieval parcels are. For each
// street edge of a block, a band of a given depth is divided by lines square
// to the edge; a lot is the part of the block closer to its own street line
// than to any other edge line, within the depth, between two such lines —
// so the lots of a block tile its bands exactly, and what is left in the
// middle is the gardens and yards.
(function (global) {
  'use strict';

  /** Keep the part of a convex polygon where nx·x + ny·y <= c. */
  function clipHalf(poly, nx, ny, c) {
    const out = [];
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const p = poly[i], q = poly[(i + 1) % n];
      const fp = nx * p.x + ny * p.y - c, fq = nx * q.x + ny * q.y - c;
      if (fp <= 0) out.push(p);
      if ((fp <= 0) !== (fq <= 0)) { const t = fp / (fp - fq); out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }); }
    }
    return out;
  }

  function polygonArea(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y; }
    return Math.abs(a) / 2;
  }

  /** Inward unit normal and offset of each edge line of a convex polygon: d_i(p) = n·p − c is the distance inside line i. */
  function edgeLines(poly) {
    const c = global.polygonCentroid(poly);
    return poly.map((p, i) => {
      const q = poly[(i + 1) % poly.length];
      const ex = q.x - p.x, ey = q.y - p.y, l = Math.hypot(ex, ey) || 1;
      let nx = -ey / l, ny = ex / l;
      if ((c.x - p.x) * nx + (c.y - p.y) * ny < 0) { nx = -nx; ny = -ny; }
      return { nx: nx, ny: ny, c: nx * p.x + ny * p.y, ex: ex / l, ey: ey / l, len: l, a: p, b: q };
    });
  }

  global.LotsStep = {
    id: 'lots',
    title: 'Lots',
    zIndex: 5.25,  // on the blocks
    settings: [
      { key: 'frontCentre', label: 'Frontage at the centre (m)', type: 'range', min: 3, max: 15, step: 0.5, default: 5.5 },
      { key: 'frontWall', label: 'Frontage at the wall (m)', type: 'range', min: 3, max: 20, step: 0.5, default: 8.5 },
      { key: 'depthCentre', label: 'Lot depth at the centre (m)', type: 'range', min: 8, max: 50, step: 1, default: 20 },
      { key: 'depthWall', label: 'Lot depth at the wall (m)', type: 'range', min: 8, max: 60, step: 1, default: 35 },
      { key: 'jitter', label: 'Width irregularity', type: 'range', min: 0, max: 0.6, step: 0.05, default: 0.3 }
    ],

    run(state, s, rng, ctx) {
      const t0 = performance.now();
      state.lots = null;
      if (!state.blocks || !state.walls) return 'No blocks: no lots.';
      const U = global.Units, toU = U.toUnits;
      const outer = state.walls.find((x) => x.kind === 'outer');
      const core = state.core || state.site;
      const rMax = Math.max(...outer.poly.map((p) => p.r));
      const zone = (p) => Math.min(1, Math.hypot(p.x - core.x, p.y - core.y) / rMax);  // 0 at the core, 1 at the wall
      // Which block edges are streets: match the block's cell edges to the street edges (the block is the inset cell).
      const key = (p) => Math.round(p.x * 10) + ',' + Math.round(p.y * 10);
      const streetByEdge = new Map();
      for (const st of state.streets) { const x = key(st.a), y = key(st.b); streetByEdge.set(x < y ? x + '|' + y : y + '|' + x, st); }
      const lots = [];
      let noFront = 0;
      state.blocks.forEach((block, bi) => {
        const P = block.poly, lines = edgeLines(P);
        if (P.length < 3) return;
        const z = zone(block.centre);
        const wTarget = toU(s.frontCentre + (s.frontWall - s.frontCentre) * z);
        let D = toU(s.depthCentre + (s.depthWall - s.depthCentre) * z);
        // The block's thickness: the smallest of the largest distances of a vertex inside an edge line.
        let thickness = Infinity;
        for (const L of lines) {
          let far = 0;
          for (const p of P) far = Math.max(far, L.nx * p.x + L.ny * p.y - L.c);
          thickness = Math.min(thickness, far);
        }
        D = Math.min(D, 0.5 * thickness);
        // Street edges of the block: the inset edges run parallel to the cell's, so match by direction and nearness to a street.
        const fronts = lines.map((L) => {
          const m = { x: (L.a.x + L.b.x) / 2, y: (L.a.y + L.b.y) / 2 };
          let best = null, bd = Infinity;
          for (const st of state.streets) {
            // Distance from the edge midpoint to the street segment; parallel enough.
            const vx = st.b.x - st.a.x, vy = st.b.y - st.a.y, l2 = vx * vx + vy * vy;
            if (l2 < 1e-9) continue;
            const t = Math.max(0, Math.min(1, ((m.x - st.a.x) * vx + (m.y - st.a.y) * vy) / l2));
            const d = Math.hypot(m.x - st.a.x - vx * t, m.y - st.a.y - vy * t);
            if (d < bd && Math.abs(L.ex * vx + L.ey * vy) / Math.sqrt(l2) > 0.9) { bd = d; best = st; }
          }
          return best && bd <= best.width / 2 + 1.5 ? best : null;
        });
        if (!fronts.some((f) => f)) { noFront++; return; }
        lines.forEach((L, i) => {
          const st = fronts[i];
          if (!st) return;
          if (L.len < toU(3.5)) return;
          // Frontage widths along the edge, jittered, summing to its length.
          const n = Math.max(1, Math.round(L.len / wTarget));
          const raw = Array.from({ length: n }, () => 1 + s.jitter * rng.range(-1, 1));
          const sum = raw.reduce((a, b) => a + b, 0);
          const widths = raw.map((v) => (v / sum) * L.len);
          let along = 0;
          for (let k = 0; k < n; k++) {
            const s0 = along, s1 = along + widths[k];
            along = s1;
            // The lot: the block, closer to this street line than to any other edge line, within the depth, between the two perpendiculars.
            let poly = P.slice();
            for (let j = 0; j < lines.length && poly.length >= 3; j++) {
              if (j === i) continue;
              const M = lines[j];
              // d_i(p) <= d_j(p)  <=>  (n_i - n_j)·p <= c_i - c_j
              poly = clipHalf(poly, L.nx - M.nx, L.ny - M.ny, L.c - M.c);
            }
            if (poly.length >= 3) poly = clipHalf(poly, L.nx, L.ny, L.c + D);
            // Between the perpendiculars at s0 and s1 (the edge direction e: e·p between e·a + s0 and e·a + s1).
            const ea = L.ex * L.a.x + L.ey * L.a.y;
            if (poly.length >= 3) poly = clipHalf(poly, -L.ex, -L.ey, -(ea + s0));
            if (poly.length >= 3) poly = clipHalf(poly, L.ex, L.ey, ea + s1);
            if (poly.length < 3 || polygonArea(poly) < 4) continue;
            lots.push({
              poly: poly, block: bi, edge: i, street: st.kind, width: widths[k],
              front: { x: L.a.x + L.ex * (s0 + s1) / 2, y: L.a.y + L.ey * (s0 + s1) / 2 },
              inward: { x: L.nx, y: L.ny }, along: { x: L.ex, y: L.ey }, depth: D, zone: z
            });
          }
        });
      });
      state.lots = lots;
      const mean = lots.length ? lots.reduce((a, l) => a + l.width, 0) / lots.length : 0;
      return lots.length + ' lots (mean frontage ' + U.toMetres(mean).toFixed(1) + ' m)' + (noFront ? ', ' + noFront + ' blocks without a street' : '') +
        ', ' + Math.round(performance.now() - t0) + ' ms';
    },

    draw(g, state, ctx) {
      const px = (ctx && ctx.px) || 1;
      if (!state.lots) return;
      g.save();
      g.strokeStyle = 'rgba(90, 70, 50, .7)';
      g.lineWidth = 0.4 * px;
      g.lineJoin = 'round';
      for (const lot of state.lots) {
        g.beginPath();
        lot.poly.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
        g.stroke();
      }
      g.restore();
    }
  };
})(window);
