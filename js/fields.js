// Raster fields over the map: regular grids of floats (altitude, distance to
// the water, slope…) sampled every `pitch` map units. Almost every rule of the
// city is of the form "density = f(distance to X)": such queries are trivial on
// a raster and painful on polygons. Fields are built on demand from the cell
// data and cached in `state.fields` (so they vanish with the state at every
// generation); `Fields.get(state, name, pitch)` is the entry point for steps.
(function (global) {
  'use strict';

  const INF = 1e20;

  /** A grid of `w` × `h` floats; sample (i, j) sits at map point ((i + 0.5) pitch, (j + 0.5) pitch). */
  class Field {
    constructor(w, h, pitch, data) {
      this.w = w;
      this.h = h;
      this.pitch = pitch;
      this.data = data || new Float32Array(w * h);
    }

    /** Field covering [0, width] × [0, height] with the given pitch. */
    static blank(width, height, pitch, fill) {
      const f = new Field(Math.ceil(width / pitch), Math.ceil(height / pitch), pitch);
      if (fill) f.data.fill(fill);
      return f;
    }

    get(i, j) { return this.data[j * this.w + i]; }
    set(i, j, v) { this.data[j * this.w + i] = v; }

    /** Value at map point (x, y), bilinear between the four nearest samples, clamped to the grid. */
    at(x, y) {
      const u = Math.min(this.w - 1, Math.max(0, x / this.pitch - 0.5));
      const v = Math.min(this.h - 1, Math.max(0, y / this.pitch - 0.5));
      const i = Math.min(this.w - 2, Math.floor(u)), j = Math.min(this.h - 2, Math.floor(v));
      const s = u - i, t = v - j, d = this.data, k = j * this.w + i;
      if (this.w === 1 || this.h === 1) return d[Math.round(v) * this.w + Math.round(u)];
      return (d[k] * (1 - s) + d[k + 1] * s) * (1 - t) + (d[k + this.w] * (1 - s) + d[k + this.w + 1] * s) * t;
    }

    /** Grid indices of the sample containing map point (x, y). */
    cell(x, y) {
      return [Math.min(this.w - 1, Math.max(0, Math.floor(x / this.pitch))), Math.min(this.h - 1, Math.max(0, Math.floor(y / this.pitch)))];
    }

    /** New field of the same shape with fn(value, i, j) applied to every sample. */
    map(fn) {
      const out = new Field(this.w, this.h, this.pitch);
      for (let j = 0, k = 0; j < this.h; j++) for (let i = 0; i < this.w; i++, k++) out.data[k] = fn(this.data[k], i, j);
      return out;
    }

    minMax() {
      let lo = Infinity, hi = -Infinity;
      for (const v of this.data) { if (v < lo) lo = v; if (v > hi) hi = v; }
      return [lo, hi];
    }
  }

  // ---------- Rasterization ----------

  /** Writes value interpolated from the three corners into every sample whose centre is inside the triangle. */
  function rasterizeTriangle(field, ax, ay, av, bx, by, bv, cx, cy, cv) {
    let area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0) return;
    if (area < 0) { // make it counter-clockwise so the edge functions are positive inside
      let t;
      t = bx; bx = cx; cx = t; t = by; by = cy; cy = t; t = bv; bv = cv; cv = t;
      area = -area;
    }
    const p = field.pitch;
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) / p - 0.5)), i1 = Math.min(field.w - 1, Math.ceil(Math.max(ax, bx, cx) / p - 0.5));
    const j0 = Math.max(0, Math.floor(Math.min(ay, by, cy) / p - 0.5)), j1 = Math.min(field.h - 1, Math.ceil(Math.max(ay, by, cy) / p - 0.5));
    // Samples exactly on a shared edge belong to both triangles (values agree there).
    const eps = -1e-9 * area;
    for (let j = j0; j <= j1; j++) {
      const y = (j + 0.5) * p;
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * p;
        const wa = (bx - x) * (cy - y) - (by - y) * (cx - x);
        if (wa < eps) continue;
        const wb = (cx - x) * (ay - y) - (cy - y) * (ax - x);
        if (wb < eps) continue;
        const wc = area - wa - wb;
        if (wc < eps) continue;
        field.data[j * field.w + i] = (wa * av + wb * bv + wc * cv) / area;
      }
    }
  }

  /**
   * Rasterizes every cell as a fan of triangles from its centre to its polygon
   * points: `value(cell, k)` gives the value at polygon point k, `value(cell, -1)`
   * at the centre. Samples no triangle reached (degenerate slivers) take the
   * value of their nearest filled neighbour; the count is returned in `holes`.
   */
  function rasterizeCells(state, pitch, width, height, value) {
    const field = Field.blank(width, height, pitch, NaN);
    for (const c of state.cells) {
      const poly = c.poly || c.nodes.map((id) => state.nodes[id]);
      if (poly.length < 3) continue;
      const vc = value(c, -1);
      for (let k = 0; k < poly.length; k++) {
        const k2 = (k + 1) % poly.length;
        rasterizeTriangle(field, c.site.x, c.site.y, vc, poly[k].x, poly[k].y, value(c, k), poly[k2].x, poly[k2].y, value(c, k2));
      }
    }
    field.holes = fillHoles(field);
    return field;
  }

  /** Replaces NaN samples by the nearest filled neighbour (growing rings); returns how many there were. */
  function fillHoles(field) {
    const d = field.data, w = field.w, h = field.h;
    let holes = [];
    for (let k = 0; k < d.length; k++) if (d[k] !== d[k]) holes.push(k);
    const count = holes.length;
    while (holes.length) {
      const next = [];
      const fixes = [];
      for (const k of holes) {
        const i = k % w, j = (k - i) / w;
        let sum = 0, n = 0;
        if (i > 0 && d[k - 1] === d[k - 1]) { sum += d[k - 1]; n++; }
        if (i + 1 < w && d[k + 1] === d[k + 1]) { sum += d[k + 1]; n++; }
        if (j > 0 && d[k - w] === d[k - w]) { sum += d[k - w]; n++; }
        if (j + 1 < h && d[k + w] === d[k + w]) { sum += d[k + w]; n++; }
        if (n) fixes.push(k, sum / n); else next.push(k);
      }
      if (!fixes.length) break; // nothing filled at all: leave the NaNs
      for (let m = 0; m < fixes.length; m += 2) d[fixes[m]] = fixes[m + 1];
      holes = next;
    }
    return count;
  }

  // ---------- Distance transform ----------

  /** Felzenszwalb–Huttenlocher squared distance transform of one line (f in, d out, in samples). */
  function edt1d(f, n, d, v, z) {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  }

  /**
   * Euclidean distance (map units, from sample centre to sample centre) from
   * every sample to the nearest sample where `inside(value)` holds. Samples
   * inside get 0. Exact, O(n).
   */
  function distanceTo(field, inside) {
    const w = field.w, h = field.h, n = Math.max(w, h);
    const sq = new Float64Array(w * h);
    for (let k = 0; k < sq.length; k++) sq[k] = inside(field.data[k]) ? 0 : INF;
    const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    for (let i = 0; i < w; i++) { // columns
      for (let j = 0; j < h; j++) f[j] = sq[j * w + i];
      edt1d(f, h, d, v, z);
      for (let j = 0; j < h; j++) sq[j * w + i] = d[j];
    }
    const out = new Field(w, h, field.pitch);
    for (let j = 0; j < h; j++) { // rows
      for (let i = 0; i < w; i++) f[i] = sq[j * w + i];
      edt1d(f, w, d, v, z);
      for (let i = 0; i < w; i++) out.data[j * w + i] = Math.sqrt(d[i]) * field.pitch;
    }
    return out;
  }

  // ---------- Derived fields ----------

  /** Slope as rise over run (metres per metre) from central differences of an altitude field in metres. */
  function slopeOf(alt) {
    const w = alt.w, h = alt.h, d = alt.data, run = alt.pitch * global.Units.METRES_PER_UNIT;
    const out = new Field(w, h, alt.pitch);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const dx = (d[k + (i + 1 < w ? 1 : 0)] - d[k - (i > 0 ? 1 : 0)]) / ((i + 1 < w ? 1 : 0) + (i > 0 ? 1 : 0) || 1);
        const dy = (d[k + (j + 1 < h ? w : 0)] - d[k - (j > 0 ? w : 0)]) / ((j + 1 < h ? 1 : 0) + (j > 0 ? 1 : 0) || 1);
        out.data[k] = Math.hypot(dx, dy) / run;
      }
    }
    return out;
  }

  const isWater = (c) => !!c.sea || c.river !== undefined;

  // Builders, by field name. Each gets (state, pitch, width, height, get) where
  // `get(name)` fetches another field at the same pitch (built if needed).
  const BUILDERS = {
    /** Altitude in metres (sea 0; land and river cells interpolated across each cell from their polygon points). */
    altitude(state, pitch, width, height) {
      // Before the altitude curve step, altitudes are in [0, 1]: show them as 300 m.
      const metres = state.altitudeMax ? 1 : 300;
      return rasterizeCells(state, pitch, width, height, (c, k) => {
        if (c.sea) return 0;
        if (k < 0) return c.altitude * metres;
        return (c.polyAlt ? c.polyAlt[k] : state.nodes[c.nodes[k]].altitude) * metres;
      });
    },
    /** 1 on the water (sea and river cells), 0 on land. */
    water(state, pitch, width, height) {
      return rasterizeCells(state, pitch, width, height, (c) => (isWater(c) ? 1 : 0));
    },
    /** Distance (map units) to the nearest water sample; 0 on the water. */
    waterDistance(state, pitch, width, height, get) {
      return distanceTo(get('water'), (v) => v >= 0.5);
    },
    /** Slope of the altitude, rise over run. */
    slope(state, pitch, width, height, get) {
      return slopeOf(get('altitude'));
    }
  };

  /** The field `name` at `pitch` map units, built on first use and cached in the state. */
  function get(state, name, pitch, ctx) {
    const width = (ctx && ctx.width) || 2000, height = (ctx && ctx.height) || 2000;
    const cache = state.fields || (state.fields = {});
    const key = name + '@' + pitch;
    if (!cache[key]) {
      const builder = BUILDERS[name];
      if (!builder) throw new Error('Unknown field ' + name);
      cache[key] = builder(state, pitch, width, height, (other) => get(state, other, pitch, ctx));
    }
    return cache[key];
  }

  global.Fields = {
    Field: Field,
    get: get,
    names: Object.keys(BUILDERS),
    rasterizeCells: rasterizeCells,
    rasterizeTriangle: rasterizeTriangle,
    distanceTo: distanceTo,
    slopeOf: slopeOf
  };
})(window);
