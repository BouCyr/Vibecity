// Step 6 — smooth coast. Drawing only: the sea outline (the boundary of the sea
// cells) is smoothed with Chaikin corner cutting. Stretches along the map border
// stay exact. Cell data (sea flags, coastline) is left unchanged.
(function (global) {
  'use strict';

  const edgeKey = (a, b) => (a < b ? a + ',' + b : b + ',' + a);

  /** One Chaikin pass. Open polylines keep their two end points. */
  function chaikin(pts, closed) {
    const out = [];
    const n = pts.length;
    const segs = closed ? n : n - 1;
    if (!closed) out.push(pts[0]);
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if (closed || i > 0) out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      if (closed || i < segs - 1) out.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    if (!closed) out.push(pts[n - 1]);
    return out;
  }

  function smooth(pts, closed, iterations) {
    for (let k = 0; k < iterations && pts.length > 2; k++) pts = chaikin(pts, closed);
    return pts;
  }

  /**
   * Outline of the sea cells as closed loops of node ids, each edge tagged
   * `border` (map edge) or not (coast). Edges keep the cells' winding, so every
   * loop is closed and islands come out as separate loops.
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

    // Outgoing boundary edges per start node.
    const out = new Map();
    let total = 0;
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
        total++;
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
    return { loops: loops, edges: total };
  }

  global.CoastStep = {
    id: 'coast',
    title: 'Smooth coast',
    // Above the altitude and the cell-based sea, under the Voronoi edges.
    zIndex: -0.4,
    settings: [
      { key: 'iterations', label: 'Smoothing passes', type: 'range', min: 0, max: 6, step: 1, default: 3 }
    ],

    run(state, s) {
      const nodes = state.nodes;
      const pt = (id) => ({ x: nodes[id].x, y: nodes[id].y });
      const { loops } = seaLoops(state);
      const shapes = [];
      const paths = [];
      let count = 0;

      for (const loop of loops) {
        const b0 = loop.findIndex((e) => e.border);
        if (b0 < 0) {
          // Island or lake shore: a closed loop with no map border.
          const pts = smooth(loop.map((e) => pt(e.a)), true, s.iterations);
          shapes.push(pts);
          paths.push({ points: pts, closed: true });
          count += pts.length;
          continue;
        }
        // Start at a border edge; smooth each run of coast edges between border stretches.
        const edges = loop.slice(b0).concat(loop.slice(0, b0));
        const shape = [];
        let run = null;
        const flush = () => {
          if (!run) return;
          const pts = smooth(run, false, s.iterations);
          paths.push({ points: pts, closed: false });
          for (let k = 1; k < pts.length; k++) shape.push(pts[k]);
          run = null;
        };
        shape.push(pt(edges[0].a));
        for (const e of edges) {
          if (e.border) {
            flush();
            shape.push(pt(e.b));
          } else {
            if (!run) run = [pt(e.a)];
            run.push(pt(e.b));
          }
        }
        flush();
        shape.pop(); // last point repeats the first one
        shapes.push(shape);
        count += shape.length;
      }

      state.seaShapes = shapes;
      state.coastPaths = paths;
      return shapes.length + ' sea outlines, ' + paths.length + ' coast paths, ' + count + ' points';
    },

    draw(g, state) {
      g.fillStyle = '#5f86a8';
      g.beginPath();
      for (const shape of state.seaShapes) {
        shape.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
      }
      g.fill('evenodd');

      g.strokeStyle = '#2f3f52';
      g.lineWidth = 3;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      for (const path of state.coastPaths) {
        path.points.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        if (path.closed) g.closePath();
      }
      g.stroke();
    }
  };
})(window);
