// Streets page, step 1 — Voronoi diagram of random points over the 500 × 500 map,
// drawn with its dual Delaunay links, kept only where a link crosses the shared
// Voronoi edge between its two ends.
// Reuses the main generator's points and Voronoi steps (js/steps/points.js,
// js/steps/voronoi.js) as a single step.
(function (global) {
  'use strict';

  /** Whether segments ab and cd cross or touch (a small tolerance keeps touching ends). */
  function segmentsMeet(a, b, c, d) {
    const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const e = 1e-9 * (1 + Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(d.x - c.x, d.y - c.y));
    const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
    return d1 * d2 <= e && d3 * d4 <= e;
  }

  /**
   * Delaunay links kept as streets: [[i, j]] for neighbouring cells i < j whose
   * site-to-site segment crosses their shared Voronoi edge between its two ends.
   * Returns { links, dropped }.
   */
  function crossingLinks(cells, nodes) {
    const links = [];
    let dropped = 0;
    cells.forEach((c, i) => {
      for (const j of c.neighbors) {
        if (j < i) continue;
        const shared = c.nodes.filter((n) => cells[j].nodes.indexOf(n) >= 0);
        if (shared.length >= 2 && segmentsMeet(c.site, cells[j].site, nodes[shared[0]], nodes[shared[1]])) links.push([i, j]);
        else dropped++;
      }
    });
    return { links: links, dropped: dropped };
  }

  global.StreetsVoronoiStep = {
    id: 'voronoi',
    title: 'Voronoi diagram',
    settings: [
      { key: 'count', label: 'Number of points', type: 'number', min: 3, max: 200, step: 1, default: 30 },
      {
        key: 'algo', label: 'Distribution', type: 'select', default: 'random',
        options: [
          { value: 'random', label: 'True random' },
          { value: 'poisson', label: 'Poisson disk' }
        ]
      },
      { key: 'relax', label: 'Lloyd relaxation', type: 'number', min: 0, max: 10, step: 1, default: 2 },
      { key: 'delaunay', label: 'Show Delaunay', type: 'select', default: 'yes', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
      { key: 'sites', label: 'Show sites', type: 'select', default: 'yes', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] }
    ],

    run(state, s, rng, ctx) {
      // Typed values are not bounded by the input: keep them in range here.
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v) || lo));
      global.PointsStep.run(state, { count: clamp(s.count, 3, 200), margin: 0, algo: s.algo }, rng, ctx);
      const info = global.VoronoiStep.run(state, { relax: clamp(s.relax, 0, 10) }, rng, ctx);
      const d = crossingLinks(state.cells, state.nodes);
      state.delaunay = d.links;
      return info + ', ' + d.links.length + ' Delaunay links (' + d.dropped + ' dropped: not crossing their Voronoi edge)';
    },

    draw(g, state, ctx) {
      const px = ctx.px || 1;
      g.strokeStyle = 'rgba(90, 64, 40, .7)';
      g.lineWidth = px;
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
      // Delaunay links between neighbouring sites, those crossing their Voronoi edge.
      if (ctx.settings.delaunay !== 'no') {
        g.strokeStyle = 'rgba(40, 90, 200, .75)';
        g.lineWidth = px;
        g.beginPath();
        for (const [i, j] of state.delaunay) {
          g.moveTo(state.cells[i].site.x, state.cells[i].site.y);
          g.lineTo(state.cells[j].site.x, state.cells[j].site.y);
        }
        g.stroke();
      }
      if (ctx.settings.sites === 'no') return;
      g.fillStyle = '#8c3b1f';
      for (const c of state.cells) {
        g.beginPath();
        g.arc(c.site.x, c.site.y, 2 * px, 0, Math.PI * 2);
        g.fill();
      }
    }
  };
})(window);
