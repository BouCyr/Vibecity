// Streets page, step 4 — arteries. The streets used by several of the step 3
// routes (centre to chosen exit) become arteries; an artery costs half its
// length to travel. Then, from the straightest exit to the least straight one,
// the cheapest route from the centre to the exit is traced again with those
// costs and becomes an artery too, so later routes tend to follow earlier ones.
(function (global) {
  'use strict';

  global.StreetsArteriesStep = {
    id: 'arteries',
    title: 'Arteries',
    settings: [
      { key: 'factor', label: 'Artery cost (× length)', type: 'number', min: 0.05, max: 1, step: 0.05, default: 0.5 }
    ],

    run(state, s, rng, ctx) {
      const X = state.crossroads, streets = state.streets, center = state.center;
      const factor = Math.min(1, Math.max(0.05, Number(s.factor) || 0.5));
      const index = new Map();  // "a,b" (a < b) -> street index
      streets.forEach((st, k) => index.set(Math.min(st.a, st.b) + ',' + Math.max(st.a, st.b), k));
      const streetsOf = (path) => path.slice(1).map((v, i) => index.get(Math.min(v, path[i]) + ',' + Math.max(v, path[i])));

      // Streets shared by at least two of the step 3 routes.
      const uses = new Map();
      for (const e of state.exits) for (const k of new Set(streetsOf(e.path))) uses.set(k, (uses.get(k) || 0) + 1);
      const artery = new Set();
      uses.forEach((n, k) => { if (n >= 2) artery.add(k); });
      const shared = artery.size;

      // Routes again, straightest exit first, each one becoming an artery.
      const order = state.exits.slice().sort((a, b) => b.straight - a.straight);
      const routes = [];
      for (const e of order) {
        const sp = global.streetsDijkstra(X, streets, center, (k, len) => (artery.has(k) ? len * factor : len));
        const path = global.streetsPathTo(sp.prev, center, e.id);
        for (const k of streetsOf(path)) artery.add(k);
        routes.push({ exit: e.id, path: path });
      }
      state.arteries = artery;
      state.arteryRoutes = routes;
      let len = 0;
      artery.forEach((k) => { len += Math.hypot(X[streets[k].a].x - X[streets[k].b].x, X[streets[k].a].y - X[streets[k].b].y); });
      return artery.size + ' artery streets (' + shared + ' shared by several routes), ' + Math.round(Units.toMetres(len)) + ' m';
    },

    draw(g, state, ctx) {
      const px = ctx.px || 1;
      const X = state.crossroads;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = '#a3241c';
      g.lineWidth = 7 * px;
      g.beginPath();
      state.arteries.forEach((k) => {
        const st = state.streets[k];
        g.moveTo(X[st.a].x, X[st.a].y);
        g.lineTo(X[st.b].x, X[st.b].y);
      });
      g.stroke();
    }
  };
})(window);
