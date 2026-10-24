// Step 15 — core and walls: around the site, two successive walls (the old
// small one of the core, the large one of the 13th century), each a polygon
// of a given area whose outline keeps a setback from the water (the river is
// the defence there), prefers the brow of the slopes, and wanders a little.
// Towers at intervals; gates on the outer wall: one towards the water (the
// bridge gate) and the others towards the open land.
(function (global) {
  'use strict';

  const RAYS = 72;  // every 5°
  const U = () => global.Units;

  /** Area of a polygon in map units². */
  function area(poly) {
    let a = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
    return Math.abs(a) / 2;
  }

  /** Distance along the ray from c at angle θ to the first water sample (map units), up to `max`; Infinity if none. */
  function waterLimit(water, c, theta, max) {
    const dx = Math.cos(theta), dy = Math.sin(theta);
    for (let r = 0; r <= max; r += 2) {
      const x = c.x + dx * r, y = c.y + dy * r;
      if (x < 0 || y < 0 || x >= water.w * water.pitch || y >= water.h * water.pitch) return r;
      if (water.at(x, y) >= 0.5) return r;
    }
    return Infinity;
  }

  /**
   * A wall around `c` enclosing about `targetArea` units²: for each ray, the
   * radius near the nominal one that minimizes a terrain cost (steep ground
   * costs, standing above a drop pays), capped by the water setback; then
   * smoothed around the circle. `wobble(θ)` scales the nominal radius.
   */
  function buildWall(c, targetArea, fields, setback, wobble, limitTo) {
    const { water, terrain, slope } = fields;
    const limits = [];
    for (let k = 0; k < RAYS; k++) limits.push(Math.max(10, waterLimit(water, c, (2 * Math.PI * k) / RAYS, 1200) - setback));
    let scale = 1, radii = null, poly = null;
    // Bisection on the scale of the nominal radius so that the clipped polygon has the
    // target area — up to 1.6 × the nominal radius: hemmed in by water, the town stays smaller.
    let lo = 0.5, hi = 1.6;
    for (let it = 0; it < 14; it++) {
      scale = (lo + hi) / 2;
      const r0 = Math.sqrt(targetArea / Math.PI) * scale;
      radii = [];
      for (let k = 0; k < RAYS; k++) {
        const theta = (2 * Math.PI * k) / RAYS, dx = Math.cos(theta), dy = Math.sin(theta);
        const rn = r0 * wobble(theta);
        let best = rn, bestCost = Infinity;
        for (let r = rn * 0.8; r <= rn * 1.2; r += 2) {
          const x = c.x + dx * r, y = c.y + dy * r;
          const drop = terrain.at(x, y) - terrain.at(x + dx * 15, y + dy * 15);  // metres the ground falls outside
          const cost = 4 * Math.pow((r - rn) / rn, 2) + 2 * slope.at(x, y) - 0.5 * Math.max(0, Math.min(1, drop / 5));
          if (cost < bestCost) { bestCost = cost; best = r; }
        }
        radii.push(best);
      }
      // Smooth around the circle (±2 rays), then the water setback and the enclosing wall have the last word.
      const sm = radii.map((_, k) => (radii[(k + RAYS - 2) % RAYS] + 2 * radii[(k + RAYS - 1) % RAYS] + 3 * radii[k] + 2 * radii[(k + 1) % RAYS] + radii[(k + 2) % RAYS]) / 9);
      for (let k = 0; k < RAYS; k++) {
        sm[k] = Math.min(sm[k], limits[k]);
        if (limitTo) sm[k] = Math.min(sm[k], limitTo((2 * Math.PI * k) / RAYS, c, sm[k]));
      }
      // Compact: hemmed in on two sides, the wall must not run off along the corridor
      // (1.4 × the median radius at most), yet a town on a bank still spreads inland (1.1 × the nominal radius).
      const median = sm.slice().sort((a, b) => a - b)[RAYS >> 1];
      const cap = Math.max(1.4 * median, 1.1 * Math.sqrt(targetArea / Math.PI));
      for (let k = 0; k < RAYS; k++) sm[k] = Math.min(sm[k], cap);
      poly = sm.map((r, k) => ({ x: c.x + Math.cos((2 * Math.PI * k) / RAYS) * r, y: c.y + Math.sin((2 * Math.PI * k) / RAYS) * r, r: r, onWater: r >= limits[k] - 1e-6 }));
      if (area(poly) < targetArea) lo = scale; else hi = scale;
    }
    return { poly: poly, limits: limits };
  }

  /** Radius of a star-shaped polygon (vertices every 2π/RAYS around `c`) in direction θ, interpolated. */
  function radiusAt(wall, theta) {
    const t = ((theta / (2 * Math.PI)) * RAYS + RAYS * 4) % RAYS;
    const k = Math.floor(t), f = t - k;
    return wall.poly[k % RAYS].r * (1 - f) + wall.poly[(k + 1) % RAYS].r * f;
  }

  /** Points every `spacing` units along a closed polygon (the towers). */
  function alongPolygon(poly, spacing) {
    const pts = [];
    let carry = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      let d = spacing - carry;
      while (d <= len) {
        pts.push({ x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len });
        d += spacing;
      }
      carry = len - (d - spacing);
    }
    return pts;
  }

  global.WallsStep = {
    id: 'walls',
    title: 'Core and walls',
    zIndex: 6,
    settings: [
      { key: 'innerArea', label: 'Old core wall: area (ha)', type: 'range', min: 3, max: 30, step: 1, default: 10 },
      { key: 'outerArea', label: 'Great wall: area (ha)', type: 'range', min: 20, max: 150, step: 5, default: 60 },
      { key: 'setback', label: 'Setback from the water (m)', type: 'range', min: 10, max: 100, step: 5, default: 30 },
      { key: 'irregularity', label: 'Irregularity', type: 'range', min: 0, max: 0.4, step: 0.05, default: 0.15 },
      { key: 'gates', label: 'Gates', type: 'range', min: 3, max: 6, step: 1, default: 4 },
      { key: 'towerSpacing', label: 'Tower spacing (m)', type: 'range', min: 30, max: 120, step: 5, default: 50 }
    ],

    run(state, s, rng, ctx) {
      const t0 = performance.now();
      const site = state.site;
      if (!site) { state.walls = null; state.core = null; return 'No site: no walls.'; }
      const pitch = state.fieldPitch || 2;
      const F = (name) => global.Fields.get(state, name, pitch, ctx);
      const fields = { water: F('water'), terrain: F('terrain'), slope: F('terrainSlope') };
      const toUnits = U().toUnits, ha = (a) => (a * U().METRES_PER_UNIT * U().METRES_PER_UNIT) / 10000;
      const setback = toUnits(s.setback);

      // A slow wobble around the circle: three harmonics with random phases.
      const wobbleOf = () => {
        const ph = [rng.range(0, 2 * Math.PI), rng.range(0, 2 * Math.PI), rng.range(0, 2 * Math.PI)];
        return (t) => 1 + s.irregularity * (Math.sin(2 * t + ph[0]) + 0.6 * Math.sin(3 * t + ph[1]) + 0.35 * Math.sin(5 * t + ph[2])) / 1.95;
      };

      // The great wall around the site.
      const outer = buildWall(site, s.outerArea * 10000 / (U().METRES_PER_UNIT * U().METRES_PER_UNIT), fields, setback, wobbleOf(), null);
      outer.kind = 'outer';
      outer.centre = { x: site.x, y: site.y };
      outer.area = ha(area(outer.poly));

      // The old core: its centre pulled towards the water (a bridgehead, a port) by a third of the way, inside the great wall.
      const pull = site.toWater ? Math.min(toUnits(site.radius ? 0 : 0) + site.radius * 0.35, Math.hypot(site.waterPoint.x - site.x, site.waterPoint.y - site.y) * 0.35) : 0;
      const ic = { x: site.x + (site.toWater ? site.toWater.x * pull : 0), y: site.y + (site.toWater ? site.toWater.y * pull : 0) };
      const insideOuter = (theta, c, r) => {
        // Largest radius from c along θ that stays 10 units inside the outer wall (star-shaped around the site).
        let ok = r;
        for (let t = 0; t <= r; t += 2) {
          const x = c.x + Math.cos(theta) * t, y = c.y + Math.sin(theta) * t;
          const ang = Math.atan2(y - site.y, x - site.x), d = Math.hypot(x - site.x, y - site.y);
          if (d > radiusAt(outer, ang) - 10) { ok = Math.max(0, t - 2); break; }
        }
        return ok;
      };
      const inner = buildWall(ic, s.innerArea * 10000 / (U().METRES_PER_UNIT * U().METRES_PER_UNIT), fields, setback, wobbleOf(), insideOuter);
      inner.kind = 'inner';
      inner.centre = ic;
      inner.area = ha(area(inner.poly));

      // Towers along both walls.
      const spacing = toUnits(s.towerSpacing);
      outer.towers = alongPolygon(outer.poly, spacing);
      inner.towers = alongPolygon(inner.poly, spacing * 1.2);

      // Gates on the great wall: the bridge gate towards the water, the others towards the open land.
      const W = ctx.width, H = ctx.height;
      const gates = [];
      const vertexAt = (theta) => outer.poly[Math.round((((theta / (2 * Math.PI)) * RAYS) % RAYS + RAYS) % RAYS) % RAYS];
      const angleOf = (p) => Math.atan2(p.y - site.y, p.x - site.x);
      if (site.toWater) {
        const v = vertexAt(Math.atan2(site.toWater.y, site.toWater.x));
        gates.push({ x: v.x, y: v.y, angle: angleOf(v), kind: 'bridge' });
      }
      const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
      const candidates = [];
      for (let k = 0; k < 24; k++) {
        const theta = (2 * Math.PI * k) / 24;
        const v = vertexAt(theta);
        if (v.onWater) continue;  // the wall stands on the bank there
        if (gates.some((g) => angDiff(g.angle, theta) < Math.PI / 3)) continue;
        // Share of land along the ray from the gate to the map border.
        let land = 0, n = 0;
        for (let r = v.r + 4; ; r += 8) {
          const x = site.x + Math.cos(theta) * r, y = site.y + Math.sin(theta) * r;
          if (x < 0 || y < 0 || x >= W || y >= H) break;
          n++;
          if (fields.water.at(x, y) < 0.5) land++;
        }
        candidates.push({ theta: theta, v: v, land: n ? land / n : 0 });
      }
      candidates.sort((a, b) => b.land - a.land);
      for (const cnd of candidates) {
        if (gates.length >= s.gates) break;
        if (gates.some((g) => angDiff(g.angle, cnd.theta) < Math.PI / 3)) continue;
        gates.push({ x: cnd.v.x, y: cnd.v.y, angle: angleOf(cnd.v), kind: 'land', landShare: cnd.land });
      }
      outer.gates = gates;
      inner.gates = [];  // set by the roads step, where the axes cross the old wall

      state.walls = [inner, outer];
      state.core = { x: ic.x, y: ic.y };
      const short = outer.area < s.outerArea * 0.9 ? ' (hemmed in by the water: ' + s.outerArea + ' ha asked)' : '';
      return 'Great wall ' + outer.area.toFixed(1) + ' ha' + short + ' (' + outer.towers.length + ' towers, ' + gates.length + ' gates: ' +
        gates.map((g) => g.kind).join(', ') + '), old core ' + inner.area.toFixed(1) + ' ha, ' + Math.round(performance.now() - t0) + ' ms';
    },

    draw(g, state, ctx) {
      const px = (ctx && ctx.px) || 1;
      if (!state.walls) return;
      for (const wall of state.walls) {
        const outer = wall.kind === 'outer';
        g.save();
        g.strokeStyle = outer ? '#3a2e22' : '#6b5440';
        g.lineWidth = (outer ? 3 : 2) * px;
        g.lineJoin = 'round';
        g.beginPath();
        wall.poly.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
        g.stroke();
        g.fillStyle = g.strokeStyle;
        for (const t of wall.towers) {
          g.beginPath();
          g.arc(t.x, t.y, (outer ? 3 : 2.2) * px, 0, Math.PI * 2);
          g.fill();
        }
        for (const gate of wall.gates || []) {
          const r = 5 * px;
          g.fillStyle = '#fffdf7';
          g.fillRect(gate.x - r, gate.y - r, 2 * r, 2 * r);
          g.lineWidth = 1.5 * px;
          g.strokeRect(gate.x - r, gate.y - r, 2 * r, 2 * r);
        }
        g.restore();
      }
      if (state.core) {
        g.save();
        g.fillStyle = '#8c3b1f';
        const r = 5 * px;
        g.fillRect(state.core.x - r, state.core.y - r, 2 * r, 2 * r);
        g.restore();
      }
    }
  };
})(window);
