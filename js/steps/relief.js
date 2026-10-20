// Step 10 — altitude curve. Every altitude computed so far (cells, nodes,
// per-point polygon altitudes, water cells) is normalized to [0, 1], mapped
// through a user-drawn, strictly increasing curve from (0, 0) to (1, 1), then
// multiplied by the maximum altitude: altitudes are in metres from here on.
(function (global) {
  'use strict';

  /**
   * Monotone cubic interpolation (Fritsch–Carlson) through (0, 0), the
   * intermediate points [[x, y], …] (increasing in x and y) and (1, 1).
   * Returns f(t) for t in [0, 1]; strictly increasing when the points are.
   */
  function curveFunction(points) {
    const P = [[0, 0]].concat(points || [], [[1, 1]]);
    const n = P.length;
    const d = [], m = new Array(n).fill(0);
    for (let i = 0; i + 1 < n; i++) d.push((P[i + 1][1] - P[i][1]) / (P[i + 1][0] - P[i][0]));
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i + 1 < n; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i + 1 < n; i++) {
      if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
      if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    return (t) => {
      t = Math.max(0, Math.min(1, t));
      let i = 0;
      while (i + 2 < n && t > P[i + 1][0]) i++;
      const h = P[i + 1][0] - P[i][0], s = (t - P[i][0]) / h;
      const s2 = s * s, s3 = s2 * s;
      return (2 * s3 - 3 * s2 + 1) * P[i][1] + (s3 - 2 * s2 + s) * h * m[i] +
        (-2 * s3 + 3 * s2) * P[i + 1][1] + (s3 - s2) * h * m[i + 1];
    };
  }

  /** True if `points` is a list of [x, y] pairs strictly increasing in x and y, inside (0, 1). */
  function validCurve(points) {
    if (!Array.isArray(points)) return false;
    const P = [[0, 0]].concat(points, [[1, 1]]);
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      if (!Array.isArray(p) || p.length !== 2 || !isFinite(p[0]) || !isFinite(p[1])) return false;
      if (i && !(p[0] > P[i - 1][0] && p[1] > P[i - 1][1])) return false;
    }
    return true;
  }

  global.curveFunction = curveFunction;
  global.validCurve = validCurve;

  global.ReliefStep = {
    id: 'relief',
    title: 'Altitude curve',
    // Nothing of its own to draw: the Altitude layer shows the result.
    defaultVisible: false,
    settings: [
      { key: 'curve', label: 'Altitude curve', type: 'curve', default: [[0.167, 0.167], [0.333, 0.333], [0.5, 0.5], [0.667, 0.667], [0.833, 0.833]] },
      { key: 'maxAltitude', label: 'Maximum altitude (m)', type: 'range', min: 10, max: 3000, step: 10, default: 300 }
    ],

    run(state, s) {
      const f = curveFunction(validCurve(s.curve) ? s.curve : []);
      let min = Infinity, max = -Infinity;
      const scan = (a) => { if (a < min) min = a; if (a > max) max = a; };
      for (const c of state.cells) {
        scan(c.altitude);
        if (c.polyAlt) c.polyAlt.forEach(scan);
      }
      for (const n of state.nodes) scan(n.altitude);
      const span = max - min || 1;
      const map = (a) => f((a - min) / span) * s.maxAltitude;
      for (const c of state.cells) {
        c.altitude = map(c.altitude);
        if (c.polyAlt) c.polyAlt = c.polyAlt.map(map);
      }
      for (const n of state.nodes) n.altitude = map(n.altitude);
      state.altitudeMax = s.maxAltitude;

      let sum = 0, count = 0, top = 0;
      for (const c of state.cells) {
        if (c.sea || c.river !== undefined) continue;
        sum += c.altitude; count++;
        top = Math.max(top, c.altitude);
      }
      return 'Altitudes in metres: highest ' + Math.round(top) + ' m, mean land ' + Math.round(sum / Math.max(1, count)) + ' m';
    },

    draw() {}
  };
})(window);
