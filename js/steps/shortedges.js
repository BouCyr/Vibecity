// Step 6 — merge short edges. Every Voronoi edge shorter than `minLength` is
// removed: its two nodes are merged into one, shortest edges first. A triangle
// cell along the edge collapses to a segment and is removed (its two neighbours
// then share an edge). A merge is skipped when it would fold or pinch a cell. Nodes on the map border stay
// on it (corners stay in place). Runs before the rivers so that they follow the
// simplified graph.
(function (global) {
  'use strict';

  const EPS = 1e-6;
  const edgeKey = (a, b) => (a < b ? a + ',' + b : b + ',' + a);

  function signedArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }

  function insidePolygon(poly, x, y) {
    let r = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) r = !r;
    }
    return r;
  }

  /** Cell node list with `b` replaced by `a` and consecutive duplicates removed. */
  function mergedRing(ns, a, b) {
    const out = [];
    for (const id of ns) {
      const v = id === b ? a : id;
      if (out[out.length - 1] !== v) out.push(v);
    }
    while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
    return out;
  }

  global.ShortEdgesStep = {
    id: 'shortEdges',
    title: 'Merge short edges',
    defaultVisible: false,
    settings: [
      { key: 'minLength', label: 'Minimum edge length (px)', type: 'range', min: 0, max: 100, step: 1, default: 30 }
    ],

    run(state, s, rng, ctx) {
      const W = ctx.width, H = ctx.height;
      const cells = state.cells, nodes = state.nodes;
      const sides = (n) => ({
        x: n.x <= EPS ? 0 : n.x >= W - EPS ? W : null,
        y: n.y <= EPS ? 0 : n.y >= H - EPS ? H : null
      });
      const alive = new Uint8Array(nodes.length).fill(1);
      const cellAlive = new Uint8Array(cells.length).fill(1);
      let removedCells = 0;
      const cellSets = nodes.map((n) => new Set(n.cells));
      const winding = Math.sign(signedArea(cells[0].nodes.map((id) => nodes[id])));
      const merged = [];

      /**
       * Candidate positions of the merged node (tried in order), or [] when the
       * merge would pull a node off the border.
       */
      const mergedPositions = (a, b) => {
        const A = nodes[a], B = nodes[b], sa = sides(A), sb = sides(B);
        const fixedA = sa.x !== null || sa.y !== null, fixedB = sb.x !== null || sb.y !== null;
        if (!fixedA && !fixedB) return [{ x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 }, { x: A.x, y: A.y }, { x: B.x, y: B.y }];
        if (fixedA && !fixedB) return [{ x: A.x, y: A.y }];
        if (fixedB && !fixedA) return [{ x: B.x, y: B.y }];
        const one = mergedPosition(sa, sb, A, B);
        return one ? [one] : [];
      };
      const mergedPosition = (sa, sb, A, B) => {
        // Both on the border: corners stay; otherwise they must share a side.
        const cornerA = sa.x !== null && sa.y !== null, cornerB = sb.x !== null && sb.y !== null;
        if (cornerA && cornerB) return null;
        if (cornerA) return (sb.x !== null && sb.x === sa.x) || (sb.y !== null && sb.y === sa.y) ? { x: A.x, y: A.y } : null;
        if (cornerB) return (sa.x !== null && sa.x === sb.x) || (sa.y !== null && sa.y === sb.y) ? { x: B.x, y: B.y } : null;
        if (sa.x !== null && sa.x === sb.x) return { x: sa.x, y: (A.y + B.y) / 2 };
        if (sa.y !== null && sa.y === sb.y) return { x: (A.x + B.x) / 2, y: sa.y };
        return null;
      };

      /** Merge b into a if every affected cell stays a proper polygon of the same winding. */
      const tryMerge = (a, b) => {
        const affected = new Set([...cellSets[a], ...cellSets[b]]);
        const rings = new Map();
        const collapsed = [];
        for (const ci of affected) {
          const ns = cells[ci].nodes;
          const ia = ns.indexOf(a), ib = ns.indexOf(b);
          // Both in a cell but not consecutive: the merge would pinch that cell.
          if (ia >= 0 && ib >= 0 && Math.abs(ia - ib) !== 1 && Math.abs(ia - ib) !== ns.length - 1) return false;
          const ring = mergedRing(ns, a, b);
          if (ring.length < 2) return false;
          if (ring.length === 2) collapsed.push(ci); // triangle along the edge: removed
          else rings.set(ci, ring);
        }
        // Never remove both cells along the edge (that would leave a hole).
        if (collapsed.length > 1) return false;
        const valid = (pos) => {
          for (const ring of rings.values()) {
            const area = signedArea(ring.map((id) => (id === a ? pos : nodes[id])));
            if (Math.sign(area) !== winding || Math.abs(area) < 1) return false;
          }
          return true;
        };
        const pos = mergedPositions(a, b).find(valid);
        if (!pos) return false;
        const A = nodes[a], B = nodes[b];
        A.altitude = (A.altitude + B.altitude) / 2;
        A.x = pos.x; A.y = pos.y;
        for (const [ci, ring] of rings) cells[ci].nodes = ring;
        for (const ci of cellSets[b]) cellSets[a].add(ci);
        cellSets[b].clear();
        for (const ci of collapsed) {
          cellAlive[ci] = 0;
          removedCells++;
          for (const id of cells[ci].nodes) cellSets[id].delete(ci);
          cells[ci].nodes = [];
        }
        alive[b] = 0;
        merged.push({ x: pos.x, y: pos.y });
        return true;
      };

      // Shortest edges first; repeat while merges happen (moved nodes change lengths).
      let changed = true, passes = 0;
      while (changed && passes < 30 && s.minLength > 0) {
        changed = false;
        passes++;
        const edges = new Map();
        for (const c of cells) {
          const ns = c.nodes;
          for (let k = 0; k < ns.length; k++) {
            const a = ns[k], b = ns[(k + 1) % ns.length];
            const d = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
            if (d < s.minLength) edges.set(edgeKey(a, b), [d, Math.min(a, b), Math.max(a, b)]);
          }
        }
        const list = [...edges.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
        for (const [, a, b] of list) {
          if (!alive[a] || !alive[b]) continue;
          const d = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
          if (d >= s.minLength) continue;
          // Still an edge? (some cell has a and b consecutive)
          let isEdge = false;
          for (const ci of cellSets[a]) {
            const ns = cells[ci].nodes, i = ns.indexOf(a);
            if (ns[(i + 1) % ns.length] === b || ns[(i - 1 + ns.length) % ns.length] === b) { isEdge = true; break; }
          }
          if (isEdge && tryMerge(a, b)) changed = true;
        }
      }

      // Drop removed cells (and their entries in the sea clean-up record).
      const cellRemap = new Int32Array(cells.length).fill(-1);
      const keptCells = [];
      cells.forEach((c, ci) => { if (cellAlive[ci]) { cellRemap[ci] = keptCells.length; keptCells.push(c); } });
      if (state.seaChanges) {
        state.seaChanges = state.seaChanges.filter((ch) => cellAlive[ch.cell]).map((ch) => ({ cell: cellRemap[ch.cell], toSea: ch.toSea }));
      }
      state.cells = keptCells;
      const cellsNow = keptCells;

      // Compact the node list and rebuild what depends on it.
      const remap = new Int32Array(nodes.length).fill(-1);
      const kept = [];
      nodes.forEach((n, i) => { if (alive[i]) { remap[i] = kept.length; kept.push(n); } });
      for (const n of kept) n.cells = [];
      cellsNow.forEach((c, ci) => {
        c.nodes = c.nodes.map((id) => remap[id]);
        for (const id of c.nodes) kept[id].cells.push(ci);
        c.poly = c.nodes.map((id) => ({ x: kept[id].x, y: kept[id].y }));
        if (!insidePolygon(c.poly, c.site.x, c.site.y)) c.site = polygonCentroid(c.poly);
      });
      state.nodes = kept;

      // Neighbours: cells sharing an edge.
      const owners = new Map();
      cellsNow.forEach((c, ci) => {
        const ns = c.nodes;
        for (let k = 0; k < ns.length; k++) {
          const key = edgeKey(ns[k], ns[(k + 1) % ns.length]);
          if (owners.has(key)) owners.get(key).push(ci); else owners.set(key, [ci]);
        }
      });
      for (const c of cellsNow) c.neighbors = [];
      for (const list of owners.values()) {
        if (list.length !== 2) continue;
        cellsNow[list[0]].neighbors.push(list[1]);
        cellsNow[list[1]].neighbors.push(list[0]);
      }
      for (const c of cellsNow) c.neighbors.sort((x, y) => x - y);

      // Merged border edges can leave a land cell touching the map border by a
      // single point between sea cells: it becomes sea. Small islands (up to 3
      // cells, as in the sea clean-up) that merges or this leave become sea too.
      const seaChanges = state.seaChanges || (state.seaChanges = []);
      const pinches = removeBorderPinches(state, W, H, seaChanges);
      const islands = removeSmallIslands(cellsNow, 3, seaChanges);
      for (const c of cellsNow) if (c.sea) c.altitude = 0;

      updateSeaFlags(state);
      for (const n of state.nodes) if (n.sea) n.altitude = 0;
      state.mergedPoints = merged;

      let shortest = Infinity;
      for (const key of owners.keys()) {
        const [a, b] = key.split(',').map(Number);
        shortest = Math.min(shortest, Math.hypot(kept[a].x - kept[b].x, kept[a].y - kept[b].y));
      }
      return merged.length + ' edges removed, ' + removedCells + ' small triangle cells removed, ' + kept.length +
        ' nodes left, shortest edge ' + shortest.toFixed(1) + ' px' +
        (pinches ? '; ' + pinches + ' land cells touching the border by one point turned to sea' : '') +
        (islands ? '; ' + islands + ' small islands removed' : '');
    },

    // Marks the merged nodes.
    draw(g, state, ctx) {
      const px = (ctx && ctx.px) || 1;  // map units per screen px: constant widths on screen
      g.fillStyle = '#c0392b';
      for (const p of state.mergedPoints) {
        g.beginPath();
        g.arc(p.x, p.y, 3 * px, 0, Math.PI * 2);
        g.fill();
      }
    }
  };
})(window);
