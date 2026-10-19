// Step 4 — sea. Altitude is lowered near a reference coast curve built from the
// chosen sea fronts, then the lowest cells become sea. A clean-up pass follows.
(function (global) {
  'use strict';

  const smoothstep = (t) => t * t * (3 - 2 * t);
  const SIDES = ['N', 'E', 'S', 'W'];
  const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };
  const CURVE_SEGMENTS = 256;

  /**
   * Reference coast for the selected fronts, as guides: each guide has a
   * `line` (polyline of the coast curve) and `land` (closed polygon of the land
   * side, or null when the whole map is on the land side).
   *  - one front, or two opposite fronts: the front edges themselves;
   *  - two adjacent fronts: a parabola from the far end of one front to the far
   *    end of the other, bending toward (but avoiding) their shared corner;
   *  - three fronts: a parabola from the two corners of the land edge, with its
   *    vertex at the middle of the opposite edge;
   *  - four fronts: a circle centered on the map, touching the edge middles.
   */
  function coastGuides(fronts, w, h) {
    const P = {
      NW: { x: 0, y: 0 }, NE: { x: w, y: 0 }, SE: { x: w, y: h }, SW: { x: 0, y: h }
    };
    const corner = (a, b) => P[(a === 'N' || a === 'S') ? a + b : b + a];
    const mid = { N: { x: w / 2, y: 0 }, S: { x: w / 2, y: h }, W: { x: 0, y: h / 2 }, E: { x: w, y: h / 2 } };
    const sorted = SIDES.filter((f) => fronts.indexOf(f) >= 0);

    function bezier(p0, c, p2) {
      const pts = [];
      for (let i = 0; i <= CURVE_SEGMENTS; i++) {
        const t = i / CURVE_SEGMENTS, u = 1 - t;
        pts.push({ x: u * u * p0.x + 2 * u * t * c.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p2.y });
      }
      return pts;
    }
    const edge = (f) => {
      const ends = f === 'N' ? [P.NW, P.NE] : f === 'S' ? [P.SW, P.SE] : f === 'W' ? [P.NW, P.SW] : [P.NE, P.SE];
      return { line: ends, land: null };
    };

    if (sorted.length === 4) {
      const pts = [];
      const r = Math.min(w, h) / 2;
      for (let i = 0; i <= CURVE_SEGMENTS; i++) {
        const a = (i / CURVE_SEGMENTS) * Math.PI * 2;
        pts.push({ x: w / 2 + r * Math.cos(a), y: h / 2 + r * Math.sin(a) });
      }
      return [{ line: pts, land: pts }];
    }
    if (sorted.length === 3) {
      const m = SIDES.find((f) => sorted.indexOf(f) < 0);
      const central = OPPOSITE[m];
      const others = sorted.filter((f) => f !== central);
      const p0 = corner(m, others[0]), p2 = corner(m, others[1]);
      // Control point mirrored so that the vertex (t = 0.5) is the middle of the central edge.
      const c = { x: 2 * mid[central].x - mid[m].x, y: 2 * mid[central].y - mid[m].y };
      const pts = bezier(p0, c, p2);
      return [{ line: pts, land: pts }];
    }
    if (sorted.length === 2 && OPPOSITE[sorted[0]] !== sorted[1]) {
      const [a, b] = sorted;
      const shared = corner(a, b);
      const p0 = corner(a, OPPOSITE[b]), p2 = corner(b, OPPOSITE[a]);
      const pts = bezier(p0, shared, p2);
      const far = corner(OPPOSITE[a], OPPOSITE[b]);
      return [{ line: pts, land: pts.concat([far]) }];
    }
    return sorted.map(edge);
  }

  function distToPolyline(x, y, pts) {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = a.x + t * dx - x, ey = a.y + t * dy - y;
      const d = ex * ex + ey * ey;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  function insidePolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  /** Signed distance to the reference coast: positive on land, negative at sea. */
  function coastDistance(x, y, guides, w, h) {
    // Points on the map border (Voronoi nodes) lie on the land polygon's own
    // border, where the inside test is unreliable: test a point nudged inward.
    const tx = Math.min(w - 1, Math.max(1, x)), ty = Math.min(h - 1, Math.max(1, y));
    let best = Infinity;
    for (const g of guides) {
      let d = distToPolyline(x, y, g.line);
      if (g.land && !insidePolygon(tx, ty, g.land)) d = -d;
      if (d < best) best = d;
    }
    return best;
  }

  /** Map key for the edge between two nodes, independent of direction. */
  const edgeKey = (a, b) => (a < b ? a + ',' + b : b + ',' + a);

  /**
   * Recompute what depends on the cells' sea flags: node flags (sea if all its
   * cells are sea, coast if it touches both) and the coastline (edges between a
   * sea cell and a land cell, as node id pairs).
   */
  function updateSeaFlags(state) {
    for (const n of state.nodes) {
      let sea = 0;
      for (const ci of n.cells) if (state.cells[ci].sea) sea++;
      n.sea = sea === n.cells.length;
      n.coast = sea > 0 && sea < n.cells.length;
    }

    const owner = new Map();
    const coast = [];
    state.cells.forEach((c, ci) => {
      const ns = c.nodes;
      for (let k = 0; k < ns.length; k++) {
        const a = ns[k], b = ns[(k + 1) % ns.length];
        const key = edgeKey(a, b);
        const other = owner.get(key);
        if (other === undefined) owner.set(key, ci);
        else if (state.cells[other].sea !== c.sea) coast.push([a, b]);
      }
    });
    state.coastline = coast;
  }

  global.updateSeaFlags = updateSeaFlags;

  global.SeaStep = {
    id: 'sea',
    title: 'Sea',
    // Drawn above the altitude, under the Voronoi edges.
    zIndex: -0.5,
    settings: [
      {
        key: 'fronts', label: 'Sea fronts', type: 'toggles', default: ['E', 'S'],
        options: [
          { value: 'N', label: 'N', title: 'North' },
          { value: 'E', label: 'E', title: 'East' },
          { value: 'S', label: 'S', title: 'South' },
          { value: 'W', label: 'W', title: 'West' }
        ]
      },
      { key: 'percent', label: 'Sea cells (%)', type: 'range', min: 0, max: 90, step: 1, default: 25 },
      { key: 'reach', label: 'Coast reach (% of map)', type: 'range', min: 5, max: 100, step: 1, default: 40 },
      { key: 'strength', label: 'Altitude lowering', type: 'range', min: 0, max: 2, step: 0.05, default: 1 }
    ],

    run(state, s, rng, ctx) {
      const fronts = s.fronts || [];
      const reach = Math.max(1, (s.reach / 100) * Math.min(ctx.width, ctx.height));
      const guides = coastGuides(fronts, ctx.width, ctx.height);
      state.coastGuides = guides;

      // Lower the altitude according to the signed distance to the reference coast:
      // fading out over `reach` on the land side, full (and more) on the sea side.
      const lowering = (x, y) => {
        const d = coastDistance(x, y, guides, ctx.width, ctx.height) / reach;
        if (d >= 1) return 0;
        if (d <= 0) return s.strength * (1 + Math.min(1, -d));
        return s.strength * (1 - smoothstep(d));
      };
      if (fronts.length) {
        for (const c of state.cells) c.altitude -= lowering(c.site.x, c.site.y);
        for (const n of state.nodes) n.altitude -= lowering(n.x, n.y);
        // Back to [0, 1]. Rescaling instead of clamping keeps the order of the
        // lowered points (clamping would tie them all at 0).
        let min = Infinity, max = -Infinity;
        for (const pt of state.cells.concat(state.nodes)) {
          if (pt.altitude < min) min = pt.altitude;
          if (pt.altitude > max) max = pt.altitude;
        }
        const span = max - min || 1;
        for (const pt of state.cells.concat(state.nodes)) pt.altitude = (pt.altitude - min) / span;
      }

      // The lowest `percent` of cells become sea.
      const order = state.cells.map((c, i) => i).sort((a, b) => state.cells[a].altitude - state.cells[b].altitude || a - b);
      const nSea = Math.round((s.percent / 100) * order.length);
      state.cells.forEach((c) => { c.sea = false; });
      for (let k = 0; k < nSea; k++) state.cells[order[k]].sea = true;
      state.seaLevel = nSea > 0 ? state.cells[order[nSea - 1]].altitude : -Infinity;

      state.seaFronts = fronts.slice();
      updateSeaFlags(state);

      return nSea + ' sea cells, sea level ' + (nSea ? state.seaLevel.toFixed(2) : '—') + ', ' + state.coastline.length + ' coast edges';
    },

    draw(g, state) {
      g.fillStyle = '#5f86a8';
      g.strokeStyle = g.fillStyle;
      g.lineWidth = 1;
      for (const c of state.cells) {
        if (!c.sea || !c.poly.length) continue;
        g.beginPath();
        g.moveTo(c.poly[0].x, c.poly[0].y);
        for (let k = 1; k < c.poly.length; k++) g.lineTo(c.poly[k].x, c.poly[k].y);
        g.closePath();
        g.fill();
        g.stroke();
      }

      g.strokeStyle = '#2f3f52';
      g.lineWidth = 3;
      g.lineCap = 'round';
      g.beginPath();
      for (const [a, b] of state.coastline) {
        g.moveTo(state.nodes[a].x, state.nodes[a].y);
        g.lineTo(state.nodes[b].x, state.nodes[b].y);
      }
      g.stroke();

      // Reference coast curve.
      g.save();
      g.strokeStyle = 'rgba(29, 62, 122, .7)';
      g.lineWidth = 5;
      g.setLineDash([16, 12]);
      for (const guide of state.coastGuides) {
        g.beginPath();
        guide.line.forEach((pt, i) => (i ? g.lineTo(pt.x, pt.y) : g.moveTo(pt.x, pt.y)));
        g.stroke();
      }
      g.restore();
    }
  };
})(window);
