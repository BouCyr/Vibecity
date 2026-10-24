// Step 9 — river cells. Runs after the smoothing: each watercourse becomes a
// band of water cells of fixed width, built along the samples of its smoothed
// centre line, and the surrounding cells are pushed aside.
//  1. Every polygon point becomes a node, so each centre-line sample is a
//     vertex shared by the cells of both banks.
//  2. Every other point is pushed away from each course by
//     (w/2)·(1 − smoothstep(d / falloff)) — the push of all courses adds up;
//     points on the map border only slide along it.
//  3. Each centre-line sample is split: around it, the cells are grouped into
//     sectors (separated by the course, the sea or the map border) and each
//     sector gets a copy of the sample at exactly w/2 from the course (at a
//     confluence, the mitre point at w/2 from both branches; at a source on
//     the border, sliding along the border), plus the push of the other courses.
//  4. The gap becomes water: one cell per course edge of the rivers step (its
//     samples, one bank forward and the other back), a triangle at each
//     confluence; at a mouth the cell keeps the mouth point and opens on the sea.
// If a cell would fold, the push is made gentler, then the faulty courses are
// narrowed.
(function (global) {
  'use strict';

  const EPS = 1e-6;
  const edgeKey = (a, b) => (a < b ? a + ',' + b : b + ',' + a);
  const smoothstep = (t) => t * t * (3 - 2 * t);

  function signedArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
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

  const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };

  /**
   * Cells around node v in rotation order (consistent winding: the cell after
   * c is the one whose previous node is c's next node). Open when v is on the
   * map border (then the order starts at the border).
   */
  function cellsAround(rings, cellIds, v) {
    const items = cellIds.map((ci) => {
      const ns = rings[ci], i = ns.indexOf(v);
      return { cell: ci, prev: ns[(i - 1 + ns.length) % ns.length], next: ns[(i + 1) % ns.length] };
    });
    const byPrev = new Map(items.map((it) => [it.prev, it]));
    const nexts = new Set(items.map((it) => it.next));
    let start = items.find((it) => !nexts.has(it.prev));
    const closed = !start;
    if (!start) start = items.reduce((b, it) => (it.cell < b.cell ? it : b), items[0]);
    const order = [start];
    for (let it = byPrev.get(start.next); it && it !== start && order.length < items.length; it = byPrev.get(it.next)) order.push(it);
    return { order: order, closed: closed };
  }

  global.RiverCellsStep = {
    id: 'riverCells',
    title: 'River cells',
    // Above the smoothed sea, under the Voronoi edges.
    zIndex: -0.3,
    settings: [
      { key: 'falloff', label: 'Push falloff (px)', type: 'range', min: 10, max: 200, step: 5, default: 60 }
    ],

    run(state, s, rng, ctx) {
      state.riverCellsBuilt = false;
      if (!state.rivers || !state.rivers.length) return 'no watercourse';
      const W = ctx.width, H = ctx.height;
      const cells = state.cells, oldNodes = state.nodes;
      const edgePoints = state.coastEdgePoints || new Map();

      // 1. Densify: one node per polygon point.
      const nodes = oldNodes.map((n) => ({ x: n.x, y: n.y, altitude: n.altitude }));
      const edgeIds = new Map(); // edge key -> ids of its in-between points, from ep.a
      for (const [key, ep] of edgePoints) {
        const [a, b] = key.split(',').map(Number);
        const other = ep.a === a ? b : a;
        const ids = ep.points.map((p, j) => {
          const t = (j + 1) / (ep.points.length + 1);
          nodes.push({ x: p.x, y: p.y, altitude: oldNodes[ep.a].altitude * (1 - t) + oldNodes[other].altitude * t });
          return nodes.length - 1;
        });
        edgeIds.set(key, { a: ep.a, ids: ids });
      }
      const between = (a, b) => {
        const e = edgeIds.get(edgeKey(a, b));
        if (!e) return [];
        return e.a === a ? e.ids : e.ids.slice().reverse();
      };
      const baseRings = cells.map((c) => {
        const out = [];
        const ns = c.nodes;
        for (let k = 0; k < ns.length; k++) {
          out.push(ns[k]);
          for (const id of between(ns[k], ns[(k + 1) % ns.length])) out.push(id);
        }
        return out;
      });
      const winding = Math.sign(signedArea(baseRings[0].map((id) => nodes[id])));

      // 2. Dense centre lines, the width of each dense segment, the course edge it belongs to.
      const courses = state.rivers.map((r) => {
        const ids = [r.nodes[0]], segW = [], segEdge = [];
        for (let k = 0; k + 1 < r.nodes.length; k++) {
          const mid = between(r.nodes[k], r.nodes[k + 1]);
          for (const id of mid.concat([r.nodes[k + 1]])) {
            segW.push(r.edgeWidths ? r.edgeWidths[k] : r.widths[k]);
            segEdge.push(k);
            ids.push(id);
          }
        }
        return { ids: ids, segW: segW, segEdge: segEdge };
      });
      const sampleOf = new Map(); // node id -> [{ course, index }]
      courses.forEach((c, ci) => c.ids.forEach((id, i) => {
        if (!sampleOf.has(id)) sampleOf.set(id, []);
        sampleOf.get(id).push({ course: ci, index: i });
      }));
      const courseEdge = new Map(); // dense edge key -> { course, seg }
      courses.forEach((c, ci) => {
        for (let i = 0; i + 1 < c.ids.length; i++) courseEdge.set(edgeKey(c.ids[i], c.ids[i + 1]), { course: ci, seg: i });
      });

      const nodeCells = nodes.map(() => []);
      baseRings.forEach((ring, ci) => ring.forEach((id) => nodeCells[id].push(ci)));

      // Merges land cell ci into the land cell across its longest edge that is
      // not on a course (cells sharing just that edge). Without `anyCell`, only
      // a cell made of centre-line samples alone (a sliver inside a bend, closed
      // by a chord, which would vanish between the banks) is merged.
      const dead = new Set();
      const mergeCell = (ci, anyCell) => {
        const ring = baseRings[ci];
        if (cells[ci].sea || dead.has(ci) || (!anyCell && !ring.every((id) => sampleOf.has(id)))) return false;
        let best = null;
        ring.forEach((a, k) => {
          const b = ring[(k + 1) % ring.length];
          if (courseEdge.has(edgeKey(a, b))) return;
          for (const nb of nodeCells[a]) {
            if (nb === ci || dead.has(nb) || cells[nb].sea) continue;
            const other = baseRings[nb], ib = other.indexOf(b);
            if (ib < 0 || other[(ib + 1) % other.length] !== a) continue;
            if (ring.filter((id) => other.indexOf(id) >= 0).length !== 2) continue;
            const len = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
            if (!best || len > best.len) best = { k: k, nb: nb, ib: ib, len: len };
          }
        });
        if (!best) return false;
        // Path of this cell from b forward to a, inserted between b and a.
        const other = baseRings[best.nb], path = [];
        for (let k = 1; k < ring.length - 1; k++) path.push(ring[(best.k + 1 + k) % ring.length]);
        baseRings[best.nb] = other.slice(0, best.ib + 1).concat(path, other.slice(best.ib + 1));
        for (const id of path) nodeCells[id].push(best.nb);
        for (const id of ring) nodeCells[id] = nodeCells[id].filter((c) => c !== ci);
        baseRings[ci] = [];
        dead.add(ci);
        return true;
      };
      for (let ci = 0; ci < cells.length; ci++) mergeCell(ci, false);

      // Spatial grid of the course segments, for the push field.
      const GRID = 60;
      const grid = new Map();
      const gkey = (gx, gy) => gx + ',' + gy;
      courses.forEach((c, ci) => {
        for (let i = 0; i + 1 < c.ids.length; i++) {
          const a = nodes[c.ids[i]], b = nodes[c.ids[i + 1]];
          const gx0 = Math.floor(Math.min(a.x, b.x) / GRID), gx1 = Math.floor(Math.max(a.x, b.x) / GRID);
          const gy0 = Math.floor(Math.min(a.y, b.y) / GRID), gy1 = Math.floor(Math.max(a.y, b.y) / GRID);
          for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
            const k = gkey(gx, gy);
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push([ci, i]);
          }
        }
      });

      /** Nearest point of each course within `range` of p: Map course -> { d, qx, qy, w }. */
      const nearest = (px, py, range) => {
        const out = new Map();
        const r = Math.ceil(range / GRID);
        const gx = Math.floor(px / GRID), gy = Math.floor(py / GRID);
        for (let x = gx - r; x <= gx + r; x++) for (let y = gy - r; y <= gy + r; y++) {
          const list = grid.get(gkey(x, y));
          if (!list) continue;
          for (const [ci, i] of list) {
            const a = nodes[courses[ci].ids[i]], b = nodes[courses[ci].ids[i + 1]];
            const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
            let t = l2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0;
            t = Math.max(0, Math.min(1, t));
            const qx = a.x + t * dx, qy = a.y + t * dy;
            const d = Math.hypot(px - qx, py - qy);
            const cur = out.get(ci);
            if (d < range && (!cur || d < cur.d)) out.set(ci, { d: d, qx: qx, qy: qy, w: courses[ci].segW[i] });
          }
        }
        return out;
      };

      const onBorderX = (p) => p.x <= EPS || p.x >= W - EPS;
      const onBorderY = (p) => p.y <= EPS || p.y >= H - EPS;

      /** One attempt; returns positions, rings and water cells (nothing mutated). */
      const attempt = (falloffOf, scaleOf, extraOf) => {
        const pos = nodes.map((n) => ({ x: n.x, y: n.y }));
        const width = (ci, w) => w * scaleOf(ci);
        const push = (p, exclude) => {
          let dx = 0, dy = 0;
          const near = nearest(p.x, p.y, 200);
          for (const [ci, q] of near) {
            if (exclude && exclude.has(ci)) continue;
            const f = falloffOf(ci);
            if (q.d >= f || q.d < 1e-9) continue;
            const m = (width(ci, q.w) / 2) * (1 - smoothstep(q.d / f));
            dx += ((p.x - q.qx) / q.d) * m;
            dy += ((p.y - q.qy) / q.d) * m;
          }
          if (onBorderX(p)) dx = 0;
          if (onBorderY(p)) dy = 0;
          return { x: dx, y: dy };
        };

        // Push every point that is not on a centre line. A point never ends up
        // inside a band (closer than half a width to a course, plus a margin):
        // between two close stretches, the push is scaled down.
        const clear = (p) => {
          for (const [ci, q] of nearest(p.x, p.y, 100)) if (q.d < width(ci, q.w) / 2 + 2) return false;
          return true;
        };
        const place = (n, d) => ({ x: Math.min(W, Math.max(0, n.x + d.x)), y: Math.min(H, Math.max(0, n.y + d.y)) });
        nodes.forEach((n, id) => {
          if (sampleOf.has(id)) return;
          const d = push(n, null);
          const extra = extraOf(id);
          if (extra) {
            // Extra push away from the nearest course (thin cells along a bank).
            let best = null;
            for (const [ci, q] of nearest(n.x, n.y, 200)) if (!best || q.d < best.q.d) best = { ci: ci, q: q };
            if (best && best.q.d > 1e-9) {
              const m = extra * width(best.ci, best.q.w) / 2;
              const e = { x: onBorderX(n) ? 0 : ((n.x - best.q.qx) / best.q.d) * m, y: onBorderY(n) ? 0 : ((n.y - best.q.qy) / best.q.d) * m };
              for (let f = 1; f >= 0.25; f /= 2) {
                if (!clear(place(n, { x: d.x + e.x * f, y: d.y + e.y * f }))) continue;
                d.x += e.x * f;
                d.y += e.y * f;
                break;
              }
            }
          }
          let p = place(n, d);
          for (let f = 0.5; f >= 0.125 && !clear(p); f /= 2) {
            const q = place(n, { x: d.x * f, y: d.y * f });
            if (clear(q)) p = q;
          }
          pos[id] = p;
        });

        if (rigid.size) {
          const sum = new Map();
          for (const [id, g] of rigid) {
            const d = { x: pos[id].x - nodes[id].x, y: pos[id].y - nodes[id].y };
            const t = sum.get(g) || { x: 0, y: 0, n: 0 };
            sum.set(g, { x: t.x + d.x, y: t.y + d.y, n: t.n + 1 });
          }
          for (const [id, g] of rigid) {
            const t = sum.get(g), n = nodes[id];
            pos[id] = { x: onBorderX(n) ? n.x : Math.min(W, Math.max(0, n.x + t.x / t.n)), y: onBorderY(n) ? n.y : Math.min(H, Math.max(0, n.y + t.y / t.n)) };
          }
        }

        // Split the centre-line samples.
        const copyOf = new Map();     // 'v|cell' -> id
        const extra = [];              // new nodes { x, y, from }
        // Copies of a point on the map border stay on it (fx / fy: fixed coordinate).
        const newId = (p, from) => {
          const n = nodes[from];
          extra.push({ x: p.x, y: p.y, from: from, fx: onBorderX(n), fy: onBorderY(n) });
          return nodes.length + extra.length - 1;
        };
        const seaInsert = new Map();   // 'v>n' -> copy id lying between v and n for sea cells
        const rawStarts = new Map();   // copy id -> Map(next sample -> offset of v along that course edge)
        const junctions = [];
        const mouths = new Set();

        for (const [v, samples] of sampleOf) {
          const P = nodes[v];
          const { order, closed } = cellsAround(baseRings, nodeCells[v], v);
          const n = order.length;
          const isCourse = (u) => courseEdge.has(edgeKey(v, u));
          const breakAfter = (i) => isCourse(order[i].next) || cells[order[i].cell].sea || cells[order[(i + 1) % n].cell].sea;
          let rot = 0;
          if (closed) {
            rot = -1;
            for (let i = 0; i < n; i++) if (breakAfter(i)) { rot = (i + 1) % n; break; }
            if (rot < 0) continue;
          }
          const seq = order.slice(rot).concat(order.slice(0, rot));
          const isBreak = (i) => (i === n - 1 ? closed && breakAfter((rot + n - 1) % n) : breakAfter((rot + i) % n));
          const sectors = [];
          let cur = null;
          seq.forEach((it, i) => {
            if (!cells[it.cell].sea) {
              if (!cur) { cur = { items: [] }; sectors.push(cur); }
              cur.items.push(it);
            }
            if (cells[it.cell].sea || isBreak(i)) cur = null;
          });
          if (seq.some((it) => cells[it.cell].sea)) mouths.add(v);
          const own = new Set(samples.map((sm) => sm.course));

          const ids = [];
          for (const sec of sectors) {
            const first = sec.items[0], last = sec.items[sec.items.length - 1];
            const i0 = seq.indexOf(first), i1 = seq.indexOf(last);
            const kb = i0 === 0 && !closed ? 'border' : isCourse(first.prev) ? 'course' : 'water';
            const ka = i1 === n - 1 && !closed ? 'border' : isCourse(last.next) ? 'course' : 'water';
            // Unit normal of the course edge pointing into the sector, from the
            // ring orientation: inside a ring of positive winding, the interior is
            // on the left of each directed edge. `before` edge: prev -> v in the
            // first cell; `after` edge: v -> next in the last cell.
            const inward = (from, to) => {
              const d = unit(nodes[to].x - nodes[from].x, nodes[to].y - nodes[from].y);
              return { x: -d.y * winding, y: d.x * winding };
            };
            const intoSector = (u, cell) => {
              const d = unit(nodes[u].x - P.x, nodes[u].y - P.y);
              const nrm = u === first.prev && cell === first.cell ? inward(u, v) : inward(v, u);
              return { x: nrm.x, y: nrm.y, d: d };
            };
            const wOf = (u) => { const e = courseEdge.get(edgeKey(v, u)); return width(e.course, courses[e.course].segW[e.seg]); };
            let p = null, raw = null;
            const bounding = new Set();
            if (kb === 'course') bounding.add(courseEdge.get(edgeKey(v, first.prev)).course);
            if (ka === 'course') bounding.add(courseEdge.get(edgeKey(v, last.next)).course);
            if (kb === 'course' && ka === 'course') {
              const n1 = intoSector(first.prev, first.cell), n2 = intoSector(last.next, last.cell);
              const w1 = wOf(first.prev) / 2, w2 = wOf(last.next) / 2;
              raw = [[first.prev, P.x + n1.x * w1, P.y + n1.y * w1], [last.next, P.x + n2.x * w2, P.y + n2.y * w2]];
              const det = n1.x * n2.y - n1.y * n2.x;
              if (Math.abs(det) < 0.25) {
                const m = unit(n1.x + n2.x, n1.y + n2.y), r = (w1 + w2) / 2;
                p = { x: P.x + m.x * r, y: P.y + m.y * r };
              } else {
                // Mitre: n1·a = w1, n2·a = w2.
                let ax = (w1 * n2.y - w2 * n1.y) / det, ay = (n1.x * w2 - n2.x * w1) / det;
                const l = Math.hypot(ax, ay), cap = 3 * Math.max(w1, w2);
                if (l > cap) { ax *= cap / l; ay *= cap / l; }
                p = { x: P.x + ax, y: P.y + ay };
              }
            } else if (kb === 'course' || ka === 'course') {
              const u = kb === 'course' ? first.prev : last.next;
              const cell = kb === 'course' ? first.cell : last.cell;
              const nn = intoSector(u, cell);
              const w = wOf(u) / 2;
              const kind = kb === 'course' ? ka : kb;
              if (kind === 'border') {
                // Slide along the border edge.
                const bnode = kb === 'course' ? last.next : first.prev;
                const dir = unit(nodes[bnode].x - P.x, nodes[bnode].y - P.y);
                const sin = Math.abs(nn.d.x * dir.y - nn.d.y * dir.x);
                const t = Math.min(w / Math.max(0.3, sin), 4 * w);
                p = { x: P.x + dir.x * t, y: P.y + dir.y * t };
              } else {
                // Mouth: square to the course; the sea cell takes the copy.
                p = { x: P.x + nn.x * w, y: P.y + nn.y * w };
              }
            }
            let id = v;
            const rawStart = new Map();
            if (p) {
              // Push of the other courses.
              const d = push(P, bounding.size ? bounding : own);
              p = { x: p.x + d.x, y: p.y + d.y };
              if (raw) for (const [u, x, y] of raw) rawStart.set(u, { x: x + d.x, y: y + d.y });
              if (onBorderX(P)) p.x = P.x;
              if (onBorderY(P)) p.y = P.y;
              p.x = Math.min(W, Math.max(0, p.x));
              p.y = Math.min(H, Math.max(0, p.y));
              id = newId(p, v);
              if (rawStart.size) rawStarts.set(id, rawStart);
              if (kb === 'water') seaInsert.set(v + '>' + first.prev, id);
              if (ka === 'water') seaInsert.set(v + '>' + last.next, id);
            }
            for (const it of sec.items) copyOf.set(v + '|' + it.cell, id);
            ids.push(id);
          }
          let ce = 0;
          for (const it of order) if (isCourse(it.next)) ce++;
          if (ce >= 3) junctions.push({ v: v, copies: ids });
        }

        // Rings: land cells use their sector's copy; sea cells get the copies inserted.
        const rings = baseRings.map((ring, ci) => {
          const out = [];
          for (let k = 0; k < ring.length; k++) {
            const v = ring[k];
            if (!sampleOf.has(v)) { out.push(v); continue; }
            if (!cells[ci].sea) { out.push(copyOf.has(v + '|' + ci) ? copyOf.get(v + '|' + ci) : v); continue; }
            const p = ring[(k - 1 + ring.length) % ring.length], q = ring[(k + 1) % ring.length];
            const ip = seaInsert.get(v + '>' + p), iq = seaInsert.get(v + '>' + q);
            if (typeof ip === 'number') out.push(ip);
            out.push(v);
            if (typeof iq === 'number') out.push(iq);
          }
          return out;
        });

        // Bank copies along each course: side A = the cell holding the directed
        // segment ids[i] -> ids[i+1], side B = the other one.
        const bankCell = (c, i, forward) => {
          const a = c.ids[i], b = c.ids[i + 1];
          for (const cc of nodeCells[a]) {
            const rr = baseRings[cc], j = rr.indexOf(a);
            if (rr[(forward ? j + 1 : j - 1 + rr.length) % rr.length] === b) return cc;
          }
          return -1;
        };
        const banks = courses.map((c) => {
          const A = [], B = [];
          for (let i = 0; i < c.ids.length; i++) {
            const seg = Math.min(i, c.ids.length - 2);
            // At a sample shared by two segments, use the segment of the same course edge.
            A.push(copyOf.get(c.ids[i] + '|' + bankCell(c, seg, true)));
            B.push(copyOf.get(c.ids[i] + '|' + bankCell(c, seg, false)));
          }
          return { A: A, B: B };
        });
        // Inside a bend tighter than the half width the offset bank folds back:
        // where it loops, the copies between the two crossing segments go to the
        // crossing point; where it runs backwards (against the course), those
        // copies are spread along the chord between the good copies around them.
        const P = (id) => (id < nodes.length ? pos[id] : extra[id - nodes.length]);
        const segX = (a, b, c, d) => {
          const r = { x: b.x - a.x, y: b.y - a.y }, q = { x: d.x - c.x, y: d.y - c.y };
          const den = r.x * q.y - r.y * q.x;
          if (Math.abs(den) < 1e-12) return null;
          const t = ((c.x - a.x) * q.y - (c.y - a.y) * q.x) / den, u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
          return t > 0 && t < 1 && u > 0 && u < 1 ? { x: a.x + t * r.x, y: a.y + t * r.y } : null;
        };
        const setPos = (id, p) => {
          if (id === undefined || id < nodes.length) return;
          const e = extra[id - nodes.length];
          if (!e.fx) e.x = p.x;
          if (!e.fy) e.y = p.y;
        };
        banks.forEach((bk, ci) => {
          const c = courses[ci];
          for (const side of [bk.A, bk.B]) {
            for (let i = 0; i + 1 < side.length; i++) {
              for (let j = Math.min(side.length - 2, i + 60); j >= i + 2; j--) {
                const x = segX(P(side[i]), P(side[i + 1]), P(side[j]), P(side[j + 1]));
                if (!x) continue;
                for (let k = i + 1; k <= j; k++) setPos(side[k], x);
                i = j;
                break;
              }
            }
            // Segment k (copy k -> k + 1) runs backwards?
            const back = (k) => {
              const p = P(side[k]), q = P(side[k + 1]), a = nodes[c.ids[k]], b = nodes[c.ids[k + 1]];
              return (q.x - p.x) * (b.x - a.x) + (q.y - p.y) * (b.y - a.y) < 0;
            };
            for (let k = 0; k + 1 < side.length; k++) {
              if (!back(k)) continue;
              let e = k;
              while (e + 2 < side.length && back(e + 1)) e++;
              // Copies k .. e + 1 are involved; keep the outer ones when possible.
              const a = Math.max(0, k - 1), b = Math.min(side.length - 1, e + 2);
              const pa = P(side[a]), pb = P(side[b]);
              for (let m = a + 1; m < b; m++) {
                const t = (m - a) / (b - a);
                setPos(side[m], { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t });
              }
              k = e + 1;
            }
          }
        });

        // Inside the tightest bends the bank copies bunch up within a pixel or
        // so: each bunch is snapped onto one point so that it cannot zigzag.
        const snapBanks = () => {
          for (const bk of banks) {
            for (const side of [bk.A, bk.B]) {
              for (let k = 0; k < side.length; k++) {
                if (side[k] === undefined) continue;
                let e = k;
                while (e + 1 < side.length && side[e + 1] !== undefined &&
                  Math.hypot(P(side[e + 1]).x - P(side[e]).x, P(side[e + 1]).y - P(side[e]).y) < 1.5) e++;
                if (e > k) {
                  let x = 0, y = 0;
                  for (let m = k; m <= e; m++) { x += P(side[m]).x; y += P(side[m]).y; }
                  const c = { x: x / (e - k + 1), y: y / (e - k + 1) };
                  for (let m = k; m <= e; m++) setPos(side[m], c);
                }
                k = e;
              }
            }
          }
        };
        snapBanks();

        // At a confluence, the banks of two branches meeting at a sector copy run
        // past each other near the junction: both are cut at their crossing.
        for (const j of junctions) {
          const chains = [];
          for (const sm of sampleOf.get(j.v)) {
            const c = courses[sm.course], i = sm.index;
            for (const dir of [-1, 1]) {
              if (i + dir < 0 || i + dir >= c.ids.length) continue;
              const seg0 = dir > 0 ? i : i - 1;
              for (const fwd of [true, false]) {
                const side = fwd ? banks[sm.course].A : banks[sm.course].B;
                const chain = [copyOf.get(j.v + '|' + bankCell(c, seg0, fwd))];
                for (let k = i + dir, n = 0; k >= 0 && k < c.ids.length && n < 40; k += dir, n++) chain.push(side[k]);
                chains.push({ key: sm.course + ':' + dir, next: c.ids[i + dir], chain: chain.filter((id) => id !== undefined) });
              }
            }
          }
          for (let a = 0; a < chains.length; a++) for (let b = a + 1; b < chains.length; b++) {
            const c1 = chains[a].chain, c2 = chains[b].chain;
            if (chains[a].key === chains[b].key || c1[0] !== c2[0] || !rawStarts.has(c1[0]) || c1.length < 2 || c2.length < 2) continue;
            // The two offset lines, starting at the offset of the junction point
            // along each branch (the sector copy is where they meet).
            const rs = rawStarts.get(c1[0]);
            const s1 = rs.get(chains[a].next), s2 = rs.get(chains[b].next);
            if (!s1 || !s2) continue;
            const p1 = [s1].concat(c1.slice(1).map(P)), p2 = [s2].concat(c2.slice(1).map(P));
            let hit = null;
            for (let x = 0; x + 1 < p1.length && !hit; x++) {
              for (let y = 0; y + 1 < p2.length; y++) {
                const X = segX(p1[x], p1[x + 1], p2[y], p2[y + 1]);
                if (X) { hit = { x: x, y: y, p: X }; break; }
              }
            }
            if (!hit && c1.length > 2 && c2.length > 2) {
              // The banks do not reach each other (the copies along them are
              // pushed by the other branch, the sector copy is not): the sector
              // copy goes where the two banks, extended, meet.
              const a1 = P(c1[1]), b1 = P(c1[2]), a2 = P(c2[1]), b2 = P(c2[2]);
              const r = { x: a1.x - b1.x, y: a1.y - b1.y }, q = { x: a2.x - b2.x, y: a2.y - b2.y };
              const den = r.x * q.y - r.y * q.x;
              if (Math.abs(den) > 1e-9) {
                const t = ((a2.x - a1.x) * q.y - (a2.y - a1.y) * q.x) / den, u = ((a2.x - a1.x) * r.y - (a2.y - a1.y) * r.x) / den;
                const X = { x: a1.x + t * r.x, y: a1.y + t * r.y };
                const lim = 3 * Math.max(Math.hypot(r.x, r.y), Math.hypot(q.x, q.y), 10);
                if (t > 0 && u > 0 && Math.hypot(X.x - a1.x, X.y - a1.y) < lim && Math.hypot(X.x - a2.x, X.y - a2.y) < lim) hit = { x: 0, y: 0, p: X };
              }
            }
            if (!hit) continue;
            for (const id of c1.slice(0, hit.x + 1).concat(c2.slice(0, hit.y + 1))) setPos(id, hit.p);
            // Copies right next to the new corner join it (no sub-pixel zigzag).
            for (const ch of [c1, c2]) {
              for (let k = 1; k < ch.length && Math.hypot(P(ch[k]).x - hit.p.x, P(ch[k]).y - hit.p.y) < 1.5; k++) setPos(ch[k], hit.p);
            }
          }
        }

        snapBanks();

        // Water cells: one per course edge of the rivers step, a triangle per confluence.
        // Also, per course and centre-line sample, the nodes standing for it on
        // the banks (its copies, and the mouth point): the water level is set on them.
        const water = [];
        const sampleIds = courses.map((c) => c.ids.map(() => new Set()));
        courses.forEach((c, ci) => {
          const r = state.rivers[ci];
          for (let k = 0; k + 1 < r.nodes.length; k++) {
            const idx = [];
            c.segEdge.forEach((e, i) => { if (e === k) idx.push(i); });
            const s0 = idx[0], s1 = idx[idx.length - 1] + 1; // sample range [s0, s1]
            const A = [], B = [];
            for (let i = s0; i <= s1; i++) {
              const seg = Math.min(i, s1 - 1);
              const v = c.ids[i];
              A.push(copyOf.get(v + '|' + bankCell(c, seg, true)));
              B.push(copyOf.get(v + '|' + bankCell(c, seg, false)));
              for (const id of [A[A.length - 1], B[B.length - 1]]) if (id !== undefined) sampleIds[ci][i].add(id);
            }
            if (mouths.has(c.ids[s1])) sampleIds[ci][s1].add(c.ids[s1]);
            if (mouths.has(c.ids[s0])) sampleIds[ci][s0].add(c.ids[s0]);
            const raw = A.slice();
            if (mouths.has(c.ids[s1])) raw.push(c.ids[s1]);
            for (let i = B.length - 1; i >= 0; i--) raw.push(B[i]);
            if (mouths.has(c.ids[s0])) raw.push(c.ids[s0]);
            const ring = raw.filter((id, i) => id !== undefined && id !== raw[(i + 1) % raw.length]);
            water.push({ river: ci, edge: k, ring: ring });
          }
        });
        for (const j of junctions) water.push({ river: state.rivers.findIndex((r) => r.nodes.indexOf(j.v) >= 0), junction: true, ring: j.copies.slice() });

        for (const e of extra) pos.push({ x: e.x, y: e.y });
        return { pos: pos, extra: extra, rings: rings, water: water, junctions: junctions, sampleIds: sampleIds };
      };

      // Validate (every ring keeps the winding and does not cross itself, the
      // cells tile the map). On failure: a folded cell away from the courses
      // moves as a block; a thin cell along a bank has its free points pushed
      // further, then is merged into a neighbour; as a last resort the push is
      // made gentler and the courses near the faulty cells are narrowed.
      const falloffs = new Map(), scales = new Map();
      const falloffOf = (ci) => Math.max(s.falloff, 1.5 * Math.max(...courses[ci].segW) * (scales.get(ci) || 1)) * (falloffs.get(ci) || 1);
      const scaleOf = (ci) => scales.get(ci) || 1;
      const extras = new Map();
      const extraOf = (id) => extras.get(id) || 0;
      const rigid = new Map(); // node -> group: the group moves by its mean push
      let res = null, best = null, notes = '';
      for (let tries = 0; tries < 20; tries++) {
        res = attempt(falloffOf, scaleOf, extraOf);
        res.dead = new Set(dead);
        res.gentler = falloffs.size;
        res.narrowed = scales.size ? scales.size + ' course(s) down to ' + Math.round(Math.min(...scales.values()) * 100) + '%' : '';
        const at = (id) => res.pos[id];
        for (const w of res.water) if (Math.sign(signedArea(w.ring.map(at))) !== winding) w.ring.reverse();
        const bad = new Set();
        let total = 0, faulty = 0, retry = false;
        const all = res.rings.map((r, i) => ({ ring: r, river: null, cell: i })).filter((it) => !dead.has(it.cell))
          .concat(res.water.map((w) => ({ ring: w.ring, river: w.river })));
        for (const item of all) {
          const pts = item.ring.map(at);
          const a = signedArea(pts);
          total += Math.abs(a);
          if (item.ring.length >= 3 && Math.sign(a) === winding && !selfCrossing(pts)) continue;
          faulty++;
          if (item.river === null) {
            if (item.ring.every((id) => id < nodes.length && !sampleOf.has(id)) && !item.ring.every((id) => rigid.get(id) === item.cell)) {
              for (const id of item.ring) rigid.set(id, item.cell);
              retry = true;
              continue;
            }
            let more = false;
            for (const id of item.ring) {
              if (id >= nodes.length || sampleOf.has(id) || extraOf(id) >= 2) continue;
              extras.set(id, extraOf(id) + 0.5);
              more = true;
            }
            if (more || mergeCell(item.cell, true)) { retry = true; continue; }
          }
          for (const p of pts) for (const ci of nearest(p.x, p.y, 2 * s.falloff).keys()) bad.add(ci);
          if (item.river !== null && item.river >= 0) bad.add(item.river);
        }
        const tiled = Math.abs(total - W * H) < 1;
        if (!faulty && tiled) break;
        res.faulty = faulty + (tiled ? 0 : 1);
        if (!best || res.faulty < best.faulty) best = res;
        res = null;
        if (retry) continue;
        for (const ci of bad.size ? bad : courses.keys()) {
          if ((falloffs.get(ci) || 1) < 2.2) falloffs.set(ci, (falloffs.get(ci) || 1) * 1.5);
          else scales.set(ci, (scales.get(ci) || 1) * 0.8);
        }
      }
      if (!res) {
        // No fully valid layout: keep the best one and say so.
        res = best;
        notes += '; ' + res.faulty + ' cell(s) could not be kept valid';
      }
      if (res.gentler) notes += ', push made gentler near ' + res.gentler + ' course(s)';
      if (res.narrowed) notes += ', narrowed ' + res.narrowed;

      // Commit.
      const finalNodes = res.pos.map((p, id) => ({
        x: p.x, y: p.y,
        altitude: id < nodes.length ? nodes[id].altitude : nodes[res.extra[id - nodes.length].from].altitude,
        cells: [], river: -1
      }));
      cells.forEach((c, ci) => { c.nodes = res.rings[ci]; });
      // Drop the merged slivers (and their entries in the sea clean-up record).
      const remap = cells.map(() => -1);
      const live = [];
      cells.forEach((c, ci) => { if (!res.dead.has(ci)) { remap[ci] = live.length; live.push(c); } });
      if (state.seaChanges) state.seaChanges = state.seaChanges.filter((ch) => remap[ch.cell] >= 0).map((ch) => ({ cell: remap[ch.cell], toSea: ch.toSea }));
      state.cells = live;
      for (const r of state.rivers) r.cells = [];
      for (const w of res.water) {
        const alt = w.ring.reduce((a, id) => a + finalNodes[id].altitude, 0) / w.ring.length;
        const cell = { site: { x: 0, y: 0 }, nodes: w.ring, neighbors: [], sea: false, river: w.river, junction: !!w.junction, altitude: alt };
        if (w.river >= 0) state.rivers[w.river].cells.push(live.length);
        live.push(cell);
      }
      state.rivers.forEach((r, ci) => {
        r.centerline = courses[ci].ids.map((id) => ({ x: nodes[id].x, y: nodes[id].y }));
        // Node ids on the banks for each centre-line sample, source → mouth/junction.
        r.sampleNodes = res.sampleIds[ci].map((set) => [...set]);
      });
      live.forEach((c, ci) => {
        for (const id of c.nodes) finalNodes[id].cells.push(ci);
        c.poly = c.nodes.map((id) => ({ x: finalNodes[id].x, y: finalNodes[id].y }));
        c.polyAlt = c.nodes.map((id) => finalNodes[id].altitude);
        if (c.river !== undefined) c.site = polygonCentroid(c.poly);
      });
      state.nodes = finalNodes;
      state.coastEdgePoints = new Map();
      const owners = new Map();
      live.forEach((c, ci) => {
        const ns = c.nodes;
        for (let k = 0; k < ns.length; k++) {
          const key = edgeKey(ns[k], ns[(k + 1) % ns.length]);
          if (owners.has(key)) owners.get(key).push(ci); else owners.set(key, [ci]);
        }
      });
      for (const c of live) c.neighbors = [];
      const shore = [];
      const isWater = (c) => c.sea || c.river !== undefined;
      for (const [key, list] of owners) {
        if (list.length !== 2) continue;
        live[list[0]].neighbors.push(list[1]);
        live[list[1]].neighbors.push(list[0]);
        if (isWater(live[list[0]]) !== isWater(live[list[1]])) shore.push(key.split(',').map(Number));
      }
      for (const c of live) {
        c.neighbors.sort((x, y) => x - y);
        c.riverbank = c.river === undefined && !c.sea && c.neighbors.some((j) => live[j].river !== undefined);
      }
      state.shore = shore;
      state.riverCellsBuilt = true;
      return res.water.length + ' water cells (' + res.junctions.length + ' confluences)' + notes;
    },

    draw(g, state, ctx) {
      if (!state.riverCellsBuilt) return;
      const px = (ctx && ctx.px) || 1;  // map units per screen px: constant widths on screen
      g.fillStyle = '#5f86a8';
      g.strokeStyle = '#5f86a8';
      g.lineWidth = px;
      g.lineJoin = 'round';
      for (const c of state.cells) {
        if (!(c.sea || c.river !== undefined) || !c.poly.length) continue;
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
      for (const [a, b] of state.shore) {
        g.moveTo(state.nodes[a].x, state.nodes[a].y);
        g.lineTo(state.nodes[b].x, state.nodes[b].y);
      }
      g.stroke();
    }
  };
})(window);
