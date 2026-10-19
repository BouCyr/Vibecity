// Step 6 — smooth coast. The sea outline (boundary of the sea cells) is
// resampled and smoothed with a Gaussian-like filter of a given radius, so no
// bend is tighter than roughly that radius. The result is written back into the
// cells, so the exact coast points are part of the data:
//  - coast nodes are moved onto the smoothed curve (every cell sharing a node
//    follows, so cells stay seamless);
//  - the smoothed points between two coast nodes are stored per coast edge and
//    inserted into the polygon of both cells along that edge.
// Map-border stretches stay exact. Nodes on the map border and nodes where sea
// cells only touch by a corner are kept in place.
(function (global) {
  'use strict';

  const SPACING = 4;
  const EPS = 1e-6;
  const edgeKey = (a, b) => (a < b ? a + ',' + b : b + ',' + a);

  /**
   * Points about every SPACING px along the polyline, original vertices
   * included. Returns { pts, index } where index[i] is the position of input
   * vertex i in pts.
   */
  function resample(src, closed) {
    const pts = [];
    const index = [];
    const segs = closed ? src.length : src.length - 1;
    for (let i = 0; i < segs; i++) {
      const a = src[i], b = src[(i + 1) % src.length];
      index.push(pts.length);
      pts.push({ x: a.x, y: a.y });
      const m = Math.max(0, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / SPACING) - 1);
      for (let j = 1; j <= m; j++) {
        const t = j / (m + 1);
        pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    if (!closed) {
      index.push(pts.length);
      pts.push({ x: src[src.length - 1].x, y: src[src.length - 1].y });
    }
    return { pts: pts, index: index };
  }

  /**
   * Three passes of a moving average (≈ Gaussian) whose half-width is `radius`
   * px. Open polylines are extended past each end by point reflection
   * (p[-k] = 2 p[0] - p[k]): the end points stay exactly in place while the
   * curve next to them is smoothed as much as anywhere else.
   */
  function smooth(cur, closed, radius) {
    const n = cur.length;
    if (radius <= 0 || n < 3) return cur;
    const h = Math.max(1, Math.round(radius / SPACING));
    for (let pass = 0; pass < 3; pass++) {
      const next = new Array(n);
      for (let i = 0; i < n; i++) {
        const w = Math.min(h, Math.floor((n - 1) / 2));
        let sx = 0, sy = 0;
        for (let k = -w; k <= w; k++) {
          const j = i + k;
          let p;
          if (closed) p = cur[(j + n) % n];
          else if (j < 0) { const q = cur[Math.min(n - 1, -j)]; p = { x: 2 * cur[0].x - q.x, y: 2 * cur[0].y - q.y }; }
          else if (j > n - 1) { const q = cur[Math.max(0, 2 * (n - 1) - j)]; p = { x: 2 * cur[n - 1].x - q.x, y: 2 * cur[n - 1].y - q.y }; }
          else p = cur[j];
          sx += p.x; sy += p.y;
        }
        next[i] = { x: sx / (2 * w + 1), y: sy / (2 * w + 1) };
      }
      cur = next;
    }
    return cur;
  }

  /**
   * Outline of the sea cells as closed loops of edges { a, b, border } (node
   * ids; border = on the map edge). Edges keep the cells' winding, so every
   * loop is closed and islands come out as separate loops. Also returns the
   * number of outgoing outline edges per node (more than one = sea cells
   * touching only by a corner).
   */
  function seaLoops(state) {
    const owners = new Map();
    state.cells.forEach((c, ci) => {
      const ns = c.nodes;
      for (let k = 0; k < ns.length; k++) {
        const key = edgeKey(ns[k], ns[(k + 1) % ns.length]);
        const list = owners.get(key);
        if (list) list.push(ci); else owners.set(key, [ci]);
      }
    });

    const out = new Map();
    state.cells.forEach((c, ci) => {
      if (!c.sea) return;
      const ns = c.nodes;
      for (let k = 0; k < ns.length; k++) {
        const a = ns[k], b = ns[(k + 1) % ns.length];
        const list = owners.get(edgeKey(a, b));
        const other = list.length > 1 ? list[0] === ci ? list[1] : list[0] : -1;
        if (other >= 0 && state.cells[other].sea) continue;
        const e = { a: a, b: b, border: other < 0, used: false };
        if (!out.has(a)) out.set(a, []);
        out.get(a).push(e);
      }
    });

    const loops = [];
    for (const list of out.values()) {
      for (const start of list) {
        if (start.used) continue;
        const loop = [];
        let e = start;
        while (e && !e.used) {
          e.used = true;
          loop.push(e);
          e = (out.get(e.b) || []).find((x) => !x.used);
        }
        loops.push(loop);
      }
    }
    const degree = new Map();
    for (const [a, list] of out) degree.set(a, list.length);
    return { loops: loops, degree: degree };
  }

  /** Coast runs to smooth: node id sequences along coast edges, split at pinned nodes. */
  function coastRuns(loops, pinned) {
    const runs = [];
    for (const loop of loops) {
      const p0 = loop.findIndex((e) => pinned(e.a));
      if (p0 < 0) {
        runs.push({ nodes: loop.map((e) => e.a), closed: true });
        continue;
      }
      const edges = loop.slice(p0).concat(loop.slice(0, p0));
      let run = null;
      for (const e of edges) {
        if (e.border) { run = null; continue; }
        if (!run || pinned(e.a)) {
          run = { nodes: [e.a], closed: false };
          runs.push(run);
        }
        run.nodes.push(e.b);
      }
    }
    return runs;
  }

  /** Smoothed copy of an open or closed polyline, as step 7 does it (used by the rivers step). */
  global.smoothPolyline = (pts, closed, radius) => smooth(resample(pts, closed).pts, closed, radius);

  global.CoastStep = {
    id: 'coast',
    title: 'Smooth coast & rivers',
    // Above the altitude, under the Voronoi edges.
    zIndex: -0.4,
    settings: [
      { key: 'radius', label: 'Smoothing radius (px)', type: 'range', min: 0, max: 30, step: 1, default: 25 }
    ],

    run(state, s, rng, ctx) {
      const nodes = state.nodes;
      const { loops, degree } = seaLoops(state);
      const onBorder = (n) => n.x <= EPS || n.y <= EPS || n.x >= ctx.width - EPS || n.y >= ctx.height - EPS;
      // River sources, mouths and confluences stay in place too.
      const riverPins = state.riverPins || new Set();
      const pinned = (id) => onBorder(nodes[id]) || degree.get(id) > 1 || riverPins.has(id);
      const runs = coastRuns(loops, pinned);
      // Rivers: open runs, split at pinned nodes (the fleuve at each confluence).
      (state.rivers || []).forEach((r) => {
        let run = null;
        r.nodes.forEach((id, k) => {
          if (run) { run.nodes.push(id); run.widths.push(r.widths[k]); }
          if (!run || (pinned(id) && k < r.nodes.length - 1)) {
            run = { nodes: [id], widths: [r.widths[k]], closed: false, river: true };
            runs.push(run);
          }
        });
      });
      // Beyond ~0.6 cell spacing, moved nodes can fold small cells: cap the radius.
      const spacing = Math.sqrt((ctx.width * ctx.height) / Math.max(1, state.cells.length));
      const radius = Math.min(s.radius, 0.6 * spacing);

      // Smooth each run, then record moved nodes and in-between points per edge.
      const moved = new Map();
      const edgePoints = new Map();
      const paths = [];
      const riverPaths = [];
      for (const run of runs) {
        const src = run.nodes.map((id) => ({ x: nodes[id].x, y: nodes[id].y }));
        if (run.closed && src.length < 3) continue;
        const r = resample(src, run.closed);
        const sm = smooth(r.pts, run.closed, radius);
        if (run.river) {
          // Width per smoothed point, interpolated between the run's nodes.
          const widths = new Array(sm.length);
          for (let i = 0; i + 1 < r.index.length; i++) {
            const ia = r.index[i], ib = r.index[i + 1];
            for (let j = ia; j <= ib; j++) widths[j] = run.widths[i] + (run.widths[i + 1] - run.widths[i]) * ((j - ia) / Math.max(1, ib - ia));
          }
          riverPaths.push({ points: sm, widths: widths });
        } else {
          paths.push({ points: sm, closed: run.closed });
        }
        const count = run.nodes.length - (run.closed ? 0 : 1);
        for (let i = 0; i < count; i++) {
          const a = run.nodes[i], b = run.nodes[(i + 1) % run.nodes.length];
          const ia = r.index[i];
          const ib = i + 1 < r.index.length ? r.index[i + 1] : sm.length;
          if (run.closed || i > 0) moved.set(a, sm[ia]);
          edgePoints.set(edgeKey(a, b), { a: a, points: sm.slice(ia + 1, ib) });
        }
      }

      let maxMove = 0;
      for (const [id, p] of moved) {
        maxMove = Math.max(maxMove, Math.hypot(p.x - nodes[id].x, p.y - nodes[id].y));
        nodes[id].x = p.x;
        nodes[id].y = p.y;
      }

      const inside = (poly, x, y) => {
        let r = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const a = poly[i], b = poly[j];
          if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) r = !r;
        }
        return r;
      };

      // Rebuild every cell polygon from its (possibly moved) nodes and the
      // coast points of its edges; polyAlt holds an altitude per polygon point.
      let inserted = 0, recentered = 0;
      for (const c of state.cells) {
        const poly = [], alt = [];
        const ns = c.nodes;
        for (let k = 0; k < ns.length; k++) {
          const a = ns[k], b = ns[(k + 1) % ns.length];
          poly.push({ x: nodes[a].x, y: nodes[a].y });
          alt.push(nodes[a].altitude);
          const ep = edgePoints.get(edgeKey(a, b));
          if (!ep) continue;
          const pts = ep.a === a ? ep.points : ep.points.slice().reverse();
          pts.forEach((p, j) => {
            const t = (j + 1) / (pts.length + 1);
            poly.push({ x: p.x, y: p.y });
            alt.push(nodes[a].altitude * (1 - t) + nodes[b].altitude * t);
          });
          inserted += pts.length;
        }
        c.poly = poly;
        c.polyAlt = alt;
        // A small cell squeezed by the coast can lose its center: move it back inside.
        if (!inside(poly, c.site.x, c.site.y)) {
          c.site = polygonCentroid(poly);
          recentered++;
        }
      }

      state.coastEdgePoints = edgePoints;
      state.coastPaths = paths;
      state.riverPaths = state.rivers && state.rivers.length ? riverPaths : null;
      return moved.size + ' coast nodes moved (max ' + maxMove.toFixed(0) + ' px), ' +
        edgePoints.size + ' coast edges, ' + inserted / 2 + ' coast points' +
        (recentered ? ', ' + recentered + ' cell centers moved' : '') +
        (radius < s.radius ? '; radius limited to ' + radius.toFixed(0) + ' px for this cell size' : '');
    },

    draw(g, state) {
      // Sea cells follow the smoothed coast exactly.
      g.fillStyle = '#5f86a8';
      g.strokeStyle = '#5f86a8';
      g.lineWidth = 1;
      g.lineJoin = 'round';
      for (const c of state.cells) {
        if (!c.sea || !c.poly.length) continue;
        g.beginPath();
        c.poly.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
        g.fill();
        g.stroke();
      }

      g.strokeStyle = '#2f3f52';
      g.lineWidth = 3;
      g.lineCap = 'round';
      g.beginPath();
      for (const path of state.coastPaths) {
        path.points.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        if (path.closed) g.closePath();
      }
      g.stroke();
    }
  };
})(window);
