// Step 3 — altitude in [0, 1] for every cell center and Voronoi node, from three
// layers of simplex noise: broad hills/mountains, medium relief, local bumps.
(function (global) {
  'use strict';

  const LAYERS = [
    { key: 'large', label: 'Hills', size: [300, 3000, 1000], weight: 1 },
    { key: 'medium', label: 'Relief', size: [80, 800, 300], weight: 0.35 },
    { key: 'small', label: 'Local bumps', size: [10, 200, 60], weight: 0.1 }
  ];

  // Color ramp from low (meadow) to high (bare rock), as [altitude, r, g, b].
  const RAMP = [
    [0.0, 164, 189, 130],
    [0.35, 206, 210, 150],
    [0.6, 222, 202, 150],
    [0.8, 176, 145, 105],
    [1.0, 120, 96, 78]
  ];

  /** Ramp colour of altitude a in [0, 1] as [r, g, b] (0–255). */
  function rampRGB(a) {
    let k = 1;
    while (k < RAMP.length - 1 && a > RAMP[k][0]) k++;
    const lo = RAMP[k - 1], hi = RAMP[k];
    const t = Math.max(0, Math.min(1, (a - lo[0]) / (hi[0] - lo[0])));
    return [1, 2, 3].map((i) => Math.round(lo[i] + (hi[i] - lo[i]) * t));
  }
  global.altitudeRampRGB = rampRGB;

  function rampColor(a) {
    return 'rgb(' + rampRGB(a).join(',') + ')';
  }

  const settings = [];
  for (const l of LAYERS) {
    settings.push({ key: l.key + 'Size', label: l.label + ' — size', type: 'range', min: l.size[0], max: l.size[1], step: 5, default: l.size[2] });
    settings.push({ key: l.key + 'Weight', label: l.label + ' — weight', type: 'range', min: 0, max: 1, step: 0.05, default: l.weight });
  }

  global.AltitudeStep = {
    id: 'altitude',
    title: 'Altitude',
    // Drawn under the Voronoi edges.
    zIndex: -1,
    settings: settings,

    run(state, s, rng) {
      // One independent noise field (and random offset) per layer.
      const layers = LAYERS.map((l) => ({
        noise: createSimplex2D(rng),
        ox: rng.range(-1000, 1000),
        oy: rng.range(-1000, 1000),
        size: s[l.key + 'Size'],
        weight: s[l.key + 'Weight']
      }));
      const raw = (x, y) => {
        let v = 0;
        for (const l of layers) {
          if (l.weight > 0) v += l.weight * l.noise(x / l.size + l.ox, y / l.size + l.oy);
        }
        return v;
      };

      const cellRaw = state.cells.map((c) => raw(c.site.x, c.site.y));
      const nodeRaw = state.nodes.map((n) => raw(n.x, n.y));

      // Stretch to the full [0, 1] range over all sampled points.
      let min = Infinity, max = -Infinity;
      for (const v of cellRaw) { if (v < min) min = v; if (v > max) max = v; }
      for (const v of nodeRaw) { if (v < min) min = v; if (v > max) max = v; }
      const span = max - min;
      const norm = (v) => (span > 1e-12 ? (v - min) / span : 0.5);

      state.cells.forEach((c, i) => { c.altitude = norm(cellRaw[i]); });
      state.nodes.forEach((n, i) => { n.altitude = norm(nodeRaw[i]); });

      let sum = 0;
      for (const c of state.cells) sum += c.altitude;
      return 'Mean cell altitude ' + (sum / Math.max(1, state.cells.length)).toFixed(2);
    },

    // Each cell is drawn as a fan of triangles (center, point, next point),
    // colored by the mean altitude of the three, so node altitudes show too.
    // Uses the cell polygon (which follows the smoothed coast once step 6 ran)
    // and its per-point altitudes when available.
    draw(g, state) {
      // Once the altitude curve step has run, altitudes are in metres.
      const scale = state.altitudeMax || 1;
      g.lineWidth = 1;
      g.lineJoin = 'round';
      for (const c of state.cells) {
        const poly = c.poly;
        const alt = c.polyAlt || c.nodes.map((id) => state.nodes[id].altitude);
        for (let k = 0; k < poly.length; k++) {
          const k2 = (k + 1) % poly.length;
          const a = poly[k], b = poly[k2];
          const col = rampColor((c.altitude + alt[k] + alt[k2]) / 3 / scale);
          g.fillStyle = col;
          g.strokeStyle = col;
          g.beginPath();
          g.moveTo(c.site.x, c.site.y);
          g.lineTo(a.x, a.y);
          g.lineTo(b.x, b.y);
          g.closePath();
          g.fill();
          g.stroke();
        }
      }
    }
  };
})(window);
