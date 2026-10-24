// Streets page, step 2 — the streets graph: the Voronoi sites are crossroads and
// the Delaunay links of step 1 (those crossing their Voronoi edge) are streets.
// A cell with exactly one edge on the map border also gets a street from its
// site to the middle of that edge, where it leaves the map. The crossroads nearest the middle of the
// map is the city centre.
(function (global) {
  'use strict';

  const EPS = 1e-6;

  /** Side of the map an edge lies on ('left', 'right', 'top', 'bottom'), or null. */
  function borderSide(a, b, w, h) {
    if (Math.abs(a.x) < EPS && Math.abs(b.x) < EPS) return 'left';
    if (Math.abs(a.x - w) < EPS && Math.abs(b.x - w) < EPS) return 'right';
    if (Math.abs(a.y) < EPS && Math.abs(b.y) < EPS) return 'top';
    if (Math.abs(a.y - h) < EPS && Math.abs(b.y - h) < EPS) return 'bottom';
    return null;
  }

  global.StreetsGraphStep = {
    id: 'streets',
    title: 'Streets',
    settings: [],

    run(state, s, rng, ctx) {
      const cells = state.cells;
      // Crossroads 0..n-1 are the cell sites; exits on the map border follow.
      const crossroads = cells.map((c, i) => ({ x: c.site.x, y: c.site.y, cell: i, exit: false }));
      const streets = [];
      for (const [i, j] of state.delaunay) streets.push({ a: i, b: j, kind: 'delaunay' });
      let exits = 0;
      cells.forEach((c, i) => {
        const p = c.poly, border = [];
        for (let k = 0; k < p.length; k++) {
          const a = p[k], b = p[(k + 1) % p.length];
          if (borderSide(a, b, ctx.width, ctx.height)) border.push([a, b]);
        }
        if (border.length !== 1) return;
        const [a, b] = border[0];
        crossroads.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, cell: i, exit: true });
        streets.push({ a: i, b: crossroads.length - 1, kind: 'border' });
        exits++;
      });
      // City centre: the site nearest the geometric centre of the map.
      let center = 0, best = Infinity;
      cells.forEach((c, i) => {
        const d = Math.hypot(c.site.x - ctx.width / 2, c.site.y - ctx.height / 2);
        if (d < best) { best = d; center = i; }
      });
      state.crossroads = crossroads;
      state.streets = streets;
      state.center = center;
      return cells.length + ' crossroads, ' + streets.length + ' streets (' + exits + ' leaving the map), city centre: crossroads ' + center;
    },

    draw(g, state, ctx) {
      const px = ctx.px || 1;
      const X = state.crossroads;
      g.lineCap = 'round';
      g.lineWidth = 2.5 * px;
      for (const kind of ['delaunay', 'border']) {
        g.strokeStyle = kind === 'delaunay' ? '#2f62c8' : '#9b4fc2';
        g.beginPath();
        for (const st of state.streets) {
          if (st.kind !== kind) continue;
          g.moveTo(X[st.a].x, X[st.a].y);
          g.lineTo(X[st.b].x, X[st.b].y);
        }
        g.stroke();
      }
      for (const c of X) {
        g.fillStyle = c.exit ? '#9b4fc2' : '#1f2a44';
        g.beginPath();
        g.arc(c.x, c.y, (c.exit ? 3 : 4) * px, 0, Math.PI * 2);
        g.fill();
      }
      // City centre: a red disc ringed in dark.
      const c = X[state.center];
      g.fillStyle = '#c8342b';
      g.strokeStyle = '#1f2a44';
      g.lineWidth = 2 * px;
      g.beginPath();
      g.arc(c.x, c.y, 8 * px, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
  };
})(window);
