// Step 4 — sea. Altitude is lowered near the chosen sea fronts (map edges), then
// the lowest cells become sea. A clean-up pass is left to the next step.
(function (global) {
  'use strict';

  const smoothstep = (t) => t * t * (3 - 2 * t);

  /**
   * Normalized distance to the nearest sea front (0 on the edge, 1 at `reach`),
   * combined with a soft minimum: (sum d_i^-p)^(-1/p). A hard minimum would give
   * a sharp diagonal crease where two fronts meet; the soft one rounds the corner.
   */
  function seaDistance(x, y, fronts, w, h, reach, p) {
    let sum = 0;
    for (const f of fronts) {
      const d = (f === 'N' ? y : f === 'S' ? h - y : f === 'W' ? x : w - x) / reach;
      if (d <= 1e-6) return 0;
      sum += Math.pow(d, -p);
    }
    return sum > 0 ? Math.pow(sum, -1 / p) : Infinity;
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
        key: 'fronts', label: 'Sea fronts', type: 'toggles', default: ['S'],
        options: [
          { value: 'N', label: 'N', title: 'North' },
          { value: 'E', label: 'E', title: 'East' },
          { value: 'S', label: 'S', title: 'South' },
          { value: 'W', label: 'W', title: 'West' }
        ]
      },
      { key: 'percent', label: 'Sea cells (%)', type: 'range', min: 0, max: 90, step: 1, default: 25 },
      { key: 'reach', label: 'Coast reach (% of map)', type: 'range', min: 5, max: 100, step: 1, default: 40 },
      { key: 'strength', label: 'Altitude lowering', type: 'range', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'rounding', label: 'Corner rounding', type: 'range', min: 1, max: 8, step: 0.5, default: 2 }
    ],

    run(state, s, rng, ctx) {
      const fronts = s.fronts || [];
      const reach = Math.max(1, (s.reach / 100) * Math.min(ctx.width, ctx.height));
      // Exponent of the soft minimum: 1 = very round corners, 8 = nearly square.
      const p = 8 / s.rounding;

      // Lower the altitude of every cell center and node according to its sea distance.
      const lowering = (x, y) => {
        const d = seaDistance(x, y, fronts, ctx.width, ctx.height, reach, p);
        return d >= 1 ? 0 : s.strength * (1 - smoothstep(d));
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
    }
  };
})(window);
