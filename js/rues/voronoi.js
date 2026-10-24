// Streets page, step 1 — Voronoi diagram of random points over the 500 × 500 map,
// drawn with its dual Delaunay triangulation.
// Reuses the main generator's points and Voronoi steps (js/steps/points.js,
// js/steps/voronoi.js) as a single step.
(function (global) {
  'use strict';

  global.StreetsVoronoiStep = {
    id: 'voronoi',
    title: 'Voronoi diagram',
    settings: [
      { key: 'count', label: 'Number of points', type: 'range', min: 3, max: 5000, step: 1, default: 5 },
      {
        key: 'algo', label: 'Distribution', type: 'select', default: 'random',
        options: [
          { value: 'random', label: 'True random' },
          { value: 'poisson', label: 'Poisson disk' }
        ]
      },
      { key: 'relax', label: 'Lloyd relaxation', type: 'range', min: 0, max: 10, step: 1, default: 2 },
      { key: 'delaunay', label: 'Show Delaunay', type: 'select', default: 'yes', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
      { key: 'sites', label: 'Show sites', type: 'select', default: 'yes', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] }
    ],

    run(state, s, rng, ctx) {
      global.PointsStep.run(state, { count: s.count, margin: 0, algo: s.algo }, rng, ctx);
      return global.VoronoiStep.run(state, { relax: s.relax }, rng, ctx);
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
      // Delaunay triangulation: a link between the sites of every two neighbouring cells.
      if (ctx.settings.delaunay !== 'no') {
        g.strokeStyle = 'rgba(40, 90, 200, .75)';
        g.lineWidth = px;
        g.beginPath();
        state.cells.forEach((c, i) => {
          for (const j of c.neighbors) {
            if (j < i) continue;
            const o = state.cells[j].site;
            g.moveTo(c.site.x, c.site.y);
            g.lineTo(o.x, o.y);
          }
        });
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
