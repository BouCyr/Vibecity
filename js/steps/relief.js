// Step 10 — altitude curve. Every altitude computed so far (cells, nodes,
// per-point polygon altitudes, water cells) is normalized to [0, 1], mapped
// through a user-drawn, strictly increasing curve from (0, 0) to (1, 1), then
// multiplied by the maximum altitude: altitudes are in metres from here on.
// Then the land falls to 0 m at the coast, and the water of the rivers gets a
// consistent level: flat across, strictly decreasing downstream, below the land.
(function (global) {
  'use strict';

  /**
   * Monotone cubic interpolation (Fritsch–Carlson) through (0, 0), the
   * intermediate points [[x, y], …] (increasing in x and y) and (1, 1).
   * Returns f(t) for t in [0, 1]; strictly increasing when the points are.
   */
  function curveFunction(points) {
    const P = [[0, 0]].concat(points || [], [[1, 1]]);
    const n = P.length;
    const d = [], m = new Array(n).fill(0);
    for (let i = 0; i + 1 < n; i++) d.push((P[i + 1][1] - P[i][1]) / (P[i + 1][0] - P[i][0]));
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i + 1 < n; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i + 1 < n; i++) {
      if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
      if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    return (t) => {
      t = Math.max(0, Math.min(1, t));
      let i = 0;
      while (i + 2 < n && t > P[i + 1][0]) i++;
      const h = P[i + 1][0] - P[i][0], s = (t - P[i][0]) / h;
      const s2 = s * s, s3 = s2 * s;
      return (2 * s3 - 3 * s2 + 1) * P[i][1] + (s3 - 2 * s2 + s) * h * m[i] +
        (-2 * s3 + 3 * s2) * P[i + 1][1] + (s3 - s2) * h * m[i + 1];
    };
  }

  /** True if `points` is a list of [x, y] pairs strictly increasing in x and y, inside (0, 1). */
  function validCurve(points) {
    if (!Array.isArray(points)) return false;
    const P = [[0, 0]].concat(points, [[1, 1]]);
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      if (!Array.isArray(p) || p.length !== 2 || !isFinite(p[0]) || !isFinite(p[1])) return false;
      if (i && !(p[0] > P[i - 1][0] && p[1] > P[i - 1][1])) return false;
    }
    return true;
  }

  global.curveFunction = curveFunction;
  global.validCurve = validCurve;

  global.ReliefStep = {
    id: 'relief',
    title: 'Altitude curve',
    // Nothing of its own to draw: the Altitude layer shows the result.
    defaultVisible: false,
    settings: [
      { key: 'curve', label: 'Altitude curve', type: 'curve', default: [[0.167, 0.167], [0.333, 0.333], [0.5, 0.5], [0.667, 0.667], [0.833, 0.833]] },
      { key: 'maxAltitude', label: 'Maximum altitude (m)', type: 'range', min: 10, max: 3000, step: 10, default: 300 },
      { key: 'coastSlope', label: 'Coast slope width (px)', type: 'range', min: 0, max: 600, step: 10, default: 200 },
      { key: 'riverGradient', label: 'Max river gradient (m per 100 px)', type: 'range', min: 1, max: 50, step: 1, default: 10 },
      { key: 'valleyWidth', label: 'Valley width (px)', type: 'range', min: 0, max: 400, step: 10, default: 150 }
    ],

    run(state, s) {
      const cells = state.cells, nodes = state.nodes;
      const f = curveFunction(validCurve(s.curve) ? s.curve : []);
      let min = Infinity, max = -Infinity;
      const scan = (a) => { if (a < min) min = a; if (a > max) max = a; };
      for (const c of cells) {
        scan(c.altitude);
        if (c.polyAlt) c.polyAlt.forEach(scan);
      }
      for (const n of nodes) scan(n.altitude);
      const span = max - min || 1;
      const map = (a) => f((a - min) / span) * s.maxAltitude;
      for (const c of cells) {
        c.altitude = map(c.altitude);
        if (c.polyAlt) c.polyAlt = c.polyAlt.map(map);
      }
      for (const n of nodes) n.altitude = map(n.altitude);
      state.altitudeMax = s.maxAltitude;

      // 1. The land falls to 0 m at the coast: altitudes are multiplied by
      //    smoothstep(distance to the coastline / coastSlope).
      const pk = (p) => Math.round(p.x * 10) + ',' + Math.round(p.y * 10);
      const seaEdges = new Set(), coastSegs = [];
      const edges = (c, fn) => c.poly.forEach((p, k) => fn(p, c.poly[(k + 1) % c.poly.length]));
      for (const c of cells) if (c.sea && c.poly) edges(c, (p, q) => seaEdges.add(pk(p) + '|' + pk(q)));
      for (const c of cells) if (!c.sea && c.poly) edges(c, (p, q) => { if (seaEdges.has(pk(q) + '|' + pk(p))) coastSegs.push([p, q]); });
      const coastPoint = new Set();
      for (const [p, q] of coastSegs) { coastPoint.add(pk(p)); coastPoint.add(pk(q)); }
      const G = 50, grid = new Map();
      coastSegs.forEach((sg, i) => {
        const x0 = Math.floor(Math.min(sg[0].x, sg[1].x) / G), x1 = Math.floor(Math.max(sg[0].x, sg[1].x) / G);
        const y0 = Math.floor(Math.min(sg[0].y, sg[1].y) / G), y1 = Math.floor(Math.max(sg[0].y, sg[1].y) / G);
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
          const k = x + ',' + y;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(i);
        }
      });
      const W = s.coastSlope;
      const coastFactor = (p) => {
        if (!coastSegs.length || W <= 0) return 1;
        if (coastPoint.has(pk(p))) return 0;
        const r = Math.ceil(W / G), gx = Math.floor(p.x / G), gy = Math.floor(p.y / G);
        let d = W;
        for (let x = gx - r; x <= gx + r; x++) for (let y = gy - r; y <= gy + r; y++) {
          for (const i of grid.get(x + ',' + y) || []) {
            const [a, b] = coastSegs[i];
            const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
            const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
            d = Math.min(d, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
          }
        }
        const t = Math.min(1, d / W);
        return t * t * (3 - 2 * t);
      };
      // A node only in sea cells is sea.
      const landNode = new Uint8Array(nodes.length);
      for (const c of cells) if (!c.sea) for (const v of c.nodes) landNode[v] = 1;
      nodes.forEach((n, v) => { n.altitude = landNode[v] ? n.altitude * coastFactor(n) : 0; });
      for (const c of cells) {
        c.altitude = c.sea ? 0 : c.altitude * coastFactor(c.site);
        if (c.polyAlt && !state.riverCellsBuilt) c.polyAlt = c.polyAlt.map((a, k) => (c.sea ? 0 : a * coastFactor(c.poly[k])));
      }

      // 2. Water level along every course: the same on both banks at each
      //    centre-line sample (water is flat across), strictly decreasing
      //    downstream, and below the land around. The fleuve ends at 0 m at its
      //    mouth (without a sea, where it leaves the map); a tributary ends at the
      //    fleuve's level at their confluence. The land touching a river is then
      //    raised just above the water if needed: river nodes are local minima,
      //    only their downstream neighbour is lower.
      const EPS = 0.01;
      const neighbours = nodes.map(() => new Set());
      const ringOf = (c) => (state.riverCellsBuilt ? c.nodes : null);
      for (const c of cells) {
        const ring = ringOf(c) || c.nodes;
        ring.forEach((v, k) => { const u = ring[(k + 1) % ring.length]; neighbours[v].add(u); neighbours[u].add(v); });
      }
      const riverNode = new Set();
      const courses = (state.rivers || []).map((r) => r.sampleNodes || r.nodes.map((v) => [v]));
      for (const samples of courses) for (const ids of samples) for (const v of ids) riverNode.add(v);
      let raised = 0, lowest = Infinity, highest = 0;
      courses.forEach((samples, ri) => {
        const r = state.rivers[ri], last = samples.length - 1;
        const level = new Array(samples.length);
        const mean = (ids) => ids.reduce((a, v) => a + nodes[v].altitude, 0) / Math.max(1, ids.length);
        // End level: the mouth (0 m with a sea), or the fleuve's level at the confluence (already set).
        level[last] = r.kind === 'fleuve' ? (coastSegs.length ? 0 : mean(samples[last])) : mean(samples[last]);
        // Position of each sample (mean of its bank nodes), for the gradient.
        const at = samples.map((ids) => ({ x: ids.reduce((a, v) => a + nodes[v].x, 0) / Math.max(1, ids.length), y: ids.reduce((a, v) => a + nodes[v].y, 0) / Math.max(1, ids.length) }));
        for (let i = last - 1; i >= 0; i--) {
          let landMin = Infinity;
          for (const v of samples[i]) for (const u of neighbours[v]) if (!riverNode.has(u) && landNode[u]) landMin = Math.min(landMin, nodes[u].altitude);
          // Rising upstream by `riverGradient` at most (no waterfall), below the land.
          const step = Math.hypot(at[i].x - at[i + 1].x, at[i].y - at[i + 1].y) * s.riverGradient / 100;
          const cand = Math.min(mean(samples[i]), level[i + 1] + step);
          level[i] = Math.max(cand, level[i + 1] + EPS);
          if (landMin - EPS > level[i + 1] + EPS) level[i] = Math.min(level[i], landMin - EPS);
        }
        samples.forEach((ids, i) => { for (const v of ids) nodes[v].altitude = level[i]; });
        lowest = Math.min(lowest, level[last]);
        highest = Math.max(highest, level[0]);
      });
      // The valleys follow the water: land within `valleyWidth` of a river is
      // lowered towards the level of its nearest bank point (never raised).
      if (s.valleyWidth > 0 && riverNode.size) {
        const VG = 50, vgrid = new Map();
        for (const v of riverNode) {
          const k = Math.floor(nodes[v].x / VG) + ',' + Math.floor(nodes[v].y / VG);
          if (!vgrid.has(k)) vgrid.set(k, []);
          vgrid.get(k).push(v);
        }
        const V = s.valleyWidth, r = Math.ceil(V / VG);
        const carve = (p, a) => {
          const gx = Math.floor(p.x / VG), gy = Math.floor(p.y / VG);
          let best = null;
          for (let x = gx - r; x <= gx + r; x++) for (let y = gy - r; y <= gy + r; y++) {
            for (const v of vgrid.get(x + ',' + y) || []) {
              const d = Math.hypot(nodes[v].x - p.x, nodes[v].y - p.y);
              if (d < V && (!best || d < best.d)) best = { d: d, level: nodes[v].altitude };
            }
          }
          if (!best || a <= best.level) return a;
          const t = best.d / V;
          return best.level + (a - best.level) * t * t * (3 - 2 * t);
        };
        nodes.forEach((n, v) => { if (landNode[v] && !riverNode.has(v)) n.altitude = carve(n, n.altitude); });
        for (const c of cells) if (!c.sea && c.river === undefined) c.altitude = carve(c.site, c.altitude);
      }
      for (const v of riverNode) {
        for (const u of neighbours[v]) {
          // The sea at a mouth is downstream: it stays at 0 m.
          if (riverNode.has(u) || !landNode[u] || nodes[u].altitude >= nodes[v].altitude + EPS) continue;
          nodes[u].altitude = nodes[v].altitude + EPS;
          raised++;
        }
      }

      // 3. Cell centres and per-point altitudes follow: land centres stay above
      //    the water of their ring, water cells take the mean of their ring.
      for (const c of cells) {
        const ring = ringOf(c);
        if (ring) c.polyAlt = ring.map((v) => nodes[v].altitude);
        if (c.sea) continue;
        const alts = ring ? c.polyAlt : c.nodes.map((v) => nodes[v].altitude);
        if (c.river !== undefined) {
          c.altitude = alts.reduce((a, b) => a + b, 0) / alts.length;
        } else {
          const ids = ring || c.nodes;
          let water = -Infinity;
          ids.forEach((v) => { if (riverNode.has(v)) water = Math.max(water, nodes[v].altitude); });
          if (c.altitude < water + EPS) { c.altitude = water + EPS; raised++; }
        }
      }

      let sum = 0, count = 0, top = 0;
      for (const c of cells) {
        if (c.sea || c.river !== undefined) continue;
        sum += c.altitude; count++;
        top = Math.max(top, c.altitude);
      }
      return 'Altitudes in metres: highest ' + Math.round(top) + ' m, mean land ' + Math.round(sum / Math.max(1, count)) + ' m' +
        (courses.length ? '; rivers from ' + highest.toFixed(1) + ' m down to ' + lowest.toFixed(1) + ' m, ' + raised + ' land points raised above the water' : '');
    },

    draw() {}
  };
})(window);
