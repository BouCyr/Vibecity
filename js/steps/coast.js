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

  /** True if two non-adjacent edges of the closed polygon cross. */
  function selfCrossing(pts) {
    const n = pts.length;
    const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const c = pts[j], d = pts[(j + 1) % n];
        if (Math.max(c.x, d.x) < minX || Math.min(c.x, d.x) > maxX || Math.max(c.y, d.y) < minY || Math.min(c.y, d.y) > maxY) continue;
        const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
        if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)) && d1 && d2 && d3 && d4) return true;
      }
    }
    return false;
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
      const runNode = new Set();
      for (const run of runs) for (const id of run.nodes) runNode.add(id);
      // Beyond ~0.6 cell spacing, moved nodes can fold small cells: cap the radius.
      const spacing = Math.sqrt((ctx.width * ctx.height) / Math.max(1, state.cells.length));
      let radius = Math.min(s.radius, 0.6 * spacing);

      /**
       * Smooth every run at radius r. `alphas` (one array per run, or null) blends
       * each smoothed point back towards the unsmoothed line (1 = fully smoothed).
       * Returns moved node positions, in-between points per edge, paths, and
       * where each edge / moved node sits in its run.
       */
      const smoothRuns = (r, alphas) => {
        const moved = new Map();
        const edgePoints = new Map();
        const where = new Map(); // edge key or 'n' + node -> { run, from, to } sample range
        const paths = [];
        const riverPaths = [];
        const runPoints = [];
        runs.forEach((run, ri) => {
          const src = run.nodes.map((id) => ({ x: nodes[id].x, y: nodes[id].y }));
          if (run.closed && src.length < 3) return;
          const rs = resample(src, run.closed);
          let sm = smooth(rs.pts, run.closed, r);
          if (alphas && alphas[ri]) {
            const al = alphas[ri];
            sm = sm.map((p, j) => ({ x: rs.pts[j].x + (p.x - rs.pts[j].x) * al[j], y: rs.pts[j].y + (p.y - rs.pts[j].y) * al[j] }));
          }
          runPoints[ri] = sm;
          if (run.river) {
            // Width per smoothed point, interpolated between the run's nodes.
            const widths = new Array(sm.length);
            for (let i = 0; i + 1 < rs.index.length; i++) {
              const ia = rs.index[i], ib = rs.index[i + 1];
              for (let j = ia; j <= ib; j++) widths[j] = run.widths[i] + (run.widths[i + 1] - run.widths[i]) * ((j - ia) / Math.max(1, ib - ia));
            }
            riverPaths.push({ points: sm, widths: widths });
          } else {
            paths.push({ points: sm, closed: run.closed });
          }
          const count = run.nodes.length - (run.closed ? 0 : 1);
          for (let i = 0; i < count; i++) {
            const a = run.nodes[i], b = run.nodes[(i + 1) % run.nodes.length];
            const ia = rs.index[i];
            const ib = i + 1 < rs.index.length ? rs.index[i + 1] : sm.length;
            if (run.closed || i > 0) {
              moved.set(a, sm[ia]);
              where.set('n' + a, { run: ri, from: ia, to: ia, n: sm.length });
            }
            edgePoints.set(edgeKey(a, b), { a: a, points: sm.slice(ia + 1, ib) });
            where.set(edgeKey(a, b), { run: ri, from: ia, to: ib, n: sm.length });
          }
        });
        return { moved: moved, edgePoints: edgePoints, where: where, runPoints: runPoints, paths: paths, riverPaths: riverPaths };
      };

      /** Cell polygon from node positions `pos` and the in-between points; altitudes alongside. */
      const buildPoly = (c, pos, edgePoints) => {
        const poly = [], alt = [];
        const ns = c.nodes;
        for (let k = 0; k < ns.length; k++) {
          const a = ns[k], b = ns[(k + 1) % ns.length];
          poly.push(pos(a));
          alt.push(nodes[a].altitude);
          const ep = edgePoints.get(edgeKey(a, b));
          if (!ep) continue;
          const pts = ep.a === a ? ep.points : ep.points.slice().reverse();
          pts.forEach((p, j) => {
            const t = (j + 1) / (pts.length + 1);
            poly.push({ x: p.x, y: p.y });
            alt.push(nodes[a].altitude * (1 - t) + nodes[b].altitude * t);
          });
        }
        return { poly: poly, alt: alt };
      };
      const signedArea = (pts) => {
        let a = 0;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i], q = pts[(i + 1) % pts.length];
          a += p.x * q.y - q.x * p.y;
        }
        return a / 2;
      };
      const winding = Math.sign(signedArea(state.cells[0].nodes.map((id) => nodes[id])));

      // Smooth, and check that every cell keeps its orientation, does not cross
      // itself and that the cells still tile the map (no overlap). A faulty cell
      // is typically a small cell inside a tight bend:
      //  - made only of smoothed nodes (a sliver closed by a chord): it is merged
      //    into the cell across its longest chord;
      //  - with free nodes: those follow the smoothing of the nearby curve;
      //  - otherwise the smoothing is relaxed locally, then the radius reduced.
      const dead = new Set();
      const shift = new Map(); // free node -> displacement
      const tryMerge = (ci, where, moved) => {
        const ns = state.cells[ci].nodes;
        if (!moved && !ns.every((id) => runNode.has(id))) return false;
        const shiftOf = (id) => {
          const m = moved && moved.get(id);
          return m ? Math.hypot(m.x - nodes[id].x, m.y - nodes[id].y) : 0;
        };
        let best = null;
        ns.forEach((a, k) => {
          const b = ns[(k + 1) % ns.length];
          if (where.has(edgeKey(a, b))) return;
          // Slivers: the longest chord; otherwise the edge whose smoothed end moved most.
          const len = moved ? Math.max(shiftOf(a), shiftOf(b)) : Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
          for (const nb of nodes[a].cells) {
            if (nb === ci || dead.has(nb) || state.cells[nb].sea !== state.cells[ci].sea) continue;
            const other = state.cells[nb].nodes, ib = other.indexOf(b);
            if (ib < 0 || other[(ib + 1) % other.length] !== a) continue;
            if (ns.filter((id) => other.indexOf(id) >= 0).length !== 2) continue;
            if (!best || len > best.len) best = { k: k, nb: nb, ib: ib, len: len };
          }
        });
        if (!best) return false;
        const other = state.cells[best.nb].nodes, path = [];
        for (let k = 1; k < ns.length - 1; k++) path.push(ns[(best.k + 1 + k) % ns.length]);
        state.cells[best.nb].nodes = other.slice(0, best.ib + 1).concat(path, other.slice(best.ib + 1));
        for (const id of path) nodes[id].cells.push(best.nb);
        for (const id of ns) nodes[id].cells = nodes[id].cells.filter((c) => c !== ci);
        state.cells[ci].nodes = [];
        dead.add(ci);
        return true;
      };
      let result, built, relaxed = 0;
      const followed = new Set();
      for (;;) {
        let alphas = null;
        for (let tries = 0; tries < 20; tries++) {
          result = smoothRuns(radius, alphas);
          const pos = (id) => result.moved.get(id) ||
            (shift.has(id) ? { x: nodes[id].x + shift.get(id).x, y: nodes[id].y + shift.get(id).y } : { x: nodes[id].x, y: nodes[id].y });
          built = state.cells.map((c) => buildPoly(c, pos, result.edgePoints));
          const bad = [];
          let total = 0;
          built.forEach((b, ci) => {
            if (dead.has(ci)) return;
            const a = signedArea(b.poly);
            if (Math.sign(a) !== winding || selfCrossing(b.poly)) bad.push(ci);
            total += Math.abs(a);
          });
          // Unsmoothed: the cells are the Voronoi cells, valid by construction.
          if (radius === 0 || (!bad.length && Math.abs(total - ctx.width * ctx.height) < 1)) break;
          if (!bad.length) { result = null; break; }
          let fixed = false;
          const rest = [];
          for (const ci of bad) {
            if (tryMerge(ci, result.where)) { fixed = true; continue; }
            // Free nodes follow the displacement of the nearest smoothed sample
            // of the cell's curves; if that did not help, the cell is merged
            // across the free edge next to its most displaced smoothed node.
            if (followed.has(ci) && tryMerge(ci, result.where, result.moved)) { fixed = true; continue; }
            const ns = state.cells[ci].nodes;
            let moved = false;
            for (const f of ns) {
              const F = nodes[f];
              if (runNode.has(f) || F.x <= EPS || F.y <= EPS || F.x >= ctx.width - EPS || F.y >= ctx.height - EPS) continue;
              let best = null;
              for (let k = 0; k < ns.length; k++) {
                const w = result.where.get(edgeKey(ns[k], ns[(k + 1) % ns.length]));
                if (!w) continue;
                const src = runs[w.run].nodes.map((id) => ({ x: nodes[id].x, y: nodes[id].y }));
                const rs = resample(src, runs[w.run].closed).pts;
                const sm = result.runPoints[w.run];
                for (let j = w.from; j <= Math.min(w.to, sm.length - 1); j++) {
                  const d = Math.hypot(rs[j].x - F.x, rs[j].y - F.y);
                  if (!best || d < best.d) best = { d: d, x: sm[j].x - rs[j].x, y: sm[j].y - rs[j].y };
                }
              }
              const prev = shift.get(f);
              if (!best || Math.hypot(best.x, best.y) < 0.01 || (prev && Math.hypot(prev.x, prev.y) > 3 * Math.hypot(best.x, best.y))) continue;
              const m = prev ? 1.5 : 1;
              shift.set(f, prev ? { x: prev.x + best.x * (m - 1), y: prev.y + best.y * (m - 1) } : { x: best.x, y: best.y });
              moved = true;
            }
            if (moved) { fixed = true; followed.add(ci); } else rest.push(ci);
          }
          if (fixed && !rest.length) { result = null; continue; }
          // Halve the smoothing over the samples of the remaining faulty cells'
          // edges and nodes, tapering off over the smoothing half-width.
          if (!alphas) alphas = [];
          const h = Math.max(1, Math.round(radius / SPACING));
          for (const ci of rest) {
            const ns = state.cells[ci].nodes;
            for (let k = 0; k < ns.length; k++) {
              for (const key of [edgeKey(ns[k], ns[(k + 1) % ns.length]), 'n' + ns[k]]) {
                const w = result.where.get(key);
                if (!w) continue;
                if (!alphas[w.run]) alphas[w.run] = new Float64Array(w.n).fill(1);
                const al = alphas[w.run], closed = runs[w.run].closed;
                for (let j = w.from - h; j <= w.to + h; j++) {
                  const d = j < w.from ? w.from - j : j > w.to ? j - w.to : 0;
                  const jj = closed ? ((j % w.n) + w.n) % w.n : j;
                  if (jj < 0 || jj >= w.n) continue;
                  al[jj] *= 1 - 0.5 * (1 - d / (h + 1));
                }
              }
            }
          }
          relaxed += rest.length;
          result = null;
        }
        if (result) break;
        radius = radius > 2 ? radius * 0.75 : 0;
        shift.clear();
      }
      for (const [id, d] of shift) if (!result.moved.has(id)) result.moved.set(id, { x: nodes[id].x + d.x, y: nodes[id].y + d.y });
      const { moved, edgePoints, paths, riverPaths } = result;

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

      // Drop the merged slivers (and their entries in the sea clean-up record).
      if (dead.size) {
        const remap = state.cells.map(() => -1);
        const live = [], liveBuilt = [];
        state.cells.forEach((c, ci) => { if (!dead.has(ci)) { remap[ci] = live.length; live.push(c); liveBuilt.push(built[ci]); } });
        if (state.seaChanges) state.seaChanges = state.seaChanges.filter((ch) => remap[ch.cell] >= 0).map((ch) => ({ cell: remap[ch.cell], toSea: ch.toSea }));
        for (const n of nodes) n.cells = [];
        live.forEach((c, ci) => { for (const id of c.nodes) nodes[id].cells.push(ci); });
        const owners = new Map();
        live.forEach((c, ci) => c.nodes.forEach((id, k) => {
          const key = edgeKey(id, c.nodes[(k + 1) % c.nodes.length]);
          if (owners.has(key)) owners.get(key).push(ci); else owners.set(key, [ci]);
        }));
        for (const c of live) c.neighbors = [];
        for (const list of owners.values()) {
          if (list.length !== 2) continue;
          live[list[0]].neighbors.push(list[1]);
          live[list[1]].neighbors.push(list[0]);
        }
        for (const c of live) c.neighbors.sort((x, y) => x - y);
        state.cells = live;
        built = liveBuilt;
      }

      // Cell polygons follow the smoothed coast and rivers; polyAlt holds an
      // altitude per polygon point.
      let inserted = 0, recentered = 0;
      state.cells.forEach((c, ci) => {
        c.poly = built[ci].poly;
        c.polyAlt = built[ci].alt;
        inserted += c.poly.length - c.nodes.length;
        // A small cell squeezed by the coast can lose its center: move it back inside.
        if (!inside(c.poly, c.site.x, c.site.y)) {
          c.site = polygonCentroid(c.poly);
          recentered++;
        }
      });

      state.coastEdgePoints = edgePoints;
      state.coastPaths = paths;
      state.riverPaths = state.rivers && state.rivers.length ? riverPaths : null;
      return moved.size + ' coast nodes moved (max ' + maxMove.toFixed(0) + ' px), ' +
        edgePoints.size + ' coast edges, ' + inserted / 2 + ' coast points' +
        (recentered ? ', ' + recentered + ' cell centers moved' : '') +
        (dead.size ? ', ' + dead.size + ' sliver cells merged' : '') +
        (followed.size ? ', free nodes moved along with the curve in ' + followed.size + ' cells' : '') +
        (relaxed ? ', smoothing relaxed locally around ' + relaxed + ' faulty cells' : '') +
        (radius < s.radius ? '; radius limited to ' + radius.toFixed(0) + ' px to keep every cell valid' : '');
    },

    draw(g, state, ctx) {
      // Once step 9 has built the water cells (and is shown), it draws the water.
      if (state.riverCellsBuilt && ctx && ctx.visible && ctx.visible.riverCells) return;
      // Sea cells follow the smoothed coast exactly.
      const px = (ctx && ctx.px) || 1;  // map units per screen px: constant widths on screen
      g.fillStyle = '#5f86a8';
      g.strokeStyle = '#5f86a8';
      g.lineWidth = px;
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
      g.lineWidth = 1.5 * px;
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
