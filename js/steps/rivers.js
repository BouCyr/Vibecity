// Step 6 — rivers. A fleuve runs from a land edge of the map to the sea; extra
// rivers come from other land edges and join the fleuve inside the map, not too
// close to the coast. Courses follow Voronoi edges between two land cells, along
// a meandering guide curve. Altitude is then made consistent with the water,
// either by carving valleys into the existing relief or by recomputing it from
// the distances to the coast and to the rivers.
(function (global) {
  'use strict';

  const EPS = 1e-6;
  const SIDES = ['N', 'E', 'S', 'W'];
  const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };
  const MOUTH_BORDER_GAP = 200;
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

  function distToPolyline(px, py, pts) {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, distToSegment(px, py, pts[i], pts[i + 1]).d);
    return best;
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

  /**
   * Dijkstra from `src` to the first reached node of `targets`. Returns the
   * node ids (with a `cost` property) or null.
   */
  function shortestPath(adj, src, targets, edgeCost, blocked) {
    const dist = new Map([[src, 0]]);
    const prev = new Map();
    const heap = new Heap();
    heap.push(0, src);
    while (heap.a.length) {
      const [d, u] = heap.pop();
      if (d > dist.get(u)) continue;
      if (targets.has(u) && u !== src) {
        const path = [u];
        let v = u;
        while (prev.has(v)) { v = prev.get(v); path.push(v); }
        path.reverse();
        path.cost = d;
        return path;
      }
      for (const v of adj[u]) {
        if (blocked(v) && !targets.has(v)) continue;
        const nd = d + edgeCost(u, v);
        if (nd < (dist.has(v) ? dist.get(v) : Infinity)) { dist.set(v, nd); prev.set(v, u); heap.push(nd, v); }
      }
    }
    return null;
  }

  /** Meandering guide polyline from a to b (two sine waves, tapered at both ends). */
  function meanderGuide(a, b, amp, length, rng) {
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
    const p1 = rng.random() * Math.PI * 2, p2 = rng.random() * Math.PI * 2;
    const pts = [];
    const n = 120;
    for (let i = 0; i <= n; i++) {
      const s = (i / n) * L;
      const off = amp * Math.sin((Math.PI * s) / L) *
        (Math.sin((2 * Math.PI * s) / length + p1) + 0.4 * Math.sin((2 * Math.PI * s) / (0.45 * length) + p2)) / 1.4;
      pts.push({ x: a.x + ux * s - uy * off, y: a.y + uy * s + ux * off });
    }
    return pts;
  }

  const CONFLUENCE_SCALE = 120;   // px upstream used to measure a confluence angle
  const CONFLUENCE_APPROACH = 150; // px around a confluence where the river must come from upstream
  const CONFLUENCE_CANDIDATES = 12;

  /** Point at arc length `len` before index `end` along a list of points (clamped to the start). */
  function pointUpstream(pts, end, len) {
    let left = len;
    for (let k = end; k > 0; k--) {
      const a = pts[k], b = pts[k - 1];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d >= left) return { x: a.x + ((b.x - a.x) * left) / d, y: a.y + ((b.y - a.y) * left) / d };
      left -= d;
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
        key: 'count', label: 'Watercourses', type: 'select', default: 'auto',
        options: [
          { value: 'auto', label: 'Auto (2 land edges: 1, 3: 2)' },
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
      { key: 'meanderAmp', label: 'Meander amplitude (px)', type: 'range', min: 0, max: 400, step: 10, default: 200 },
      { key: 'meanderLength', label: 'Meander length (px)', type: 'range', min: 150, max: 1500, step: 10, default: 500 },
      { key: 'confluenceMin', label: 'Confluence min distance to coast (px)', type: 'range', min: 0, max: 1200, step: 10, default: 500 },
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
      const landSides = SIDES.filter((f) => fronts.indexOf(f) < 0);
      let count;
      if (!fronts.length) count = 0;
      else if (s.count === 'auto') {
        count = landSides.length === 3 ? 2
          : landSides.length === 2 && OPPOSITE[landSides[0]] !== landSides[1] ? 1 : 0;
      } else count = Math.min(Number(s.count), landSides.length);
      if (!count) return 'no watercourse (' + landSides.length + ' land edges)';

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

      // Sources: on a land edge, 25–75 % along it, at a border node with an inward
      // edge. With courses already drawn, the farthest of 5 drawn spots is kept.
      const pickSource = (side, avoid) => {
        let best = -1, bestScore = -Infinity;
        const tries = avoid && avoid.length ? 5 : 1;
        for (let k = 0; k < tries; k++) {
          const t = rng.range(0.25, 0.75);
          const tx = side === 'E' ? W : side === 'W' ? 0 : t * W;
          const ty = side === 'S' ? H : side === 'N' ? 0 : t * H;
          let node = -1, bd = Infinity;
          nodes.forEach((n, i) => {
            if (sideOf(n, W, H) !== side || !adj[i].length) return;
            const d = Math.hypot(n.x - tx, n.y - ty);
            if (d < bd) { bd = d; node = i; }
          });
          if (node < 0) continue;
          let score = 0;
          if (tries > 1) {
            score = Infinity;
            for (const line of avoid) score = Math.min(score, distToPolyline(nodes[node].x, nodes[node].y, line));
          }
          if (score > bestScore) { bestScore = score; best = node; }
        }
        return best;
      };

      // Fleuve source side: the land edge facing a sea front if any (ties drawn).
      const score = (f) => (fronts.indexOf(OPPOSITE[f]) >= 0 ? 1 : 0);
      const ranked = rng.shuffle(landSides.slice()).sort((a, b) => score(b) - score(a));
      const fleuveSide = ranked[0];
      const riverSides = ranked.slice(1, count);

      const coastSegs = (state.coastline || []).map(([a, b]) => [nodes[a], nodes[b]]);
      const distCoast = (x, y) => {
        let best = Infinity;
        for (const [a, b] of coastSegs) best = Math.min(best, distToSegment(x, y, a, b).d);
        return best;
      };

      const carve = s.altitudeMode === 'carve';
      const amp = s.meanderAmp, norm = Math.max(60, amp);
      // Existing courses, to keep a new river from running alongside them.
      const HUG = 150, HUG_FREE = 80;
      const courseLines = [];
      const route = (src, target, targets, blocked) => {
        const guide = meanderGuide(nodes[src], nodes[target], amp, s.meanderLength, rng);
        const dg = new Map();
        const guideDist = (i) => {
          if (!dg.has(i)) dg.set(i, distToPolyline(nodes[i].x, nodes[i].y, guide));
          return dg.get(i);
        };
        const hug = new Map();
        const hugFactor = (i) => {
          if (!hug.has(i)) {
            const n = nodes[i];
            let f = 1;
            if (courseLines.length && Math.hypot(n.x - nodes[target].x, n.y - nodes[target].y) > HUG_FREE) {
              let d = Infinity;
              for (const line of courseLines) d = Math.min(d, distToPolyline(n.x, n.y, line));
              const t = 1 - Math.min(1, d / HUG);
              f = 1 + 8 * t * t;
            }
            hug.set(i, f);
          }
          return hug.get(i);
        };
        const cost = (u, v) => {
          const a = nodes[u], b = nodes[v];
          const g = (guideDist(u) + guideDist(v)) / 2 / norm;
          const alt = carve ? 1 + 3 * Math.max(0, (a.altitude + b.altitude) / 2) : 1;
          return Math.hypot(b.x - a.x, b.y - a.y) * (1 + 8 * g * g) * alt * Math.max(hugFactor(u), hugFactor(v));
        };
        return shortestPath(adj, src, targets, cost, blocked);
      };

      // Fleuve: to a coast node reachable by land edges, away from the map border.
      const fSrc = pickSource(fleuveSide);
      const mouths = [];
      nodes.forEach((n, i) => {
        if (!n.coast || !adj[i].length) return;
        if (n.x < MOUTH_BORDER_GAP || n.y < MOUTH_BORDER_GAP || n.x > W - MOUTH_BORDER_GAP || n.y > H - MOUTH_BORDER_GAP) return;
        mouths.push(i);
      });
      if (fSrc < 0 || !mouths.length) return 'no watercourse (no reachable coast)';
      mouths.sort((a, b) => Math.hypot(nodes[a].x - nodes[fSrc].x, nodes[a].y - nodes[fSrc].y) -
        Math.hypot(nodes[b].x - nodes[fSrc].x, nodes[b].y - nodes[fSrc].y));
      const mouth = mouths[rng.int(0, Math.min(4, mouths.length - 1))];
      const used = new Set();
      const fPath = route(fSrc, mouth, new Set([mouth]), (v) => used.has(v));
      if (!fPath) return 'no watercourse (no land path to the sea)';
      state.rivers.push({ kind: 'fleuve', side: fleuveSide, nodes: fPath, joins: null, mouth: mouth });
      fPath.forEach((v) => used.add(v));
      courseLines.push(fPath.map((v) => nodes[v]));

      // Rivers: to a fleuve node far enough from the coast.
      const notes = [];
      for (const side of riverSides) {
        const src = pickSource(side, courseLines);
        if (src < 0 || used.has(src)) continue;
        const fleuve = state.rivers[0].nodes;
        let valid = fleuve.slice(1, -1).filter((v) => distCoast(nodes[v].x, nodes[v].y) >= s.confluenceMin);
        let fallback = false;
        if (!valid.length) {
          fallback = true;
          valid = [fleuve.slice(1, -1).reduce((b, v) => (distCoast(nodes[v].x, nodes[v].y) > distCoast(nodes[b].x, nodes[b].y) ? v : b), fleuve[1])];
        }
        // Try the fleuve nodes nearest to the source; the river must reach each one
        // from its upstream side (downstream half-disk blocked) and form an angle
        // of at most 90° with the fleuve's upstream branch. Cheapest valid wins.
        const fPts = fleuve.map((v) => nodes[v]);
        const candidates = valid.slice().sort((a, b) =>
          Math.hypot(nodes[a].x - nodes[src].x, nodes[a].y - nodes[src].y) -
          Math.hypot(nodes[b].x - nodes[src].x, nodes[b].y - nodes[src].y)).slice(0, CONFLUENCE_CANDIDATES);
        let path = null, angle = 0;
        for (const t of candidates) {
          const k = fleuve.indexOf(t);
          const up = pointUpstream(fPts, k, CONFLUENCE_SCALE);
          const T = nodes[t];
          const ux = up.x - T.x, uy = up.y - T.y;
          const downstream = (v) => {
            const n = nodes[v];
            const dx = n.x - T.x, dy = n.y - T.y;
            return dx * dx + dy * dy < CONFLUENCE_APPROACH * CONFLUENCE_APPROACH && dx * ux + dy * uy < 0;
          };
          const p = route(src, t, new Set([t]), (v) => used.has(v) || downstream(v));
          if (!p) continue;
          const a = upstreamAngle(fPts, k, p.map((v) => nodes[v]), p.length - 1);
          if (a <= 90 && (!path || p.cost < path.cost)) { path = p; angle = a; }
        }
        if (!path) {
          notes.push('river from ' + side + ' skipped: no confluence at 90° or less');
          continue;
        }
        const join = path[path.length - 1];
        state.rivers.push({ kind: 'river', side: side, nodes: path, joins: 0, mouth: join });
        path.slice(0, -1).forEach((v) => used.add(v));
        courseLines.push(path.map((v) => nodes[v]));
        notes.push('river from ' + side + ' joins ' + Math.round(distCoast(nodes[join].x, nodes[join].y)) + ' px from the coast at ' +
          Math.round(angle) + '°' + (fallback ? ' (closer than asked: fleuve too short)' : ''));
      }

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
      return 'fleuve from ' + f.side + ', ' + f.nodes.length + ' nodes' + (notes.length ? '; ' + notes.join('; ') : '') +
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
