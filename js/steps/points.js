// Step 1 — scatter random points over the map.
(function (global) {
  'use strict';

  /** Uniform random points inside [x0, x1] x [y0, y1]. */
  function uniformPoints(rng, n, x0, y0, x1, y1) {
    const pts = new Array(n);
    for (let i = 0; i < n; i++) pts[i] = { x: rng.range(x0, x1), y: rng.range(y0, y1) };
    return pts;
  }

  /** Bridson's Poisson-disk sampling with minimum distance r. */
  function bridson(rng, r, x0, y0, x1, y1, k) {
    const w = x1 - x0, h = y1 - y0;
    const cell = r / Math.SQRT2;
    const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
    const grid = new Int32Array(gw * gh).fill(-1);
    const pts = [];
    const active = [];
    const r2 = r * r;

    function add(x, y) {
      const i = pts.length;
      pts.push({ x: x, y: y });
      active.push(i);
      grid[Math.floor((y - y0) / cell) * gw + Math.floor((x - x0) / cell)] = i;
    }

    function fits(x, y) {
      if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
      const gx = Math.floor((x - x0) / cell), gy = Math.floor((y - y0) / cell);
      const ax = Math.max(0, gx - 2), bx = Math.min(gw - 1, gx + 2);
      const ay = Math.max(0, gy - 2), by = Math.min(gh - 1, gy + 2);
      for (let j = ay; j <= by; j++) {
        for (let i = ax; i <= bx; i++) {
          const p = grid[j * gw + i];
          if (p < 0) continue;
          const dx = pts[p].x - x, dy = pts[p].y - y;
          if (dx * dx + dy * dy < r2) return false;
        }
      }
      return true;
    }

    add(rng.range(x0, x1), rng.range(y0, y1));
    while (active.length) {
      const ai = Math.floor(rng.random() * active.length);
      const p = pts[active[ai]];
      let found = false;
      for (let t = 0; t < k; t++) {
        const a = rng.random() * Math.PI * 2;
        const d = r * (1 + rng.random());
        const x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d;
        if (fits(x, y)) { add(x, y); found = true; break; }
      }
      if (!found) {
        active[ai] = active[active.length - 1];
        active.pop();
      }
    }
    return pts;
  }

  /**
   * Poisson-disk points with a target count: binary-search the radius so the
   * sampling yields at least n points, then drop random extras.
   * Each trial reuses the same sub-seed, so the result stays deterministic.
   */
  function poissonPoints(rng, n, x0, y0, x1, y1) {
    if (n <= 0) return [];
    const trialSeed = rng.random();
    const area = (x1 - x0) * (y1 - y0);
    const guess = Math.sqrt(area / n);
    let lo = guess * 0.3, hi = guess * 1.5;
    let best = null;
    for (let it = 0; it < 16; it++) {
      const r = (lo + hi) / 2;
      const pts = bridson(new Rng(trialSeed + ':' + it), r, x0, y0, x1, y1, 30);
      if (pts.length >= n) { best = pts; lo = r; } else { hi = r; }
      if (best && best.length - n < n * 0.01) break;
    }
    if (!best) best = bridson(new Rng(trialSeed + ':fallback'), lo, x0, y0, x1, y1, 30);
    rng.shuffle(best);
    best.length = Math.min(best.length, n);
    return best;
  }

  global.PointsStep = {
    id: 'points',
    title: 'Random points',
    defaultVisible: false,
    settings: [
      { key: 'count', label: 'Number of points', type: 'range', min: 10, max: 10000, step: 10, default: 2000 },
      { key: 'margin', label: 'Margin', type: 'range', min: 0, max: 500, step: 5, default: 100 },
      {
        key: 'algo', label: 'Distribution', type: 'select', default: 'poisson',
        options: [
          { value: 'random', label: 'True random' },
          { value: 'poisson', label: 'Poisson disk' }
        ]
      }
    ],

    run(state, s, rng, ctx) {
      const m = Math.min(s.margin, ctx.width / 2 - 1, ctx.height / 2 - 1);
      const x0 = m, y0 = m, x1 = ctx.width - m, y1 = ctx.height - m;
      const points = s.algo === 'poisson'
        ? poissonPoints(rng, s.count, x0, y0, x1, y1)
        : uniformPoints(rng, s.count, x0, y0, x1, y1);
      state.points = points;
      state.bounds = { x0: x0, y0: y0, x1: x1, y1: y1 };
      return points.length + ' points';
    },

    draw(g, state) {
      const b = state.bounds;
      g.save();
      g.setLineDash([12, 10]);
      g.strokeStyle = 'rgba(140, 59, 31, .5)';
      g.lineWidth = 2;
      g.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      g.restore();

      g.fillStyle = '#3a2e22';
      for (const p of state.points) {
        g.beginPath();
        g.arc(p.x, p.y, 4, 0, Math.PI * 2);
        g.fill();
      }
    }
  };
})(window);
