// Step 2 — Voronoi diagram of the points, clipped to the map.
(function (global) {
  'use strict';

  /**
   * Clip a convex polygon by the half-plane of points closer to `s` than to `o`.
   * Each vertex carries `e`: the neighbor id of the edge starting at it (-1 = map border).
   */
  function clip(poly, s, o, oid) {
    const dx = o.x - s.x, dy = o.y - s.y;
    const mx = (s.x + o.x) / 2, my = (s.y + o.y) / 2;
    const n = poly.length;
    const f = new Array(n);
    let anyOut = false;
    for (let k = 0; k < n; k++) {
      f[k] = (poly[k].x - mx) * dx + (poly[k].y - my) * dy;
      if (f[k] > 0) anyOut = true;
    }
    if (!anyOut) return poly;

    const out = [];
    for (let k = 0; k < n; k++) {
      const a = poly[k], b = poly[(k + 1) % n];
      const fa = f[k], fb = f[(k + 1) % n];
      const ina = fa <= 0, inb = fb <= 0;
      if (ina) out.push(a);
      if (ina !== inb) {
        const t = fa / (fa - fb);
        out.push({
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          e: ina ? oid : a.e
        });
      }
    }
    return out;
  }

  /**
   * Voronoi cells of `sites` inside the rectangle `b`, by successive half-plane
   * clipping against nearby sites (found through a uniform grid).
   * Returns [{ site, poly: [{x, y}], neighbors: [ids], border }].
   */
  function computeVoronoi(sites, b) {
    const n = sites.length;
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    const cs = Math.max(1, Math.sqrt((w * h) / Math.max(1, n)));
    const gw = Math.ceil(w / cs), gh = Math.ceil(h / cs);
    const grid = Array.from({ length: gw * gh }, () => []);
    const gx = (x) => Math.min(gw - 1, Math.max(0, Math.floor((x - b.x0) / cs)));
    const gy = (y) => Math.min(gh - 1, Math.max(0, Math.floor((y - b.y0) / cs)));
    sites.forEach((p, i) => grid[gy(p.y) * gw + gx(p.x)].push(i));

    const cells = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = sites[i];
      let poly = [
        { x: b.x0, y: b.y0, e: -1 }, { x: b.x1, y: b.y0, e: -1 },
        { x: b.x1, y: b.y1, e: -1 }, { x: b.x0, y: b.y1, e: -1 }
      ];
      const cx = gx(s.x), cy = gy(s.y);
      const maxRing = Math.max(gw, gh);
      for (let r = 0; r <= maxRing && poly.length; r++) {
        for (let j = cy - r; j <= cy + r; j++) {
          if (j < 0 || j >= gh) continue;
          const edgeRow = j === cy - r || j === cy + r;
          for (let k = cx - r; k <= cx + r; k += edgeRow ? 1 : 2 * r) {
            if (k < 0 || k >= gw) continue;
            for (const o of grid[j * gw + k]) {
              if (o !== i) poly = clip(poly, s, sites[o], o);
            }
            if (r === 0) break;
          }
        }
        // Unvisited sites are at least r*cs away; they cannot cut the cell
        // once that exceeds twice the farthest vertex distance.
        let rmax = 0;
        for (const v of poly) rmax = Math.max(rmax, Math.hypot(v.x - s.x, v.y - s.y));
        if (r * cs >= 2 * rmax) break;
      }

      const nb = new Set();
      let border = false;
      for (const v of poly) {
        if (v.e < 0) border = true; else nb.add(v.e);
      }
      cells[i] = { site: s, poly: poly.map((v) => ({ x: v.x, y: v.y })), neighbors: nb, border: border };
    }

    // Make adjacency symmetric (guards against floating-point slivers).
    cells.forEach((c, i) => c.neighbors.forEach((j) => cells[j].neighbors.add(i)));
    cells.forEach((c) => { c.neighbors = Array.from(c.neighbors).sort((a, b2) => a - b2); });
    return cells;
  }

  /** Area-weighted centroid of a simple polygon. */
  function centroid(poly) {
    let a = 0, x = 0, y = 0;
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k], q = poly[(k + 1) % poly.length];
      const c = p.x * q.y - q.x * p.y;
      a += c; x += (p.x + q.x) * c; y += (p.y + q.y) * c;
    }
    if (Math.abs(a) < 1e-9) return { x: poly[0].x, y: poly[0].y };
    return { x: x / (3 * a), y: y / (3 * a) };
  }

  /**
   * Merge the cells' polygon vertices into shared nodes (the Voronoi vertices).
   * Sets cell.nodes = [node ids, same order as cell.poly] and returns
   * [{ x, y, cells: [cell ids] }].
   */
  function buildNodes(cells) {
    const nodes = [];
    const buckets = new Map();
    const Q = 100, EPS2 = 0.05 * 0.05;
    function find(x, y) {
      const qx = Math.round(x * Q), qy = Math.round(y * Q);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const list = buckets.get((qx + dx) + ',' + (qy + dy));
          if (!list) continue;
          for (const id of list) {
            const n = nodes[id];
            if ((n.x - x) * (n.x - x) + (n.y - y) * (n.y - y) < EPS2) return id;
          }
        }
      }
      const id = nodes.length;
      nodes.push({ x: x, y: y, cells: [] });
      const k = qx + ',' + qy;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(id);
      return id;
    }
    cells.forEach((c, ci) => {
      // Clipping can leave near-duplicate consecutive vertices; they merge here.
      const ids = [];
      for (const v of c.poly) {
        const id = find(v.x, v.y);
        if (ids[ids.length - 1] !== id) ids.push(id);
      }
      while (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop();
      c.nodes = ids;
      c.poly = ids.map((id) => ({ x: nodes[id].x, y: nodes[id].y }));
      for (const id of ids) nodes[id].cells.push(ci);
    });
    return nodes;
  }

  global.computeVoronoi = computeVoronoi;
  global.polygonCentroid = centroid;

  global.VoronoiStep = {
    id: 'voronoi',
    title: 'Voronoi diagram',
    settings: [
      { key: 'relax', label: 'Lloyd relaxation', type: 'range', min: 0, max: 10, step: 1, default: 2 }
    ],

    run(state, s, rng, ctx) {
      const map = { x0: 0, y0: 0, x1: ctx.width, y1: ctx.height };
      const b = state.bounds;
      let sites = state.points.map((p) => ({ x: p.x, y: p.y }));
      let cells = computeVoronoi(sites, map);
      // Lloyd relaxation: move each site to its cell centroid. On an axis where the
      // centroid falls in the margin, the site keeps its previous coordinate
      // (clamping instead would stack corner sites onto the same point).
      for (let it = 0; it < s.relax; it++) {
        sites = cells.map((c) => {
          const g = centroid(c.poly);
          return {
            x: g.x >= b.x0 && g.x <= b.x1 ? g.x : c.site.x,
            y: g.y >= b.y0 && g.y <= b.y1 ? g.y : c.site.y
          };
        });
        cells = computeVoronoi(sites, map);
      }
      state.cells = cells;
      state.nodes = buildNodes(cells);
      let edges = 0;
      for (const c of cells) edges += c.neighbors.length;
      return cells.length + ' cells, ' + state.nodes.length + ' nodes, ' + edges / 2 + ' shared edges';
    },

    draw(g, state, ctx) {
      const px = (ctx && ctx.px) || 1;  // map units per screen px: constant widths on screen
      g.strokeStyle = 'rgba(90, 64, 40, .55)';
      g.lineWidth = 0.75 * px;
      g.lineJoin = 'round';
      g.beginPath();
      for (const c of state.cells) {
        const p = c.poly;
        if (!p.length) continue;
        g.moveTo(p[0].x, p[0].y);
        for (let k = 1; k < p.length; k++) g.lineTo(p[k].x, p[k].y);
        g.closePath();
      }
      g.stroke();

      g.fillStyle = '#8c3b1f';
      for (const c of state.cells) {
        g.beginPath();
        g.arc(c.site.x, c.site.y, 2 * px, 0, Math.PI * 2);
        g.fill();
      }
    }
  };
})(window);
