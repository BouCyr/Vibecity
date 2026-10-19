// Step 6 — rivers. The fleuve and its tributaries follow Voronoi edges between
// two land cells, along a path from the mouth to a map border on which the
// distance to the coast (for a tributary: to the coast or an existing course)
// strictly increases. The border end is the one reached by the longest such
// path; the course follows the shortest (default) or the longest one to it.
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
  // Smoothing radii (px) under which a confluence angle must stay within the limits: step 7
  // smooths the courses afterwards, which can open a confluence by a few degrees.
  const CONFLUENCE_CHECK_RADII = [0, 10, 15, 20, 25, 30];
  // Minimum confluence angle (degrees), checked at these distances (px) from the
  // junction too, so that a branch cannot run alongside the other before joining.
  const MIN_CONFLUENCE_ANGLE = 25;
  const MAX_CONFLUENCE_ANGLE = 75;
  const MIN_ANGLE_SCALES = [40, 80, CONFLUENCE_SCALE];

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
  function upstreamAngle(pts1, end1, pts2, end2, scale) {
    const c = pts1[end1];
    const a = pointUpstream(pts1, end1, scale || CONFLUENCE_SCALE), b = pointUpstream(pts2, end2, scale || CONFLUENCE_SCALE);
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
        key: 'route', label: 'Course', type: 'select', default: 'shortest',
        options: [
          { value: 'shortest', label: 'Shortest climb (fewer meanders)' },
          { value: 'longest', label: 'Longest climb' }
        ]
      },
      {
        key: 'altitudeMode', label: 'Altitude', type: 'select', default: 'carve',
        options: [
          { value: 'carve', label: 'Carve valleys into the relief' },
          { value: 'recompute', label: 'Recompute from coast and rivers' }
        ]
      },
      { key: 'meanders', label: 'Meanders per course', type: 'range', min: 0, max: 10, step: 1, default: 5 },
      { key: 'meanderTolerance', label: 'Detour slope tolerance (px)', type: 'range', min: 0, max: 60, step: 1, default: 20 },
      { key: 'meanderCandidates', label: 'Meander candidates', type: 'range', min: 1, max: 10, step: 1, default: 3 },
      { key: 'firstConfluence', label: 'First confluence from the mouth (px)', type: 'range', min: 0, max: 800, step: 10, default: 200 },
      { key: 'confluenceGap', label: 'Gap between confluences (px)', type: 'range', min: 0, max: 400, step: 10, default: 100 },
      { key: 'fleuveWidth', label: 'Fleuve width (px)', type: 'range', min: 4, max: 60, step: 1, default: 20 },
      { key: 'riverWidth', label: 'River width (px)', type: 'range', min: 2, max: 40, step: 1, default: 15 },
      { key: 'junctionWidthGain', label: 'Fleuve widening per confluence (px)', type: 'range', min: 0, max: 15, step: 1, default: 3 },
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
       * Course from `start` along which D strictly increases, ending on a node
       * accepted by `endOk`; `firstOk(v)` filters the first step. Dynamic
       * programming over the nodes sorted by D, keeping both the longest and the
       * shortest path (px) to every node. The end is the one reached by the
       * longest such path (the course crosses the map); with the 'shortest'
       * route, the course then takes the shortest climbing path to that end
       * (fewer meanders). A node (other than the start) with an edge to an
       * `endOk` node is terminal: the course takes that edge and ends. Returns
       * node ids end → start.
       */
      const sortedByD = new WeakMap();
      const longestClimb = (start, D, endOk, firstOk) => {
        if (!sortedByD.has(D)) sortedByD.set(D, all.filter((i) => isFinite(D[i])).sort((a, b) => D[a] - D[b] || a - b));
        const order = sortedByD.get(D).filter((i) => D[i] >= D[start]);
        const best = new Float64Array(nodes.length).fill(-1);
        const prev = new Int32Array(nodes.length).fill(-1);
        const short = new Float64Array(nodes.length).fill(Infinity);
        const sprev = new Int32Array(nodes.length).fill(-1);
        best[start] = 0;
        short[start] = 0;
        for (const u of order) {
          if (best[u] < 0) continue;
          // A border node reached is an end, never a point to go through.
          if (u !== start && endOk(u)) continue;
          // Border exits, never onto the coast or another course (D = 0 there).
          const exits = u === start ? [] : adj[u].filter((b) => endOk(b) && D[b] > 0);
          for (const v of exits.length ? exits : adj[u]) {
            if (!exits.length && !(D[v] > D[u] + 1e-9)) continue;
            if (u === start && firstOk && !firstOk(v)) continue;
            const l = best[u] + len(u, v);
            if (l > best[v] + 1e-9) { best[v] = l; prev[v] = u; }
            const sl = short[u] + len(u, v);
            if (sl < short[v] - 1e-9) { short[v] = sl; sprev[v] = u; }
          }
        }
        let end = -1;
        for (let i = 0; i < nodes.length; i++) {
          if (i === start || best[i] < 0 || !endOk(i) || !(D[i] > 0)) continue;
          if (end < 0 || best[i] > best[end] + 1e-9) end = i;
        }
        if (end < 0) return null;
        const back = s.route === 'longest' ? prev : sprev;
        const path = [];
        for (let v = end; v >= 0; v = back[v]) path.push(v);
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

      /**
       * Shortest path (px) from a to b for a meander detour: each step may go
       * flat or slightly down the slope (D drops by `meanderTolerance` px at most),
       * its inner nodes staying within that tolerance of [D(a), D(b)] and avoiding
       * `blocked` and the map border (and nodes joined to it). The altitude is
       * made to decrease downstream afterwards. Returns node ids a → b, or null.
       */
      const nearBorder = (v) => toBorder(v) || adj[v].some(toBorder);
      const tol = s.meanderTolerance === undefined ? 20 : s.meanderTolerance;
      const shortestClimb = (a, b, D, blocked) => {
        const dist = new Map([[a, 0]]), prev = new Map();
        const heap = new Heap();
        heap.push(0, a);
        while (heap.a.length) {
          const [d, u] = heap.pop();
          if (d > dist.get(u)) continue;
          if (u === b) break;
          for (const v of adj[u]) {
            if (!(D[v] >= D[u] - tol)) continue;
            if (v !== b && (!(D[v] >= D[a] - tol && D[v] <= D[b] + tol) || blocked.has(v) || nearBorder(v))) continue;
            const nd = d + len(u, v);
            if (!dist.has(v) || nd < dist.get(v) - 1e-9) { dist.set(v, nd); prev.set(v, u); heap.push(nd, v); }
          }
        }
        if (!dist.has(b)) return null;
        const out = [b];
        while (out[out.length - 1] !== a) out.push(prev.get(out[out.length - 1]));
        return out.reverse();
      };

      /**
       * Meanders: on a course (node ids source → start, as the climbs return
       * them), up to `meanders` times: draw `meanderCandidates` nodes at random
       * more than 5 edges and 150 px (along the course) after the reference
       * (first the start: mouth or junction), keep the one nearest to the start,
       * and replace the stretch from 3 edges before it to 3 edges after it by the
       * shortest climbing path that goes round it (2 edges if there is none).
       * The next draw starts at the upstream end of the detour (or at the point
       * if there was no detour). `ok(path)` can refuse a detour.
       */
      const addMeanders = (course, D, ok) => {
        let p = course.slice().reverse(); // start → source
        let ref = 0, made = 0;
        for (let m = 0; m < s.meanders; m++) {
          const arc = [0];
          for (let i = 1; i < p.length; i++) arc.push(arc[i - 1] + len(p[i - 1], p[i]));
          const cands = [];
          for (let i = ref + 6; i + 3 < p.length; i++) if (arc[i] - arc[ref] > 150) cands.push(i);
          if (!cands.length) break;
          let i = Infinity;
          for (let c = 0; c < s.meanderCandidates && cands.length; c++) i = Math.min(i, cands.splice(rng.int(0, cands.length - 1), 1)[0]);
          const blocked = new Set(p);
          for (const r of state.rivers) for (const v of r.nodes) blocked.add(v);
          let next = null;
          for (const g of [3, 2]) {
            const detour = shortestClimb(p[i - g], p[i + g], D, blocked);
            if (!detour) continue;
            const np = p.slice(0, i - g).concat(detour, p.slice(i + g + 1));
            if (ok && !ok(np.slice().reverse())) continue;
            next = { p: np, ref: i - g + detour.length - 1 };
            break;
          }
          if (next) { p = next.p; ref = next.ref; made++; } else ref = i;
        }
        return { path: p.reverse(), made: made };
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
      const fMeanders = addMeanders(fPath, Dcoast, null);
      fPath = fMeanders.path;
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
      /**
       * Confluence angle at fleuve index k with the tributary points `pts`
       * (source → junction), or null if out of limits. Worst angles over the
       * smoothing radii step 8 may use (junction kept in place): the widest at
       * 120 px, the narrowest at 40, 80 and 120 px. Margins of 5°: step 8 splits
       * the courses differently and may change the angle a little.
       */
      const confluenceAngle = (k, pts) => {
        let angle = 0, narrowest = 180;
        for (const r of CONFLUENCE_CHECK_RADII) {
          const f2 = r ? smoothPolyline(fPts.slice(0, k + 1), false, r) : fPts.slice(0, k + 1);
          const t2 = r ? smoothPolyline(pts, false, r) : pts;
          angle = Math.max(angle, upstreamAngle(f2, f2.length - 1, t2, t2.length - 1));
          for (const sc of MIN_ANGLE_SCALES) narrowest = Math.min(narrowest, upstreamAngle(f2, f2.length - 1, t2, t2.length - 1, sc));
        }
        return angle <= MAX_CONFLUENCE_ANGLE - 5 && narrowest >= MIN_CONFLUENCE_ANGLE + 5 ? angle : null;
      };
      const notes = [];
      if (fMeanders.made) notes.push('fleuve: ' + fMeanders.made + ' meander(s)');
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
          const angle = confluenceAngle(k, pts);
          if (angle !== null) found = { path: path, k: k, angle: angle, bank: bank, length: length };
        }
        if (!found) {
          notes.push('river ' + t + ' skipped: no confluence between ' + MIN_CONFLUENCE_ANGLE + '° and ' + MAX_CONFLUENCE_ANGLE + '°' + (lastBank ? ' on the other bank' : ''));
          break;
        }
        // Meanders, as long as the confluence stays within the angle limits.
        const tm = addMeanders(found.path, D, (path) => confluenceAngle(found.k, path.map((v) => nodes[v])) !== null);
        found.path = tm.path;
        found.length = pathLength(found.path);
        found.angle = confluenceAngle(found.k, found.path.map((v) => nodes[v]));
        const join = found.path[found.path.length - 1];
        state.rivers.push({ kind: 'river', side: sideOf(nodes[found.path[0]], W, H), nodes: found.path, joins: 0, mouth: join });
        notes.push('river from ' + state.rivers[state.rivers.length - 1].side + ', ' + Math.round(found.length) + ' px, joins ' +
          Math.round(fromMouth[found.k]) + ' px upstream of the mouth, ' + (found.bank > 0 ? 'right' : 'left') + ' bank, ' +
          Math.round(found.angle) + '°' + (tm.made ? ', ' + tm.made + ' meander(s)' : ''));
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
        // Constant width per edge: rivers `riverWidth`; the fleuve `fleuveWidth`,
        // plus `junctionWidthGain` downstream of each confluence.
        if (r.kind === 'fleuve') {
          const joins = state.rivers.filter((t) => t.kind === 'river').map((t) => r.nodes.indexOf(t.mouth));
          r.edgeWidths = r.nodes.slice(0, -1).map((v, k) => s.fleuveWidth + s.junctionWidthGain * joins.filter((j) => j >= 0 && j <= k).length);
        } else {
          r.edgeWidths = r.nodes.slice(0, -1).map(() => s.riverWidth);
        }
        // Per node: the width of the edge leaving it downstream (last node: last edge).
        r.widths = r.nodes.map((v, k) => r.edgeWidths[Math.min(k, n - 2)]);
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

    draw(g, state, ctx) {
      if (!state.rivers || !state.rivers.length) return;
      // Once step 9 has built the water cells (and is shown), it draws the rivers.
      if (state.riverCellsBuilt && ctx && ctx.visible && ctx.visible.riverCells) return;
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
