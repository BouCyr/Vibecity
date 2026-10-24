// Step 14 — site of the city: every point of the map is scored for a medieval
// town (on the bank of the fleuve, buildable, a crossing, near a confluence or
// the sea, on a defensible rise…) and the best one becomes the city centre.
// Reads the raster fields of step 11 and the fine terrain of step 13.
(function (global) {
  'use strict';

  // Weights of the criteria for each preference.
  const PREFERENCES = {
    port: { label: 'River port', bank: 3, flat: 2, crossing: 1.5, sea: 1, prominence: 0.5, confluence: 0.5 },
    hill: { label: 'Hilltop town', prominence: 3, near: 1.5, flat: 0.5, crossing: 1, bank: 0.5 },
    confluence: { label: 'Confluence', confluence: 3, bank: 2, flat: 1.5, crossing: 1 }
  };

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const smooth = (v, a, b) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  /** 0 below a, rising to 1 at b, 1 until c, falling to 0 at d. */
  const plateau = (v, a, b, c, d) => (v < b ? smooth(v, a, b) : 1 - smooth(v, c, d));

  /** Unit vector of the descent of a distance field at (x, y): points towards the nearest source. */
  function towards(field, x, y) {
    const h = field.pitch;
    const gx = field.at(x + h, y) - field.at(x - h, y), gy = field.at(x, y + h) - field.at(x, y - h);
    const l = Math.hypot(gx, gy);
    return l > 1e-9 ? { x: -gx / l, y: -gy / l } : null;
  }

  global.SiteStep = {
    id: 'site',
    title: 'Site',
    zIndex: 5,
    settings: [
      {
        key: 'preference', label: 'Preference', type: 'select', default: 'port',
        options: Object.keys(PREFERENCES).map((k) => ({ value: k, label: PREFERENCES[k].label }))
      },
      { key: 'edgeMargin', label: 'Minimum distance from the map edge (m)', type: 'range', min: 500, max: 2200, step: 50, default: 1500 },
      { key: 'cityRadius', label: 'City radius (m)', type: 'range', min: 300, max: 1000, step: 50, default: 500 },
      {
        key: 'show', label: 'Layer shows', type: 'select', default: 'scores',
        options: [{ value: 'site', label: 'The site' }, { value: 'scores', label: 'The site and the scores' }]
      }
    ],

    run(state, s, rng, ctx) {
      const t0 = performance.now();
      const W = ctx.width, H = ctx.height, U = global.Units.toUnits;
      const F = (name) => global.Fields.get(state, name, state.fieldPitch || 2, ctx);
      const pref = PREFERENCES[s.preference];
      const R = U(s.cityRadius);
      const margin = Math.min(U(s.edgeMargin), W / 2 - 50);
      const water = F('water'), altitude = F('terrain'), slope = F('terrainSlope');
      const hasFleuve = (state.rivers || []).some((r) => r.kind === 'fleuve');
      const hasRiver = (state.rivers || []).length > 0;
      const hasSea = state.cells.some((c) => c.sea);
      // The watercourse the town settles on: the fleuve, else any river, else the sea.
      const course = hasFleuve ? F('fleuveDistance') : hasRiver ? F('riverDistance') : hasSea ? F('seaDistance') : null;
      const seaDist = hasSea ? F('seaDistance') : null;
      // Confluences: the junction cells built by step 9 (their centroids).
      const junctions = state.cells.filter((c) => c.junction).map((c) => c.site);

      // Sample offsets on a ring of radius r (n points) — for the surroundings of a candidate.
      const ring = (r, n) => Array.from({ length: n }, (_, k) => ({ x: r * Math.cos((2 * Math.PI * k) / n), y: r * Math.sin((2 * Math.PI * k) / n) }));
      const discPts = [{ x: 0, y: 0 }].concat(ring(R / 2, 8), ring(R, 12));
      const ringPts = ring(R, 16);
      const ROAD_WIDTH = 30; // guess of the course's width, in units, when looking for the far bank

      const terms = (x, y) => {
        if (water.at(x, y) >= 0.5) return null;
        const t = {};
        let land = 0, slopeSum = 0;
        for (const o of discPts) {
          const px = x + o.x, py = y + o.y;
          if (water.at(px, py) < 0.5) land++;
          slopeSum += slope.at(px, py);
        }
        t.land = land / discPts.length;
        // Buildable: mean slope over the disc (the land's median is about 0.12; 0.25 = 14° counts as steep).
        t.flat = 1 - clamp01(slopeSum / discPts.length / 0.25);
        // A rise: the centre above three quarters of the ring (the river valley alone lowers a quarter of it).
        const around = ringPts.map((o) => altitude.at(x + o.x, y + o.y)).sort((a, b) => a - b);
        t.prominence = clamp01((altitude.at(x, y) - around[Math.floor(ringPts.length * 0.75)]) / 30);
        if (course) {
          const d = course.at(x, y);
          t.bank = plateau(d, 10, 40, 120, 400);       // 100–300 m from the bank is ideal
          t.near = 1 - clamp01((d - 100) / 400);       // for a hilltop: the river within ~1 km
          // A crossing: land on the far bank, straight across.
          const dir = towards(course, x, y);
          t.crossing = 0;
          if (dir && hasRiver) {
            const fx = x + dir.x * (d + ROAD_WIDTH + 50), fy = y + dir.y * (d + ROAD_WIDTH + 50);
            if (fx > 0 && fy > 0 && fx < W && fy < H && water.at(fx, fy) < 0.5 && course.at(fx, fy) < 120) t.crossing = 1;
          }
        } else {
          t.bank = t.near = t.crossing = 0;
        }
        // Near the sea but not on the coast: the lowest crossing of the fleuve, 300 m to 1.2 km from it.
        t.sea = seaDist ? plateau(seaDist.at(x, y), 40, 120, 480, 1000) : 0;
        let dj = Infinity;
        for (const j of junctions) dj = Math.min(dj, Math.hypot(j.x - x, j.y - y));
        t.confluence = 1 - clamp01(dj / 300);
        return t;
      };

      const score = (t) => {
        let sum = 0, wsum = 0;
        for (const k in pref) {
          if (k === 'label') continue;
          sum += pref[k] * (t[k] || 0);
          wsum += pref[k];
        }
        return (sum / wsum) * smooth(t.land, 0.35, 0.75);
      };

      // Candidates every 8 units (20 m) inside the margin.
      const PITCH = 8;
      const scores = global.Fields.Field.blank(W, H, PITCH, 0);
      let best = null;
      for (let j = 0; j < scores.h; j++) {
        const y = (j + 0.5) * PITCH;
        if (y < margin || y > H - margin) continue;
        for (let i = 0; i < scores.w; i++) {
          const x = (i + 0.5) * PITCH;
          if (x < margin || x > W - margin) continue;
          const t = terms(x, y);
          if (!t) continue;
          const v = score(t);
          scores.set(i, j, v);
          if (!best || v > best.score) best = { x: x, y: y, score: v, terms: t };
        }
      }
      state.siteScores = scores;
      if (!best) {
        state.site = null;
        return 'No land inside the margin: no site.';
      }
      // Orientation: towards the water the town settles on; the course runs square to it.
      const dir = course ? towards(course, best.x, best.y) : null;
      const d = course ? course.at(best.x, best.y) : 0;
      state.site = {
        x: best.x, y: best.y, score: best.score, terms: best.terms, radius: R, preference: s.preference,
        toWater: dir, waterPoint: dir ? { x: best.x + dir.x * d, y: best.y + dir.y * d } : null,
        axis: dir ? Math.atan2(dir.x, -dir.y) : 0  // angle of the course's direction (0 = north)
      };
      const T = best.terms;
      const parts = Object.keys(pref).filter((k) => k !== 'label').map((k) => k + ' ' + (T[k] || 0).toFixed(2));
      return PREFERENCES[s.preference].label + ' at (' + Math.round(best.x) + ', ' + Math.round(best.y) + '), score ' + best.score.toFixed(2) +
        ' (' + parts.join(', ') + '), ' + Math.round(performance.now() - t0) + ' ms';
    },

    draw(g, state, ctx) {
      const px = (ctx && ctx.px) || 1;
      const show = (ctx.settings && ctx.settings.show) || 'scores';
      if (show === 'scores' && state.siteScores) {
        // Heat map of the candidates' scores, warm where high; 0 is left clear.
        const f = state.siteScores;
        if (!state.siteScoreImage) {
          const cv = document.createElement('canvas');
          cv.width = f.w; cv.height = f.h;
          const c2 = cv.getContext('2d'), img = c2.createImageData(f.w, f.h);
          // Contrast: the top half of the scores, from the median to the best.
          const sorted = Array.from(f.data).filter((v) => v > 0).sort((a, b) => a - b);
          const lo = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0, hi = sorted.length ? sorted[sorted.length - 1] : 1;
          for (let k = 0, p = 0; k < f.data.length; k++, p += 4) {
            const v = f.data[k] > 0 && hi > lo ? clamp01((f.data[k] - lo) / (hi - lo)) : 0;
            img.data[p] = 200; img.data[p + 1] = Math.round(120 - 90 * v); img.data[p + 2] = 40;
            img.data[p + 3] = f.data[k] > 0 ? Math.round(20 + 180 * v * v) : 0;
          }
          c2.putImageData(img, 0, 0);
          state.siteScoreImage = cv;
        }
        g.save();
        g.imageSmoothingEnabled = false;
        g.drawImage(state.siteScoreImage, 0, 0, ctx.width, ctx.height);
        g.restore();
      }
      const site = state.site;
      if (!site) return;
      g.save();
      g.strokeStyle = '#8c3b1f';
      g.fillStyle = '#8c3b1f';
      g.lineWidth = 1.5 * px;
      g.setLineDash([6 * px, 4 * px]);
      g.beginPath();
      g.arc(site.x, site.y, site.radius, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
      if (site.waterPoint) { // the way down to the water (the future bridge or port)
        g.beginPath();
        g.moveTo(site.x, site.y);
        g.lineTo(site.waterPoint.x, site.waterPoint.y);
        g.stroke();
      }
      g.beginPath();
      g.arc(site.x, site.y, 4 * px, 0, Math.PI * 2);
      g.fill();
      g.font = (12 * px) + 'px Georgia, serif';
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      g.fillText('Site', site.x, site.y - 7 * px);
      g.restore();
    }
  };
})(window);
