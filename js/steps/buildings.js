// Step 19 — buildings: one house per lot, on the street, the full width of
// the frontage (party walls), a few metres deep; the back of the lot is the
// yard. Height in floors and the roof (ridge along the street, or a gable to
// the street) are kept for the drawing, which in the plan shows footprints.
(function (global) {
  'use strict';

  /** Keep the part of a convex polygon where nx·x + ny·y <= c. */
  function clipHalf(poly, nx, ny, c) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
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

  global.BuildingsStep = {
    id: 'buildings',
    title: 'Buildings',
    zIndex: 5.3,  // on the lots
    settings: [
      { key: 'depthCentre', label: 'House depth at the centre (m)', type: 'range', min: 5, max: 25, step: 0.5, default: 10 },
      { key: 'depthWall', label: 'House depth at the wall (m)', type: 'range', min: 5, max: 25, step: 0.5, default: 12 },
      { key: 'variation', label: 'Depth variation', type: 'range', min: 0, max: 0.5, step: 0.05, default: 0.25 },
      { key: 'empty', label: 'Share of empty lots (%)', type: 'range', min: 0, max: 30, step: 1, default: 4 },
      { key: 'gables', label: 'Share of gables to the street (%)', type: 'range', min: 0, max: 100, step: 5, default: 35 }
    ],

    run(state, s, rng, ctx) {
      const t0 = performance.now();
      state.buildings = null;
      if (!state.lots) return 'No lots: no buildings.';
      const U = global.Units, toU = U.toUnits;
      const buildings = [];
      let empty = 0;
      for (const lot of state.lots) {
        if (rng.random() * 100 < s.empty) { empty++; continue; }
        // The house: the front of the lot, up to a depth measured from the street line.
        let depth = toU(s.depthCentre + (s.depthWall - s.depthCentre) * lot.zone) * (1 + s.variation * rng.range(-1, 1));
        depth = Math.min(depth, lot.depth);
        const L = lot.inward, c0 = L.x * lot.front.x + L.y * lot.front.y;  // the street line through the front
        let poly = clipHalf(lot.poly, L.x, L.y, c0 + depth);
        if (poly.length < 3 || polygonArea(poly) < 3) continue;
        const floors = lot.zone < 0.4 ? (rng.random() < 0.5 ? 3 : rng.random() < 0.6 ? 4 : 2) : (rng.random() < 0.6 ? 2 : rng.random() < 0.7 ? 3 : 1);
        buildings.push({
          poly: poly, lot: lot, floors: floors, height: 3.2 * floors,
          roof: rng.random() * 100 < s.gables ? 'gable' : 'ridge',  // ridge along the street, or a gable facing it
          depth: depth
        });
      }
      state.buildings = buildings;
      const built = buildings.reduce((a, b) => a + polygonArea(b.poly), 0) * U.METRES_PER_UNIT * U.METRES_PER_UNIT / 10000;
      const floors = buildings.length ? buildings.reduce((a, b) => a + b.floors, 0) / buildings.length : 0;
      return buildings.length + ' buildings on ' + built.toFixed(1) + ' ha (' + floors.toFixed(1) + ' floors on average' + (empty ? ', ' + empty + ' lots left empty' : '') +
        '), ' + Math.round(performance.now() - t0) + ' ms';
    },

    draw(g, state, ctx) {
      const px = (ctx && ctx.px) || 1;
      if (!state.buildings) return;
      g.save();
      g.fillStyle = '#5c4636';
      g.strokeStyle = '#2b2017';
      g.lineWidth = 0.4 * px;
      g.lineJoin = 'round';
      for (const b of state.buildings) {
        g.beginPath();
        b.poly.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
        g.fill();
        g.stroke();
      }
      // Ridge lines, when the zoom shows them (a house is a few units wide).
      if (ctx.scale > 6) {
        g.strokeStyle = 'rgba(255, 240, 220, .55)';
        g.lineWidth = 0.6 * px;
        for (const b of state.buildings) {
          const lot = b.lot, f = lot.front, n = lot.inward, e = lot.along;
          const half = lot.width / 2 - 0.2;
          if (b.roof === 'ridge') {
            // Along the street, at mid depth.
            const d = b.depth / 2;
            g.beginPath();
            g.moveTo(f.x + n.x * d - e.x * half, f.y + n.y * d - e.y * half);
            g.lineTo(f.x + n.x * d + e.x * half, f.y + n.y * d + e.y * half);
            g.stroke();
          } else {
            // Square to the street, through the middle of the front.
            g.beginPath();
            g.moveTo(f.x + n.x * 0.3, f.y + n.y * 0.3);
            g.lineTo(f.x + n.x * (b.depth - 0.3), f.y + n.y * (b.depth - 0.3));
            g.stroke();
          }
        }
      }
      g.restore();
    }
  };
})(window);
