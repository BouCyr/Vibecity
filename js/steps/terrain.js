// Step 13 — fine terrain: the altitude known per cell (~110 m apart, faceted)
// becomes a metre-scale raster: the facets are smoothed, noise octaves add
// detail, and the water keeps its say: every land sample stays above the
// level of the nearest water, so the banks stay consistent. Low flat land by
// the water is marsh. Every later step reads this terrain.
(function (global) {
  'use strict';

  /** Hillshade value in [0, 1] of a slope (dz/dx, dz/dy in m per m) lit from the north-west, 45° up. */
  function shade(dzdx, dzdy) {
    const lx = -0.5, ly = -0.5, lz = 0.7071;
    const nx = -dzdx, ny = -dzdy, nz = 1, l = Math.hypot(nx, ny, nz);
    return Math.max(0, (nx * lx + ny * ly + nz * lz) / l);
  }

  global.TerrainStep = {
    id: 'terrain',
    title: 'Fine terrain',
    zIndex: -0.95,  // above the altitude and raster layers, below the water
    settings: [
      { key: 'smoothing', label: 'Smoothing radius (m)', type: 'range', min: 0, max: 300, step: 10, default: 100 },
      { key: 'detail', label: 'Detail amplitude (m)', type: 'range', min: 0, max: 15, step: 0.5, default: 4 },
      { key: 'marshHeight', label: 'Marsh: height above the water (m)', type: 'range', min: 0, max: 5, step: 0.25, default: 1.5 },
      {
        key: 'show', label: 'Layer shows', type: 'select', default: 'shade',
        options: [{ value: 'shade', label: 'Hillshade and marsh' }, { value: 'marsh', label: 'Marsh only' }]
      }
    ],

    run(state, s, rng, ctx) {
      const t0 = performance.now();
      const pitch = state.fieldPitch || 2;
      const U = global.Units;
      const F = (name) => global.Fields.get(state, name, pitch, ctx);
      const alt = F('altitude'), water = F('water'), waterDist = F('waterDistance');
      const w = alt.w, h = alt.h, n = w * h;
      const land = water.map((v) => (v >= 0.5 ? 0 : 1));

      // 1. Smooth the facets, land only (the water does not pull the banks down).
      const smoothed = s.smoothing > 0 ? global.Fields.blur(alt, U.toUnits(s.smoothing), land) : alt;

      // 2. Detail: three octaves of simplex noise in metres, fading out near the water
      //    (within 25 m) and on the flat (proportional to the local relief, floor 0.3).
      const noise = global.createSimplex2D(rng);
      const relief = global.Fields.slopeOf(smoothed);
      const OCTAVES = [[60, 1], [20, 0.4], [7, 0.15]];  // wavelength in units, share of the amplitude
      const terrain = new global.Fields.Field(w, h, pitch);
      for (let j = 0, k = 0; j < h; j++) {
        for (let i = 0; i < w; i++, k++) {
          if (land.data[k] < 0.5) { terrain.data[k] = alt.data[k]; continue; }
          const x = (i + 0.5) * pitch, y = (j + 0.5) * pitch;
          let d = 0;
          for (const [wl, share] of OCTAVES) d += share * noise(x / wl, y / wl);
          const fade = Math.min(1, waterDist.data[k] / 10) * Math.min(1, Math.max(0.3, relief.data[k] / 0.1));
          terrain.data[k] = smoothed.data[k] + s.detail * fade * d;
        }
      }

      // 3. The water's say: the banks (land within 75 m of the water) stay above the
      //    nearest water's level (+ 0.3 m). Farther away the land may well lie below a
      //    distant upstream reach, so the constraint stops there.
      const nearest = waterDist.nearest;
      const level = new global.Fields.Field(w, h, pitch);
      let raised = 0;
      for (let k = 0; k < n; k++) {
        const src = nearest ? nearest[k] : -1;
        level.data[k] = src >= 0 ? alt.data[src] : 0;
        if (land.data[k] >= 0.5 && waterDist.data[k] < 30 && terrain.data[k] < level.data[k] + 0.3) { terrain.data[k] = level.data[k] + 0.3; raised++; }
      }

      // 4. Marsh: land within 400 m of the water, less than the marsh height above it, nearly flat.
      //    The mask is blurred and thresholded so the marsh comes as patches, not stripes.
      const slope = global.Fields.slopeOf(terrain);
      const rawMarsh = new global.Fields.Field(w, h, pitch);
      for (let k = 0; k < n; k++) {
        if (land.data[k] >= 0.5 && waterDist.data[k] < 160 && terrain.data[k] - level.data[k] < s.marshHeight && slope.data[k] < 0.03) rawMarsh.data[k] = 1;
      }
      const marsh = global.Fields.blur(rawMarsh, 20).map((v, i, j) => (v > 0.5 && land.data[j * w + i] >= 0.5 ? 1 : 0));
      let marshCount = 0;
      for (let k = 0; k < n; k++) marshCount += marsh.data[k];

      state.terrain = terrain;
      state.waterLevel = level;
      state.marsh = marsh;
      state.fields['terrain@' + pitch] = terrain;
      delete state.fields['terrainSlope@' + pitch];

      // Layer image: hillshade over the land, marsh in blue-green.
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const g = cv.getContext('2d'), img = g.createImageData(w, h);
      const run = pitch * U.METRES_PER_UNIT;
      for (let j = 0, k = 0, p = 0; j < h; j++) {
        for (let i = 0; i < w; i++, k++, p += 4) {
          if (land.data[k] < 0.5) { img.data[p + 3] = 0; continue; }
          if (marsh.data[k]) { img.data[p] = 90; img.data[p + 1] = 140; img.data[p + 2] = 120; img.data[p + 3] = 150; continue; }
          if (s.show !== 'shade') { img.data[p + 3] = 0; continue; }
          // Gradient from the land neighbours only (the water edge is not a slope).
          const kx1 = i + 1 < w && land.data[k + 1] >= 0.5 ? k + 1 : k, kx0 = i > 0 && land.data[k - 1] >= 0.5 ? k - 1 : k;
          const ky1 = j + 1 < h && land.data[k + w] >= 0.5 ? k + w : k, ky0 = j > 0 && land.data[k - w] >= 0.5 ? k - w : k;
          const dzdx = (terrain.data[kx1] - terrain.data[kx0]) / (((kx1 - kx0) || 1) * run);
          const dzdy = (terrain.data[ky1] - terrain.data[ky0]) / (((ky1 - ky0) / w || 1) * run);
          const v = shade(dzdx, dzdy);  // 0.7 is flat ground: lighter above, darker below
          const a = (v - 0.7) * 1.6;
          const c = a > 0 ? 255 : 0;
          img.data[p] = c; img.data[p + 1] = c; img.data[p + 2] = c;
          img.data[p + 3] = Math.round(Math.min(1, Math.abs(a)) * 110);
        }
      }
      g.putImageData(img, 0, 0);
      state.terrainImage = cv;

      const [lo, hi] = terrain.minMax();
      return w + ' × ' + h + ' samples, ' + Math.round(lo) + '–' + Math.round(hi) + ' m, ' + raised + ' samples raised above the water, marsh on ' +
        Math.round((marshCount * pitch * pitch * U.METRES_PER_UNIT * U.METRES_PER_UNIT) / 10000) + ' ha, ' + Math.round(performance.now() - t0) + ' ms';
    },

    draw(g, state, ctx) {
      if (!state.terrainImage) return;
      g.save();
      g.imageSmoothingEnabled = true;
      g.drawImage(state.terrainImage, 0, 0, ctx.width, ctx.height);
      g.restore();
    }
  };
})(window);
