// Step 16 — main roads and bridge: from every gate of the great wall, a road
// out to the map border (towards the neighbouring towns) and a road in to the
// centre; the bridge gate's road crosses the water on a bridge laid at the
// shortest crossing near the gate. Roads are shortest paths over a cost grid
// (steep ground and marsh cost, water and the wall are impassable except at
// the bridge and the gates, earlier roads are a little cheaper so later ones
// join them where it makes sense).
(function (global) {
  'use strict';

  const PITCH = 8;  // routing grid: a cell every 8 units (20 m)
  const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

  /** Binary min-heap of [priority, value]. */
  class Heap {
    constructor() { this.a = []; }
    push(p, v) {
      const a = this.a;
      a.push([p, v]);
      let i = a.length - 1;
      while (i > 0) {
        const j = (i - 1) >> 1;
        if (a[j][0] <= a[i][0]) break;
        [a[i], a[j]] = [a[j], a[i]];
        i = j;
      }
    }
    pop() {
      const a = this.a, top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break;
          [a[i], a[m]] = [a[m], a[i]];
          i = m;
        }
      }
      return top;
    }
    get size() { return this.a.length; }
  }

  /**
   * Cheapest path on the grid from cell `from` to a cell where `isGoal(k)`
   * holds (A* with the straight-line distance to `goal` when given, else
   * Dijkstra). `cost[k]` is the cost per unit length through cell k
   * (Infinity: impassable). Returns the list of cell indices, or null.
   */
  function route(cost, w, h, from, isGoal, goal) {
    const dist = new Float64Array(w * h).fill(Infinity), prev = new Int32Array(w * h).fill(-1);
    const heur = goal >= 0 ? (k) => Math.hypot((k % w) - (goal % w), Math.floor(k / w) - Math.floor(goal / w)) : () => 0;
    const heap = new Heap();
    dist[from] = 0;
    heap.push(heur(from), from);
    while (heap.size) {
      const [, k] = heap.pop();
      if (isGoal(k)) {
        const path = [];
        for (let c = k; c >= 0; c = prev[c]) path.push(c);
        return path.reverse();
      }
      const i = k % w, j = (k - i) / w, dk = dist[k];
      for (const [di, dj, len] of DIRS) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const n = nj * w + ni;
        const c = (cost[k] + cost[n]) / 2;
        if (!isFinite(c)) continue;
        const d = dk + c * len;
        if (d < dist[n]) { dist[n] = d; prev[n] = k; heap.push(d + heur(n), n); }
      }
    }
    return null;
  }

  const RAYS = 72;
  /** Depth of p inside a star-shaped wall (vertices every 2π/RAYS around its centre); negative outside. */
  function wallDepth(wall, p) {
    const dx = p.x - wall.centre.x, dy = p.y - wall.centre.y;
    const t = (((Math.atan2(dy, dx) / (2 * Math.PI)) * RAYS) % RAYS + RAYS) % RAYS;
    const k = Math.floor(t), f = t - k;
    return wall.poly[k % RAYS].r * (1 - f) + wall.poly[(k + 1) % RAYS].r * f - Math.hypot(dx, dy);
  }

  /** Chaikin smoothing (2 rounds) of an open polyline, keeping its ends. */
  function smoothPolyline(pts) {
    for (let round = 0; round < 2; round++) {
      if (pts.length < 3) return pts;
      const out = [pts[0]];
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
        out.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
      }
      out.push(pts[pts.length - 1]);
      pts = out;
    }
    return pts;
  }

  /** Intersections of an open polyline with a closed polygon. */
  function crossings(line, poly) {
    const hits = [];
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i], b = line[i + 1];
      for (let j = 0; j < poly.length; j++) {
        const c = poly[j], d = poly[(j + 1) % poly.length];
        const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
        if (Math.abs(den) < 1e-12) continue;
        const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
        const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) hits.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
      }
    }
    return hits;
  }

  global.RoadsStep = {
    id: 'roads',
    title: 'Main roads and bridge',
    zIndex: 5.5,  // below the walls
    settings: [
      { key: 'slopeCost', label: 'Slope penalty', type: 'range', min: 0, max: 20, step: 1, default: 8 },
      { key: 'marshCost', label: 'Marsh penalty', type: 'range', min: 1, max: 6, step: 0.5, default: 2.5 },
      { key: 'bridgeSearch', label: 'Bridge: search along the bank (m)', type: 'range', min: 0, max: 500, step: 25, default: 250 }
    ],

    run(state, s, rng, ctx) {
      const t0 = performance.now();
      state.roads = [];
      state.bridge = null;
      const site = state.site, walls = state.walls;
      if (!site || !walls) return 'No walls: no roads.';
      const W = ctx.width, H = ctx.height, U = global.Units;
      const pitch = state.fieldPitch || 2;
      const F = (name) => global.Fields.get(state, name, pitch, ctx);
      const water = F('water'), slope = F('terrainSlope'), marsh = state.marsh;
      const outer = walls.find((x) => x.kind === 'outer'), inner = walls.find((x) => x.kind === 'inner');
      const gw = Math.ceil(W / PITCH), gh = Math.ceil(H / PITCH);
      const cellOf = (p) => Math.min(gh - 1, Math.max(0, Math.floor(p.y / PITCH))) * gw + Math.min(gw - 1, Math.max(0, Math.floor(p.x / PITCH)));
      const centre = (k) => ({ x: ((k % gw) + 0.5) * PITCH, y: (Math.floor(k / gw) + 0.5) * PITCH });

      // Cost grid.
      const cost = new Float64Array(gw * gh);
      for (let k = 0; k < cost.length; k++) {
        const p = centre(k);
        if (water.at(p.x, p.y) >= 0.5) { cost[k] = Infinity; continue; }
        cost[k] = 1 + s.slopeCost * slope.at(p.x, p.y);
        if (marsh && marsh.at(p.x, p.y) >= 0.5) cost[k] *= s.marshCost;
      }
      // The great wall is impassable, except within 12 units of a gate.
      const nearGate = (p) => outer.gates.some((g) => Math.hypot(g.x - p.x, g.y - p.y) < 12);
      for (let i = 0; i < outer.poly.length; i++) {
        const a = outer.poly[i], b = outer.poly[(i + 1) % outer.poly.length];
        const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (PITCH / 2));
        for (let t = 0; t <= n; t++) {
          const p = { x: a.x + ((b.x - a.x) * t) / n, y: a.y + ((b.y - a.y) * t) / n };
          if (!nearGate(p)) cost[cellOf(p)] = Infinity;
        }
      }

      // The bridge: the shortest crossing near the bridge gate, roughly square to the course.
      const bridgeGate = outer.gates.find((g) => g.kind === 'bridge');
      let bridge = null;
      if (bridgeGate && site.toWater) {
        const ax = -site.toWater.y, ay = site.toWater.x;  // along the course
        const span = U.toUnits(s.bridgeSearch);
        let best = null;
        for (let off = -span; off <= span; off += 8) {
          for (let ang = -25; ang <= 25; ang += 5) {
            const a = Math.atan2(site.toWater.y, site.toWater.x) + (ang * Math.PI) / 180;
            const dx = Math.cos(a), dy = Math.sin(a);
            const sx = bridgeGate.x + ax * off, sy = bridgeGate.y + ay * off;
            if (water.at(sx, sy) >= 0.5) continue;
            let entry = null, exit = null;
            for (let r = 0; r <= 400; r += 2) {
              const x = sx + dx * r, y = sy + dy * r;
              if (x < 0 || y < 0 || x >= W || y >= H) break;
              const wet = water.at(x, y) >= 0.5;
              if (!entry && wet) entry = r;
              if (entry && !wet) { exit = r; break; }
            }
            if (entry === null || exit === null) continue;
            const length = exit - entry;
            const total = 3 * length + Math.abs(off) + entry;
            if (!best || total < best.total) best = { total: total, a: { x: sx + dx * (entry - 3), y: sy + dy * (entry - 3) }, b: { x: sx + dx * (exit + 3), y: sy + dy * (exit + 3) }, length: length };
          }
        }
        if (best) {
          bridge = { a: best.a, b: best.b, length: best.length, gate: bridgeGate };
          // The bridge cells are passable, cheap.
          const n = Math.ceil(Math.hypot(best.b.x - best.a.x, best.b.y - best.a.y) / (PITCH / 2));
          for (let t = 0; t <= n; t++) cost[cellOf({ x: best.a.x + ((best.b.x - best.a.x) * t) / n, y: best.a.y + ((best.b.y - best.a.y) * t) / n })] = 1;
        }
      }
      state.bridge = bridge;

      // Roads. Earlier roads become cheap so later ones join them.
      const roads = [];
      const isBorder = (k) => { const i = k % gw, j = (k - i) / gw; return i === 0 || j === 0 || i === gw - 1 || j === gh - 1; };
      // To the goal cell (within two cells of it); when it cannot be reached, to any border cell.
      const layRoad = (kind, gate, fromP, goal, through) => {
        const gi = goal % gw, gj = (goal - gi) / gw;
        const nearGoal = (k) => { const i = k % gw, j = (k - i) / gw; return Math.abs(i - gi) <= 2 && Math.abs(j - gj) <= 2; };
        const path = route(cost, gw, gh, cellOf(fromP), nearGoal, goal) || route(cost, gw, gh, cellOf(fromP), isBorder, -1);
        if (!path) return null;
        // Earlier roads are somewhat cheaper, so later ones join them where it makes sense (not at any price).
        for (const k of path) cost[k] = Math.min(cost[k], 0.7);
        let pts = path.map(centre);
        pts[0] = fromP;
        if (through) pts = through.concat(pts);
        const road = { kind: kind, gate: gate, points: smoothPolyline(pts) };
        roads.push(road);
        return road;
      };
      const borderTarget = (from, dir) => {
        // The border point in direction `dir` from `from`.
        let r = 0;
        for (;; r += 4) {
          const x = from.x + dir.x * r, y = from.y + dir.y * r;
          if (x < 0 || y < 0 || x >= W || y >= H) break;
        }
        const x = Math.min(W - 1, Math.max(0, from.x + dir.x * (r - 4))), y = Math.min(H - 1, Math.max(0, from.y + dir.y * (r - 4)));
        return { x: x, y: y };
      };
      const centrePoint = { x: state.core ? state.core.x : site.x, y: state.core ? state.core.y : site.y };
      const centreCell = cellOf(centrePoint);
      let missing = 0;
      // Inward roads first, to the centre.
      for (const gate of outer.gates) if (!layRoad('inward', gate, { x: gate.x, y: gate.y }, centreCell)) missing++;
      // Then the town is closed: an outward road must not cut through it along the cheap axes and out of another gate.
      for (let k = 0; k < cost.length; k++) if (wallDepth(outer, centre(k)) > 2) cost[k] = Infinity;
      for (const gate of outer.gates) {
        // Outward, to the border: from the far bridgehead for the bridge gate.
        let start = { x: gate.x, y: gate.y }, through = null;
        if (gate.kind === 'bridge') {
          if (!bridge) { missing++; continue; }
          start = bridge.b;
          through = [{ x: gate.x, y: gate.y }, bridge.a];
        }
        const dir = { x: Math.cos(gate.angle), y: Math.sin(gate.angle) };
        const target = borderTarget(start, dir);
        const tk = cellOf(target);
        if (!layRoad('outward', gate, start, tk, through)) missing++;
      }
      // Where the inward roads cross the old wall: its gates.
      inner.gates = [];
      for (const road of roads) {
        if (road.kind !== 'inward') continue;
        for (const p of crossings(road.points, inner.poly)) inner.gates.push({ x: p.x, y: p.y, kind: 'inner' });
      }
      state.roads = roads;
      return roads.length + ' roads from ' + outer.gates.length + ' gates' + (missing ? ' (' + missing + ' could not be laid)' : '') +
        (bridge ? ', bridge of ' + Math.round(U.toMetres(bridge.length)) + ' m' : ', no bridge') + ', ' + inner.gates.length + ' gates on the old wall, ' +
        Math.round(performance.now() - t0) + ' ms';
    },

    draw(g, state, ctx) {
      const px = (ctx && ctx.px) || 1;
      if (!state.roads) return;
      g.save();
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (const road of state.roads) {
        if (road.kind === 'inward' && state.blocks) continue;  // intra muros, the streets of step 17 are the roads
        g.strokeStyle = '#6b4a2b';
        g.lineWidth = 2.5 * px;
        g.beginPath();
        road.points.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.stroke();
        g.strokeStyle = '#e6d2a8';
        g.lineWidth = 1 * px;
        g.stroke();
      }
      const b = state.bridge;
      if (b) {
        g.strokeStyle = '#3a2e22';
        g.lineWidth = 5 * px;
        g.beginPath(); g.moveTo(b.a.x, b.a.y); g.lineTo(b.b.x, b.b.y); g.stroke();
        g.strokeStyle = '#fffdf7';
        g.lineWidth = 2 * px;
        g.stroke();
      }
      g.restore();
    }
  };
})(window);
