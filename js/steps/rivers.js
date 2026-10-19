// Step 6 — rivers. The fleuve and its tributaries follow Voronoi edges between
// two land cells, chosen by a "longest climb": from its mouth, a course is the
// longest path (in px) to a map border along which the distance to the coast
// (for a tributary: to the coast or an existing course) strictly increases.
// Altitude is then made consistent with the water, either by carving valleys
// into the existing relief or by recomputing it from the distances to the coast
// and to the rivers.
(function (global) {
  'use strict';

  const EPS = 1e-6;
  const SIDES = ['N', 'E', 'S', 'W'];
  const edgeKey = (a, b) => (a < b ? a + ',' + b : b + ',' + a);
  const smoothstep = (t) => t * t * (3 - 2 * t);

  function sideOf(n, w, h) {
    if (n.y <= EPS) return 'N';
    if (n.x >= w - EPS) return 'E';
    if (n.y >= h - EPS) return 'S';
    if (n.x <= EPS) return 'W';
    return null;
  }

  function distToSegment(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return { d: Math.hypot(a.x + t * dx - px, a.y + t * dy - py), t: t };
  }

  /** Minimal binary heap of [cost, node]. */
  function Heap() { this.a = []; }
  Heap.prototype.push = function (c, n) {
    const a = this.a; a.push([c, n]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  };
  Heap.prototype.pop = function () {
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
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  };

  const CONFLUENCE_SCALE = 120;   // px (straight line) upstream used to measure a confluence angle
  // Smoothing radii (px) under which a confluence angle must stay <= 90°: step 7
  // smooths the courses afterwards, which can open a confluence by a few degrees.
  const CONFLUENCE_CHECK_RADII = [0, 10, 15, 20, 25, 30];

  /**
   * First point upstream of index `end` that is `len` px away from pts[end] as
   * the crow flies (the start of the course if none). Straight-line distance
   * keeps the measure stable whether the course zigzags or has been smoothed.
   */
  function pointUpstream(pts, end, len) {
    const c = pts[end];
    for (let k = end; k > 0; k--) {
      const a = pts[k], b = pts[k - 1];
      const db = Math.hypot(b.x - c.x, b.y - c.y);
      if (db < len) continue;
      // Crossing of the circle of radius len on segment a→b.
      const dx = b.x - a.x, dy = b.y - a.y, fx = a.x - c.x, fy = a.y - c.y;
      const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - len * len;
      const t = A > 0 ? Math.max(0, Math.min(1, (-B + Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A))) : 0;
      return { x: a.x + t * dx, y: a.y + t * dy };
    }
    return pts[0];
  }

  /** Angle (degrees) at pts1[end1] between the two upstream branches. */
  function upstreamAngle(pts1, end1, pts2, end2) {
    const c = pts1[end1];
    const a = pointUpstream(pts1, end1, CONFLUENCE_SCALE), b = pointUpstream(pts2, end2, CONFLUENCE_SCALE);
    const ax = a.x - c.x, ay = a.y - c.y, bx = b.x - c.x, by = b.y - c.y;
    const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  }

  global.upstreamAngle = upstreamAngle;

  global.RiversStep = {
    id: 'rivers',
    title: 'Rivers',
    // Above the sea and coast, under the Voronoi edges.
    zIndex: -0.35,
    settings: [
      {
        key: 'count', label: 'Watercourses', type: 'select', default: '3',
        options: [
          { value: '0', label: 'None' },
          { value: '1', label: '1 (fleuve)' },
          { value: '2', label: '2 (fleuve + 1 river)' },
          { value: '3', label: '3 (fleuve + 2 rivers)' }
        ]
      },
      {
        key: 'altitudeMode', label: 'Altitude', type: 'select', default: 'carve',
        options: [
          { value: 'carve', label: 'Carve valleys into the relief' },
          { value: 'recompute', label: 'Recompute from coast and rivers' }
        ]
      },
      { key: 'firstConfluence', label: 'First confluence from the mouth (px)', type: 'range', min: 0, max: 600, step: 10, default: 100 },
      { key: 'confluenceGap', label: 'Gap between confluences (px)', type: 'range', min: 0, max: 400, step: 10, default: 50 },
      { key: 'fleuveWidth', label: 'Fleuve width (px)', type: 'range', min: 4, max: 80, step: 1, default: 32 },
      { key: 'riverWidth', label: 'River width (px)', type: 'range', min: 2, max: 40, step: 1, default: 16 },
      { key: 'valleyWidth', label: 'Valley width (carve, px)', type: 'range', min: 20, max: 600, step: 10, default: 200 },
      { key: 'reliefKept', label: 'Relief kept (recompute)', type: 'range', min: 0, max: 1, step: 0.05, default: 0.35 }
    ],

    run(state, s, rng, ctx) {
      const W = ctx.width, H = ctx.height;
      const cells = state.cells, nodes = state.nodes;
      state.rivers = [];
      state.riverEdges = new Map();
      state.riverPins = new Set();
      for (const n of nodes) n.river = -1;
      for (const c of cells) c.riverbank = false;

      // How many courses.
      const fronts = state.seaFronts || [];
      // Without a sea, the nodes of a drawn exit edge play the coast's role.
      const noSea = !fronts.length;
      // Fleuve + up to 2 tributaries (an old 'auto' value counts as 3).
      const count = s.count === 'auto' ? 3 : Math.max(0, Math.min(3, Number(s.count) || 0));
      if (!count) return 'no watercourse';

      // Graph: edges between two land cells.
      const owners = new Map();
      cells.forEach((c, ci) => {
        const ns = c.nodes;
        for (let k = 0; k < ns.length; k++) {
          const key = edgeKey(ns[k], ns[(k + 1) % ns.length]);
          if (owners.has(key)) owners.get(key).push(ci); else owners.set(key, [ci]);
        }
      });
      const adj = nodes.map(() => []);
      for (const [key, list] of owners) {
        if (list.length !== 2 || cells[list[0]].sea || cells[list[1]].sea) continue;
        const [a, b] = key.split(',').map(Number);
        adj[a].push(b); adj[b].push(a);
      }
      for (const list of adj) list.sort((x, y) => x - y);

      const len = (u, v) => Math.hypot(nodes[v].x - nodes[u].x, nodes[v].y - nodes[u].y);
      const all = nodes.map((n, i) => i);

      /** Shortest distance (px, along land edges) to any of `sources`. */
      const distanceField = (sources) => {
        const D = new Float64Array(nodes.length).fill(Infinity);
        const heap = new Heap();
        for (const i of sources) { D[i] = 0; heap.push(0, i); }
        while (heap.a.length) {
          const [d, u] = heap.pop();
          if (d > D[u]) continue;
          for (const v of adj[u]) {
            const nd = d + len(u, v);
            if (nd < D[v]) { D[v] = nd; heap.push(nd, v); }
          }
        }
        return D;
      };

      /**
       * Longest path (px) from `start` along which D strictly increases, ending on
       * a node accepted by `endOk`; `firstOk(v)` filters the first step. Dynamic
       * programming over the nodes sorted by D. A node (other than the start)
       * with an edge to an `endOk` node is terminal: the course takes that edge
       * and ends, even if a longer path exists. Returns node ids end → start.
       */
      const sortedByD = new WeakMap();
      const longestClimb = (start, D, endOk, firstOk) => {
        if (!sortedByD.has(D)) sortedByD.set(D, all.filter((i) => isFinite(D[i])).sort((a, b) => D[a] - D[b] || a - b));
        const order = sortedByD.get(D).filter((i) => D[i] >= D[start]);
        const best = new Float64Array(nodes.length).fill(-1);
        const prev = new Int32Array(nodes.length).fill(-1);
        best[start] = 0;
        for (const u of order) {
          if (best[u] < 0) continue;
          const exits = u === start ? [] : adj[u].filter(endOk);
          for (const v of exits.length ? exits : adj[u]) {
            if (!exits.length && !(D[v] > D[u] + 1e-9)) continue;
            if (u === start && firstOk && !firstOk(v)) continue;
            const l = best[u] + len(u, v);
            if (l > best[v] + 1e-9) { best[v] = l; prev[v] = u; }
          }
        }
        let end = -1;
        for (let i = 0; i < nodes.length; i++) {
          if (i === start || best[i] < 0 || !endOk(i)) continue;
          if (end < 0 || best[i] > best[end] + 1e-9) end = i;
        }
        if (end < 0) return null;
        const path = [];
        for (let v = end; v >= 0; v = prev[v]) path.push(v);
        return path;
      };

      // Coast: sea coast nodes, or (no sea) the nodes of a drawn exit edge.
      let exitSide = null;
      let coast;
      if (noSea) {
        exitSide = SIDES[rng.int(0, 3)];
        coast = all.filter((i) => sideOf(nodes[i], W, H) === exitSide && adj[i].length);
      } else {
        coast = all.filter((i) => nodes[i].coast && adj[i].length);
      }
      if (!coast.length) return 'no watercourse (no reachable ' + (noSea ? 'exit' : 'coast') + ')';
      const toBorder = (i) => {
        const side = sideOf(nodes[i], W, H);
        return side !== null && side !== exitSide;
      };

      // Fleuve: mouth = coast node nearest to the map center; if no course climbs
      // from it to a map edge, the next coast nodes by distance to the center.
      const center = (i) => Math.hypot(nodes[i].x - W / 2, nodes[i].y - H / 2);
      const Dcoast = distanceField(coast);
      let fPath = null, mouth = -1, tried = 0;
      for (const m of coast.slice().sort((a, b) => center(a) - center(b) || a - b)) {
        tried++;
        fPath = longestClimb(m, Dcoast, toBorder, null);
        if (fPath) { mouth = m; break; }
      }
      if (!fPath) return 'no watercourse (no land path from the coast to a map edge)';
      const fleuveSide = sideOf(nodes[fPath[0]], W, H);
      state.rivers.push({ kind: 'fleuve', side: fleuveSide, nodes: fPath, joins: null, mouth: mouth });

      // Tributaries: every fleuve node more than `firstConfluence` px from the mouth
      // is tried as a junction; the longest valid tributary is kept. The next one
      // must be on the other bank, `confluenceGap` px or more from previous junctions.
      const fPts = fPath.map((v) => nodes[v]);
      const fromMouth = new Array(fPath.length).fill(0); // arc length from the mouth
      for (let k = fPath.length - 2; k >= 0; k--) fromMouth[k] = fromMouth[k + 1] + len(fPath[k], fPath[k + 1]);
      // Bank of point p seen from fleuve index k: sign of cross(downstream direction, p - junction).
      const bankAt = (k, p) => {
        const up = pointUpstream(fPts, k, CONFLUENCE_SCALE), J = fPts[k];
        const dx = J.x - up.x, dy = J.y - up.y;
        return Math.sign(dx * (p.y - J.y) - dy * (p.x - J.x)) || 1;
      };
      const pathLength = (path) => {
        let l = 0;
        for (let i = 0; i + 1 < path.length; i++) l += len(path[i], path[i + 1]);
        return l;
      };
      const notes = [];
      const junctionArcs = [];
      let lastBank = 0;
      for (let t = 1; t < count; t++) {
        const D = distanceField(coast.concat(...state.rivers.map((r) => r.nodes)));
        let found = null;
        for (let k = fPath.length - 2; k > 0; k--) {
          if (fromMouth[k] <= s.firstConfluence) continue;
          if (junctionArcs.some((a) => Math.abs(fromMouth[k] - a) < s.confluenceGap)) continue;
          const firstOk = lastBank ? (v) => bankAt(k, nodes[v]) === -lastBank : null;
          const path = longestClimb(fPath[k], D, toBorder, firstOk);
          if (!path) continue;
          const length = pathLength(path);
          // Longest wins; ties keep the junction nearest to the mouth (found first).
          if (found && length <= found.length + 1e-9) continue;
          const pts = path.map((v) => nodes[v]);
          const bank = bankAt(k, pointUpstream(pts, pts.length - 1, CONFLUENCE_SCALE));
          if (lastBank && bank !== -lastBank) continue;
          // Worst angle over the smoothing radii step 7 may use (junction kept in place).
          let angle = 0;
          for (const r of CONFLUENCE_CHECK_RADII) {
            const f2 = r ? smoothPolyline(fPts.slice(0, k + 1), false, r) : fPts.slice(0, k + 1);
            const t2 = r ? smoothPolyline(pts, false, r) : pts;
            angle = Math.max(angle, upstreamAngle(f2, f2.length - 1, t2, t2.length - 1));
          }
          // 2° margin: step 7 splits and smooths the courses slightly differently.
          if (angle <= 88) found = { path: path, k: k, angle: angle, bank: bank, length: length };
        }
        if (!found) {
          notes.push('river ' + t + ' skipped: no confluence at 90° or less' + (lastBank ? ' on the other bank' : ''));
          break;
        }
        const join = found.path[found.path.length - 1];
        state.rivers.push({ kind: 'river', side: sideOf(nodes[found.path[0]], W, H), nodes: found.path, joins: 0, mouth: join });
        notes.push('river from ' + state.rivers[state.rivers.length - 1].side + ', ' + Math.round(found.length) + ' px, joins ' +
          Math.round(fromMouth[found.k]) + ' px upstream of the mouth, ' + (found.bank > 0 ? 'right' : 'left') + ' bank, ' +
          Math.round(found.angle) + '°');
        junctionArcs.push(fromMouth[found.k]);
        lastBank = found.bank;
      }

      const coastSegs = (state.coastline || []).map(([a, b]) => [nodes[a], nodes[b]]);
      const distCoast = (x, y) => {
        let best = Infinity;
        for (const [a, b] of coastSegs) best = Math.min(best, distToSegment(x, y, a, b).d);
        return best;
      };
      const carve = s.altitudeMode === 'carve';

      // Widths, flags, pinned nodes.
      state.rivers.forEach((r, ri) => {
        const n = r.nodes.length;
        const base = r.kind === 'fleuve' ? s.fleuveWidth : s.riverWidth;
        r.widths = r.nodes.map((v, k) => base * ((r.kind === 'fleuve' ? 0.6 : 0.7) + (r.kind === 'fleuve' ? 0.4 : 0.3) * (k / Math.max(1, n - 1))));
        r.nodes.forEach((v) => { if (nodes[v].river < 0) nodes[v].river = ri; });
        for (let k = 0; k + 1 < n; k++) {
          const key = edgeKey(r.nodes[k], r.nodes[k + 1]);
          state.riverEdges.set(key, ri);
          for (const ci of owners.get(key)) cells[ci].riverbank = true;
        }
        state.riverPins.add(r.nodes[0]);
        state.riverPins.add(r.nodes[n - 1]);
      });

      // Altitude.
      const courses = state.rivers;
      const monotonic = () => {
        for (const r of courses) {
          const ns = r.nodes, last = ns.length - 1;
          for (let k = 1; k < last; k++) nodes[ns[k]].altitude = Math.min(nodes[ns[k]].altitude, nodes[ns[k - 1]].altitude - 1e-4);
          if (r.kind === 'fleuve') {
            nodes[ns[last]].altitude = Math.min(nodes[ns[last]].altitude, nodes[ns[last - 1]].altitude - 1e-4);
          } else {
            // The confluence altitude belongs to the fleuve: raise the river just above it if needed.
            for (let k = last - 1; k >= 0; k--) {
              nodes[ns[k]].altitude = Math.max(nodes[ns[k]].altitude, nodes[ns[k + 1]].altitude + 1e-4);
            }
          }
        }
      };
      const segs = [];
      for (const r of courses) {
        for (let k = 0; k + 1 < r.nodes.length; k++) segs.push([nodes[r.nodes[k]], nodes[r.nodes[k + 1]]]);
      }
      const nearestCourse = (x, y) => {
        let best = { d: Infinity, a: 0 };
        for (const [a, b] of segs) {
          const r = distToSegment(x, y, a, b);
          if (r.d < best.d) best = { d: r.d, a: a.altitude + (b.altitude - a.altitude) * r.t };
        }
        return best;
      };
      const landPoints = [];
      for (const c of cells) if (!c.sea) landPoints.push({ x: c.site.x, y: c.site.y, o: c });
      for (const n of nodes) if (!n.sea) landPoints.push({ x: n.x, y: n.y, o: n });

      if (carve) {
        monotonic();
        for (const p of landPoints) {
          const near = nearestCourse(p.x, p.y);
          const t = smoothstep(Math.min(1, near.d / s.valleyWidth));
          p.o.altitude = Math.min(p.o.altitude, near.a + (p.o.altitude - near.a) * t);
        }
      } else {
        let min = Infinity, max = -Infinity;
        const vals = landPoints.map((p) => {
          const dc = smoothstep(Math.min(1, distCoast(p.x, p.y) / 700));
          let dr = Infinity;
          for (const [a, b] of segs) dr = Math.min(dr, distToSegment(p.x, p.y, a, b).d);
          const v = (1 - s.reliefKept) * (0.6 * dc + 0.4 * smoothstep(Math.min(1, dr / 300))) + s.reliefKept * p.o.altitude;
          min = Math.min(min, v); max = Math.max(max, v);
          return v;
        });
        const span = max - min || 1;
        landPoints.forEach((p, i) => { p.o.altitude = 0.02 + 0.98 * (vals[i] - min) / span; });
        monotonic();
      }

      const f = state.rivers[0];
      return 'fleuve from ' + f.side + ', ' + f.nodes.length + ' nodes' + (tried > 1 ? ' (mouth #' + tried + ' by distance to the center)' : '') + (notes.length ? '; ' + notes.join('; ') : '') +
        '; altitude: ' + (carve ? 'carved' : 'recomputed');
    },

    draw(g, state) {
      if (!state.rivers || !state.rivers.length) return;
      const paths = state.riverPaths || state.rivers.map((r) => ({
        points: r.nodes.map((v) => state.nodes[v]),
        widths: r.widths
      }));
      g.lineCap = 'round';
      g.lineJoin = 'round';
      // Dark banks first, then water on top, so courses merge cleanly at confluences.
      for (const pass of [0, 1]) {
        g.strokeStyle = pass ? '#5f86a8' : '#2f3f52';
        for (const p of paths) {
          for (let k = 0; k + 1 < p.points.length; k++) {
            const w = (p.widths[k] + p.widths[k + 1]) / 2;
            g.lineWidth = pass ? w : w + 5;
            g.beginPath();
            g.moveTo(p.points[k].x, p.points[k].y);
            g.lineTo(p.points[k + 1].x, p.points[k + 1].y);
            g.stroke();
          }
        }
      }
    }
  };
})(window);
