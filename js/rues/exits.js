// Streets page, step 3 — choose the exits of the city among the ends of the
// mauve streets. Each exit is scored by how straight its shortest path from the
// city centre is (straight-line distance / path length, 1 = perfectly straight);
// the chosen set balances that straightness against the spread of the exits
// (smallest distance between two chosen exits).
(function (global) {
  'use strict';

  /** Shortest paths from `src` over the streets: { dist, prev } per crossroads. */
  function dijkstra(X, streets, src) {
    const n = X.length;
    const adj = Array.from({ length: n }, () => []);
    for (const st of streets) {
      const w = Math.hypot(X[st.a].x - X[st.b].x, X[st.a].y - X[st.b].y);
      adj[st.a].push([st.b, w]);
      adj[st.b].push([st.a, w]);
    }
    const dist = new Array(n).fill(Infinity), prev = new Array(n).fill(-1), done = new Array(n).fill(false);
    dist[src] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0) break;
      done[u] = true;
      for (const [v, w] of adj[u]) if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
    }
    return { dist: dist, prev: prev };
  }

  global.StreetsExitsStep = {
    id: 'exits',
    title: 'City exits',
    settings: [
      { key: 'count', label: 'Number of exits', type: 'number', min: 2, max: 10, step: 1, default: 4 },
      { key: 'spread', label: 'Spread weight (0: straightest paths, 1: farthest apart)', type: 'number', min: 0, max: 1, step: 0.05, default: 0.5 }
    ],

    run(state, s, rng, ctx) {
      const X = state.crossroads, center = state.center;
      const k = Math.min(10, Math.max(2, Math.round(s.count) || 2));
      const w = Math.min(1, Math.max(0, Number(s.spread) || 0));
      const sp = dijkstra(X, state.streets, center);
      const c = X[center];
      const cand = [];
      X.forEach((p, i) => {
        if (!p.exit || sp.dist[i] === Infinity) return;
        const path = [i];
        while (path[path.length - 1] !== center) path.push(sp.prev[path[path.length - 1]]);
        cand.push({ id: i, straight: Math.hypot(p.x - c.x, p.y - c.y) / sp.dist[i], path: path.reverse() });
      });

      // Score of a set: (1 - w) × mean straightness + w × smallest gap between
      // two exits, relative to the ideal gap of k exits evenly spread around the
      // map (a regular k-gon inscribed in the map's inscribed circle).
      const R = Math.min(ctx.width, ctx.height) / 2;
      const ideal = 2 * R * Math.sin(Math.PI / k);
      const d = (a, b) => Math.hypot(X[a.id].x - X[b.id].x, X[a.id].y - X[b.id].y);
      function score(set) {
        let st = 0, gap = Infinity;
        for (let i = 0; i < set.length; i++) {
          st += set[i].straight;
          for (let j = i + 1; j < set.length; j++) gap = Math.min(gap, d(set[i], set[j]));
        }
        return (1 - w) * st / set.length + w * (set.length > 1 ? Math.min(1, gap / ideal) : 1);
      }

      // Greedy start from the straightest exit, then swaps while they improve the score.
      let chosen = [];
      if (cand.length <= k) {
        chosen = cand.slice();
      } else {
        const rest = cand.slice().sort((a, b) => b.straight - a.straight);
        chosen.push(rest.shift());
        while (chosen.length < k) {
          let bi = 0, bs = -Infinity;
          rest.forEach((e, i) => { const v = score(chosen.concat([e])); if (v > bs) { bs = v; bi = i; } });
          chosen.push(rest.splice(bi, 1)[0]);
        }
        let cur = score(chosen), improved = true;
        while (improved) {
          improved = false;
          for (let i = 0; i < chosen.length && !improved; i++) {
            for (let j = 0; j < rest.length && !improved; j++) {
              const trial = chosen.slice();
              trial[i] = rest[j];
              const v = score(trial);
              if (v > cur + 1e-9) {
                [chosen[i], rest[j]] = [rest[j], chosen[i]];
                cur = v;
                improved = true;
              }
            }
          }
        }
      }
      state.exits = chosen;
      let gap = Infinity;
      for (let i = 0; i < chosen.length; i++) for (let j = i + 1; j < chosen.length; j++) gap = Math.min(gap, d(chosen[i], chosen[j]));
      const mean = chosen.reduce((a, e) => a + e.straight, 0) / Math.max(1, chosen.length);
      return chosen.length + ' of ' + cand.length + ' exits, mean straightness ' + mean.toFixed(2) +
        (chosen.length > 1 ? ', smallest gap ' + Math.round(Units.toMetres(gap)) + ' m' : '') +
        (cand.length < k ? ' (not enough exits)' : '');
    },

    draw(g, state, ctx) {
      const px = ctx.px || 1;
      const X = state.crossroads;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(214, 120, 20, .85)';
      g.lineWidth = 6 * px;
      g.beginPath();
      for (const e of state.exits) {
        e.path.forEach((id, i) => (i ? g.lineTo(X[id].x, X[id].y) : g.moveTo(X[id].x, X[id].y)));
      }
      g.stroke();
      g.font = 'bold ' + 11 * px + 'px Georgia, serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (const e of state.exits) {
        const p = X[e.id];
        g.fillStyle = '#d67814';
        g.strokeStyle = '#1f2a44';
        g.lineWidth = 2 * px;
        g.beginPath();
        g.arc(p.x, p.y, 7 * px, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        // Straightness next to the exit, on the side of the map centre.
        const dx = ctx.width / 2 - p.x, dy = ctx.height / 2 - p.y, l = Math.hypot(dx, dy) || 1;
        g.fillStyle = '#1f2a44';
        g.fillText(e.straight.toFixed(2), p.x + dx / l * 20 * px, p.y + dy / l * 20 * px);
      }
    }
  };
})(window);
