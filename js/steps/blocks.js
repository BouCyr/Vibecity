// Step 17 — blocks and streets inside the great wall: the Voronoi pipeline
// again, at block scale. Seeds are scattered intra muros, closer together
// towards the centre; pairs of seeds mirrored across the main roads, the old
// wall and the great wall make the Voronoi edges run exactly along them
// (the bisector of a mirrored pair is the line itself). Every edge between
// two inside cells is a street; each cell inset by half the width of its
// streets is a block.
(function (global) {
  'use strict';

  const RAYS = 72;

  /** Radius of a star-shaped wall (vertices every 2π/RAYS around its centre) in direction θ. */
  function starRadius(wall, theta) {
    const t = (((theta / (2 * Math.PI)) * RAYS) % RAYS + RAYS) % RAYS;
    const k = Math.floor(t), f = t - k;
    return wall.poly[k % RAYS].r * (1 - f) + wall.poly[(k + 1) % RAYS].r * f;
  }

  /** Signed depth of p inside a star-shaped wall (positive inside), in map units along the ray. */
  function depth(wall, p) {
    const dx = p.x - wall.centre.x, dy = p.y - wall.centre.y;
    return starRadius(wall, Math.atan2(dy, dx)) - Math.hypot(dx, dy);
  }

  /** Distance from p to a polyline (open, or closed when `closed`). */
  function distToPolyline(p, pts, closed) {
    let best = Infinity;
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0;
      best = Math.min(best, Math.hypot(p.x - a.x - vx * t, p.y - a.y - vy * t));
    }
    return best;
  }

  /** Points every `spacing` along a polyline with the unit normal (left of the direction of travel) at each. */
  function sampleWithNormals(pts, spacing, closed) {
    const out = [];
    const n = closed ? pts.length : pts.length - 1;
    let carry = spacing / 2;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-9) continue;
      const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      let d = carry;
      while (d <= len) {
        out.push({ x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len, nx: nx, ny: ny });
        d += spacing;
      }
      carry = d - len;
    }
    return out;
  }

  /**
   * Inset of a convex polygon, each edge moved inward by its own distance
   * `dist[i]` (edge i runs from vertex i to i + 1). Edges that would be
   * swallowed are dropped. Returns null when nothing is left.
   */
  function insetConvex(poly, dist) {
    let verts = poly.map((p, i) => ({ x: p.x, y: p.y, d: dist[i] }));
    // Orientation: make it counter-clockwise in screen coordinates (y down), so the inward normal is consistent.
    let a2 = 0;
    for (let i = 0; i < verts.length; i++) { const p = verts[i], q = verts[(i + 1) % verts.length]; a2 += p.x * q.y - q.x * p.y; }
    if (a2 < 0) { verts.reverse(); verts = verts.map((v, i, arr) => ({ x: v.x, y: v.y, d: arr[(i + 1) % arr.length].d })); a2 = -a2; }
    for (let guard = 0; guard < 20 && verts.length >= 3; guard++) {
      const n = verts.length;
      // Shifted edge lines: point + inward normal.
      const lines = verts.map((v, i) => {
        const w = verts[(i + 1) % n];
        const ex = w.x - v.x, ey = w.y - v.y, l = Math.hypot(ex, ey) || 1;
        const nx = ey / l, ny = -ex / l;  // inward for a CCW polygon with y down? decided below by the centroid test
        return { px: v.x, py: v.y, ex: ex / l, ey: ey / l, nx: nx, ny: ny, d: v.d };
      });
      // The inward normal points towards the centroid.
      const c = global.polygonCentroid(verts);
      for (const L of lines) if ((c.x - L.px) * L.nx + (c.y - L.py) * L.ny < 0) { L.nx = -L.nx; L.ny = -L.ny; }
      const out = [];
      let bad = -1;
      for (let i = 0; i < n; i++) {
        const A = lines[(i + n - 1) % n], B = lines[i];
        // Intersection of the two shifted lines.
        const ax = A.px + A.nx * A.d, ay = A.py + A.ny * A.d, bx = B.px + B.nx * B.d, by = B.py + B.ny * B.d;
        const den = A.ex * B.ey - A.ey * B.ex;
        if (Math.abs(den) < 1e-9) { bad = i; break; }
        const t = ((bx - ax) * B.ey - (by - ay) * B.ex) / den;
        out.push({ x: ax + A.ex * t, y: ay + A.ey * t });
      }
      if (bad < 0) {
        // An edge whose new direction reverses was swallowed: drop its vertex and retry.
        for (let i = 0; i < n; i++) {
          const p = out[i], q = out[(i + 1) % n];
          if ((q.x - p.x) * lines[i].ex + (q.y - p.y) * lines[i].ey <= 0) { bad = i; break; }
        }
      }
      if (bad < 0) return out;
      // Merge the swallowed edge into its neighbour (keep the larger inset).
      const next = (bad + 1) % n;
      verts[next] = { x: verts[next].x, y: verts[next].y, d: Math.max(verts[next].d, verts[bad].d) };
      verts.splice(bad, 1);
    }
    return null;
  }

  function polygonArea(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y; }
    return Math.abs(a) / 2;
  }

  global.BlocksStep = {
    id: 'blocks',
    title: 'Blocks and streets',
    zIndex: 5.2,  // above the terrain, below the roads and the walls
    settings: [
      { key: 'blockCentre', label: 'Block size at the centre (m)', type: 'range', min: 40, max: 150, step: 5, default: 70 },
      { key: 'blockWall', label: 'Block size at the wall (m)', type: 'range', min: 40, max: 200, step: 5, default: 110 },
      { key: 'streetWidth', label: 'Street width (m)', type: 'range', min: 2, max: 10, step: 0.5, default: 4 },
      { key: 'mainWidth', label: 'Main street width (m)', type: 'range', min: 4, max: 16, step: 0.5, default: 9 },
      { key: 'relax', label: 'Lloyd relaxation', type: 'range', min: 0, max: 4, step: 1, default: 1 }
    ],

    run(state, s, rng, ctx) {
      const t0 = performance.now();
      state.blocks = null;
      state.streets = null;
      const walls = state.walls;
      if (!walls || !state.site) return 'No walls: no blocks.';
      const U = global.Units;
      const outer = walls.find((x) => x.kind === 'outer'), inner = walls.find((x) => x.kind === 'inner');
      const core = state.core || state.site;
      const rMax = Math.max(...outer.poly.map((p) => p.r));
      const bC = U.toUnits(s.blockCentre), bW = U.toUnits(s.blockWall);
      /** Block spacing at p: from the centre size at the core to the wall size at the wall. */
      const spacingAt = (p) => {
        const t = Math.min(1, Math.hypot(p.x - core.x, p.y - core.y) / rMax);
        return bC + (bW - bC) * t;
      };

      // Guide lines the streets must follow: the inward roads (their part inside the wall), the old wall, the great wall.
      // The wall's pairs come first: they must be there, the others yield to them.
      const guides = [{ pts: outer.poly, closed: true, kind: 'wall' }, { pts: inner.poly, closed: true, kind: 'ring' }];
      for (const road of state.roads || []) {
        if (road.kind !== 'inward') continue;
        const pts = road.points.filter((p) => depth(outer, p) > 2);
        if (pts.length > 1) guides.push({ pts: pts, closed: false, kind: 'main' });
      }

      // Seeds. Mirrored pairs along the guides first (they must be there), then the interior.
      const seeds = [];  // { x, y, inside, fixed }
      const cellSize = bC / Math.SQRT2;
      const bx0 = outer.centre.x - rMax - bW, by0 = outer.centre.y - rMax - bW, bx1 = outer.centre.x + rMax + bW, by1 = outer.centre.y + rMax + bW;
      const gw = Math.ceil((bx1 - bx0) / cellSize), gh = Math.ceil((by1 - by0) / cellSize);
      const grid = Array.from({ length: gw * gh }, () => []);
      const gi = (p) => Math.min(gh - 1, Math.max(0, Math.floor((p.y - by0) / cellSize))) * gw + Math.min(gw - 1, Math.max(0, Math.floor((p.x - bx0) / cellSize)));
      const tooClose = (p, r) => {
        const cx = Math.floor((p.x - bx0) / cellSize), cy = Math.floor((p.y - by0) / cellSize), reach = Math.ceil(r / cellSize);
        for (let j = cy - reach; j <= cy + reach; j++) {
          if (j < 0 || j >= gh) continue;
          for (let i = cx - reach; i <= cx + reach; i++) {
            if (i < 0 || i >= gw) continue;
            for (const k of grid[j * gw + i]) if (Math.hypot(seeds[k].x - p.x, seeds[k].y - p.y) < r) return true;
          }
        }
        return false;
      };
      const addSeed = (p, inside, fixed) => { seeds.push({ x: p.x, y: p.y, inside: inside, fixed: fixed }); grid[gi(p)].push(seeds.length - 1); };
      for (const guide of guides) {
        const spacing = guide.kind === 'wall' ? bW * 0.8 : bC * 0.9;
        for (const q of sampleWithNormals(guide.pts, spacing, guide.closed)) {
          const off = (guide.kind === 'wall' ? bW : spacingAt(q)) * 0.35;
          const a = { x: q.x + q.nx * off, y: q.y + q.ny * off }, b = { x: q.x - q.nx * off, y: q.y - q.ny * off };
          const da = depth(outer, a), db = depth(outer, b);
          if (guide.kind === 'wall') {
            // One seed just inside, its mirror just outside (the outside cells are dropped).
            if (tooClose(a, off * 0.8) || tooClose(b, off * 0.8)) continue;
            addSeed(a, da > 0, true);
            addSeed(b, db > 0, true);
          } else {
            if (da < off * 0.5 || db < off * 0.5) continue;  // the guide runs too close to the wall here
            if (tooClose(a, off * 0.8) || tooClose(b, off * 0.8)) continue;
            addSeed(a, true, true);
            addSeed(b, true, true);
          }
        }
      }
      // Interior seeds by dart throwing, the distance between seeds growing from the core to the wall.
      const attempts = Math.ceil(((bx1 - bx0) * (by1 - by0)) / (bC * bC)) * 30;
      for (let t = 0; t < attempts; t++) {
        const p = { x: rng.range(bx0, bx1), y: rng.range(by0, by1) };
        const r = spacingAt(p);
        if (depth(outer, p) < r * 0.45) continue;
        if (tooClose(p, r * 0.85)) continue;
        addSeed(p, true, false);
      }

      // Voronoi, relaxed (interior seeds only move), in the enlarged bounding box.
      const box = { x0: bx0, y0: by0, x1: bx1, y1: by1 };
      let sites = seeds.map((q) => ({ x: q.x, y: q.y }));
      let cells = global.computeVoronoi(sites, box);
      for (let it = 0; it < s.relax; it++) {
        sites = cells.map((c, i) => (seeds[i].fixed ? sites[i] : global.polygonCentroid(c.poly)));
        cells = global.computeVoronoi(sites, box);
      }

      // Streets: edges between two inside cells, classified by the guide they lie on; blocks: inside cells inset.
      const wStreet = U.toUnits(s.streetWidth), wMain = U.toUnits(s.mainWidth), wRing = (wStreet + wMain) / 2;
      const key = (p) => Math.round(p.x * 10) + ',' + Math.round(p.y * 10);
      const edgeKey = (a, b) => { const x = key(a), y = key(b); return x < y ? x + '|' + y : y + '|' + x; };
      const streets = new Map();
      const classify = (a, b) => {
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        for (const guide of guides) {
          if (guide.kind === 'wall') continue;
          if (distToPolyline(m, guide.pts, guide.closed) < 2.5) return guide.kind;
        }
        return 'street';
      };
      const widthOf = (kind) => (kind === 'main' ? wMain : kind === 'ring' ? wRing : wStreet);
      const blocks = [];
      let dropped = 0;
      const wallClip = (poly) => {
        // Clip a cell by the star-shaped wall: vertices below the wall go, crossings are found by bisection on the depth.
        const d = poly.map((p) => depth(outer, p));
        if (d.every((v) => v >= 0)) return poly;
        const cross = (p, q, dp, dq) => {
          let lo = 0, hi = 1, flo = dp;
          for (let it = 0; it < 12; it++) {
            const mid = (lo + hi) / 2, fm = depth(outer, { x: p.x + (q.x - p.x) * mid, y: p.y + (q.y - p.y) * mid });
            if ((fm >= 0) === (flo >= 0)) { lo = mid; flo = fm; } else hi = mid;
          }
          const t = (lo + hi) / 2;
          return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
        };
        const out = [];
        for (let m = 0; m < poly.length; m++) {
          const p = poly[m], q = poly[(m + 1) % poly.length], dp = d[m], dq = d[(m + 1) % poly.length];
          if (dp >= 0) out.push(p);
          if ((dp >= 0) !== (dq >= 0)) out.push(cross(p, q, dp, dq));
        }
        return out;
      };
      cells.forEach((c, i) => {
        if (!seeds[i].inside) return;
        const poly = wallClip(c.poly);
        if (poly.length < 3) return;
        const dist = [];
        for (let k = 0; k < poly.length; k++) {
          const a = poly[k], b = poly[(k + 1) % poly.length];
          // Which neighbour shares this edge? The one whose polygon has both ends.
          let shared = -1;
          for (const j of c.neighbors) {
            const pj = cells[j].poly;
            if (pj.some((p) => key(p) === key(a)) && pj.some((p) => key(p) === key(b))) { shared = j; break; }
          }
          if (shared >= 0 && seeds[shared].inside) {
            const kind = classify(a, b);
            const ek = edgeKey(a, b);
            if (!streets.has(ek)) streets.set(ek, { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, kind: kind, width: widthOf(kind), cells: [i, shared] });
            dist.push(widthOf(kind) / 2);
          } else {
            dist.push(1.5);  // against the wall (or the box): a narrow gap, the wall walk
          }
        }
        const inset = insetConvex(poly, dist);
        if (!inset || polygonArea(inset) < 60) { dropped++; return; }
        blocks.push({ poly: inset, cell: poly.map((p) => ({ x: p.x, y: p.y })), centre: global.polygonCentroid(inset), area: polygonArea(inset), seed: i });
      });

      state.blocks = blocks;
      state.streets = Array.from(streets.values());
      state.intraMuros = outer.poly.map((p) => ({ x: p.x, y: p.y }));
      const kinds = { main: 0, ring: 0, street: 0 };
      for (const st of state.streets) kinds[st.kind]++;
      const totalArea = blocks.reduce((a, b) => a + b.area, 0) * U.METRES_PER_UNIT * U.METRES_PER_UNIT / 10000;
      return blocks.length + ' blocks (' + totalArea.toFixed(1) + ' ha built, ' + seeds.filter((q) => q.inside).length + ' seeds' +
        (dropped ? ', ' + dropped + ' too small dropped' : '') + '), ' + state.streets.length + ' street edges (' + kinds.main + ' on the axes, ' +
        kinds.ring + ' along the old wall, ' + kinds.street + ' others), ' + Math.round(performance.now() - t0) + ' ms';
    },

    draw(g, state, ctx) {
      const px = (ctx && ctx.px) || 1;
      if (!state.blocks) return;
      g.save();
      // The street bed: the whole intra muros in a light tone, the blocks on top.
      g.fillStyle = '#f3ead6';
      g.beginPath();
      state.intraMuros.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
      g.fill();
      g.fillStyle = '#d8c6a0';
      g.strokeStyle = '#5a4632';
      g.lineWidth = 0.6 * px;
      g.lineJoin = 'round';
      for (const b of state.blocks) {
        g.beginPath();
        b.poly.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
        g.fill();
        g.stroke();
      }
      g.restore();
    }
  };
})(window);
