// Step 11 — raster fields: the cell data sampled on a regular grid (altitude,
// water, distance to the water, slope), the form every city rule reads. Built
// by js/fields.js; this step sets the pitch and shows one field as an image.
(function (global) {
  'use strict';

  // Colour of a sample for each display mode, as [r, g, b].
  const PAINTS = {
    altitude(v, lo, hi) { return global.altitudeRampRGB(hi > 0 ? v / hi : 0); },
    water(v) { return v >= 0.5 ? [95, 134, 168] : [239, 228, 200]; },
    waterDistance(v) {
      // Bands every 250 m (100 units), darker with the distance.
      const band = Math.floor(v / 100), t = Math.min(1, v / 1500);
      const base = band % 2 ? 0.88 : 0.8;
      return [Math.round(255 * base * (1 - 0.6 * t)), Math.round(240 * base * (1 - 0.45 * t)), Math.round(210 * base * (1 - 0.2 * t))];
    },
    slope(v) {
      // 0 (flat) light, 0.5 (27°) and above dark.
      const t = Math.min(1, v / 0.5), g = Math.round(240 - 190 * t);
      return [g, g, g];
    }
  };

  /** Offscreen canvas of the field, one pixel per sample. */
  function paint(field, mode) {
    const cv = document.createElement('canvas');
    cv.width = field.w; cv.height = field.h;
    const g = cv.getContext('2d');
    const img = g.createImageData(field.w, field.h);
    const [lo, hi] = field.minMax();
    const fn = PAINTS[mode] || PAINTS.waterDistance;
    for (let k = 0, p = 0; k < field.data.length; k++, p += 4) {
      const c = fn(field.data[k], lo, hi);
      img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2]; img.data[p + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  global.FieldsStep = {
    id: 'fields',
    title: 'Raster fields',
    defaultVisible: false,
    zIndex: -0.9,  // above the altitude layer (-1), below the sea, the rivers and the cell outlines
    settings: [
      { key: 'pitch', label: 'Pitch (map units per sample)', type: 'range', min: 1, max: 8, step: 1, default: 2 },
      {
        key: 'show', label: 'Field shown', type: 'select', default: 'waterDistance',
        options: [
          { value: 'altitude', label: 'Altitude' },
          { value: 'water', label: 'Water' },
          { value: 'waterDistance', label: 'Distance to the water' },
          { value: 'fleuveDistance', label: 'Distance to the fleuve' },
          { value: 'seaDistance', label: 'Distance to the sea' },
          { value: 'slope', label: 'Slope' }
        ]
      }
    ],

    run(state, s, rng, ctx) {
      const t0 = performance.now();
      const field = global.Fields.get(state, s.show, s.pitch, ctx);
      state.fieldImage = paint(field, s.show);
      const [lo, hi] = field.minMax();
      const units = { altitude: ' m', water: '', waterDistance: ' units', fleuveDistance: ' units', seaDistance: ' units', slope: '' };
      const fmt = (v) => (s.show === 'slope' ? v.toFixed(3) : Math.round(v)) + units[s.show];
      const holes = (state.fields['altitude@' + s.pitch] || state.fields['water@' + s.pitch] || {}).holes || 0;
      return field.w + ' × ' + field.h + ' samples every ' + s.pitch + ' units (' + global.Units.toMetres(s.pitch) + ' m), ' +
        s.show + ' from ' + fmt(lo) + ' to ' + fmt(hi) + (holes ? ', ' + holes + ' holes filled' : '') +
        ', ' + Math.round(performance.now() - t0) + ' ms';
    },

    draw(g, state, ctx) {
      if (!state.fieldImage) return;
      g.save();
      g.imageSmoothingEnabled = false;
      g.drawImage(state.fieldImage, 0, 0, ctx.width, ctx.height);
      g.restore();
    }
  };
})(window);
