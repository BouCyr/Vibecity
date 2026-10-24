// Step 23 — fields and woods: the land around, as a raster of land use and
// a parcel drawing. Gardens and orchards ring the settlements, vines take
// the sunny slopes near the town, wet meadows line the water, woods hold the
// steep ground and the far distance, the rest is arable: open fields of
// long strips grouped in furlongs (or hedged parcels in a bocage).
(function (global) {
  'use strict';

  const U = () => global.Units;
  const CLASSES = ['water', 'built', 'marsh', 'wood', 'garden', 'orchard', 'vineyard', 'meadow', 'heath', 'arable', 'road'];
  const COLOURS = {
    water: null, built: null, road: null,
    marsh: [110, 150, 130, 0.35], wood: [78, 112, 60, 0.75], garden: [150, 180, 95, 0.55], orchard: [160, 190, 110, 0.55],
    vineyard: [190, 170, 100, 0.55], meadow: [170, 200, 120, 0.5], heath: [200, 190, 140, 0.45], arable: [222, 205, 150, 0.4]
  };
  const ID = {};
  CLASSES.forEach((c, i) => { ID[c] = i; });

  global.LandUseStep = {
    id: 'landuse',
    title: 'Fields and woods',
    zIndex: -0.93,  // over the terrain's hillshade, under the water and the town
    settings: [
      { key: 'system', label: 'Field system', type: 'select', default: 'openfield', options: [{ value: 'openfield', label: 'Open fields (strips in furlongs)' }, { value: 'bocage', label: 'Bocage (hedged parcels)' }] },
      { key: 'furlong', label: 'Furlong size (m)', type: 'range', min: 100, max: 500, step: 10, default: 220 },
      { key: 'strip', label: 'Strip width (m)', type: 'range', min: 5, max: 40, step: 1, default: 14 },
      { key: 'woodDistance', label: 'Woods beyond (m from any settlement)', type: 'range', min: 400, max: 2500, step: 50, default: 1300 },
      { key: 'copses', label: 'Copses', type: 'range', min: 0, max: 1, step: 0.05, default: 0.3 }
    ],

    run(state, s, rng, ctx) {
      const t0 = performance.now();
      state.landUse = null; state.fieldLines = null; state.fieldEdges = null;
      if (!state.terrain || !state.walls) return 'No terrain: no fields.';
      const toU = U().toUnits, W = ctx.width, H = ctx.height;
      const fp = state.fieldPitch || 2;
      const F = (name) => global.Fields.get(state, name, fp, ctx);
      const water = F('water'), slope = F('terrainSlope'), terrain = F('terrain'), waterDist = F('waterDistance'), marsh = state.marsh;
      const outer = state.walls.find((x) => x.kind === 'outer');
      const site = state.site;
      const pitch = fp * 2;
      const Field = global.Fields.Field;
      const w = Math.ceil(W / pitch), h = Math.ceil(H / pitch);

      // Settlements: the town, the built lots, the villages, the abbey; their distance field.
      const settled = new Field(w, h, pitch);
      const lotsByCell = new Map();
      for (const lot of state.lots || []) {
        if (lot.block >= 0) continue;  // intra muros: the wall covers it
        const c = global.polygonCentroid(lot.poly);
        const k = Math.min(h - 1, Math.floor(c.y / pitch)) * w + Math.min(w - 1, Math.floor(c.x / pitch));
        settled.data[k] = 1;
        lotsByCell.set(k, 1);
      }
      const marks = [];
      for (const v of state.villages || []) marks.push({ x: v.x, y: v.y, r: toU(v.kind === 'village' ? 25 : 15) });
      for (const e of state.extraMuros || []) if (e.kind === 'abbey' || e.kind === 'leper') marks.push({ x: e.centre.x, y: e.centre.y, r: toU(60) });
      for (let j = 0, k = 0; j < h; j++) for (let i = 0; i < w; i++, k++) {
        const x = (i + 0.5) * pitch, y = (j + 0.5) * pitch;
        if (global.wallDepthOf(outer, { x: x, y: y }) > -toU(10)) settled.data[k] = 1;
        else for (const m of marks) if (Math.hypot(m.x - x, m.y - y) < m.r) { settled.data[k] = 1; break; }
      }
      const dSet = global.Fields.distanceTo(settled, (v) => v >= 0.5);
      // Roads and lanes, to break the parcels and leave a verge.
      const roadCell = new Uint8Array(w * h);
      const lines = (state.roads || []).filter((r) => r.kind === 'outward').map((r) => r.points).concat((state.lanes || []).map((l) => l.points));
      if (state.bridge) lines.push([state.bridge.a, state.bridge.b]);
      for (const pts of lines) for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1], n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (pitch / 2));
        for (let t = 0; t <= n; t++) {
          const x = a.x + ((b.x - a.x) * t) / n, y = a.y + ((b.y - a.y) * t) / n;
          const i0 = Math.min(w - 1, Math.max(0, Math.floor(x / pitch))), j0 = Math.min(h - 1, Math.max(0, Math.floor(y / pitch)));
          roadCell[j0 * w + i0] = 1;
        }
      }

      // Classification.
      const noise = global.createSimplex2D(rng), noise2 = global.createSimplex2D(rng);
      const use = new Field(w, h, pitch);
      const counts = new Array(CLASSES.length).fill(0);
      const run = pitch * U().METRES_PER_UNIT;
      for (let j = 0, k = 0; j < h; j++) {
        for (let i = 0; i < w; i++, k++) {
          const x = (i + 0.5) * pitch, y = (j + 0.5) * pitch;
          let c;
          const sl = slope.at(x, y), d = dSet.data[k], nz = noise(x / 300, y / 300), nz2 = noise2(x / 90, y / 90);
          const dCity = Math.hypot(x - site.x, y - site.y);
          if (water.at(x, y) >= 0.5) c = 'water';
          else if (settled.data[k] >= 0.5) c = 'built';
          else if (roadCell[k]) c = 'road';
          else if (marsh && marsh.at(x, y) >= 0.5) c = 'marsh';
          else if (sl > 0.4) c = 'wood';
          else if (d < (dCity < toU(700) ? toU(230) : toU(90)) + nz * toU(60)) c = nz2 > 0.15 ? 'orchard' : 'garden';
          else if ((terrain.at(x, y + pitch) - terrain.at(x, y - pitch)) / (2 * run) < -0.06 && sl < 0.35 && dCity < toU(1000) && nz > -0.1) c = 'vineyard';
          else if (waterDist.at(x, y) < toU(50) && sl < 0.06) c = 'meadow';
          else if (d > toU(s.woodDistance) + nz * toU(350)) c = 'wood';
          else if (sl > 0.22) c = nz > -0.1 ? 'wood' : 'heath';
          else if (nz2 > 1 - s.copses * 0.9) c = 'wood';
          else c = 'arable';
          use.data[k] = ID[c];
          counts[ID[c]]++;
        }
      }

      // Parcels: furlongs (Voronoi cells of jittered seeds), strips inside them for the open fields.
      const furlong = toU(s.furlong) * (s.system === 'bocage' ? 0.55 : 1);
      const seeds = [];
      for (let y = furlong / 2; y < H; y += furlong) for (let x = furlong / 2; x < W; x += furlong) {
        seeds.push({ x: Math.min(W - 1, Math.max(1, x + rng.range(-0.35, 0.35) * furlong)), y: Math.min(H - 1, Math.max(1, y + rng.range(-0.35, 0.35) * furlong)) });
      }
      const cells = global.computeVoronoi(seeds, { x0: 0, y0: 0, x1: W, y1: H });
      const classAt = (x, y) => use.data[Math.min(h - 1, Math.max(0, Math.floor(y / pitch))) * w + Math.min(w - 1, Math.max(0, Math.floor(x / pitch)))];
      const fieldy = (c) => c === ID.arable || c === ID.meadow || c === ID.vineyard || c === ID.heath;
      const stripy = (c) => c === ID.arable;
      /** Pieces of the segment a–b over cells where `ok(class)` holds, as [x1, y1, x2, y2]. */
      const pieces = (a, b, ok, out) => {
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (pitch / 2)));
        let start = null;
        for (let t = 0; t <= n; t++) {
          const x = a.x + ((b.x - a.x) * t) / n, y = a.y + ((b.y - a.y) * t) / n;
          const good = t < n && ok(classAt(x + (b.x - a.x) / n / 2, y + (b.y - a.y) / n / 2));
          if (good && start === null) start = { x: x, y: y };
          if (!good && start !== null) { if (Math.hypot(x - start.x, y - start.y) > 3) out.push([start.x, start.y, x, y]); start = null; }
        }
      };
      const edges = [], strips = [];
      const seen = new Set();
      const key = (p) => Math.round(p.x) + ',' + Math.round(p.y);
      for (const cell of cells) {
        const poly = cell.poly;
        // Boundaries (once per shared edge).
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length];
          const ka = key(a), kb = key(b), ek = ka < kb ? ka + '|' + kb : kb + '|' + ka;
          if (seen.has(ek)) continue;
          seen.add(ek);
          pieces(a, b, fieldy, edges);
        }
        if (s.system !== 'openfield') continue;
        // Strip direction: square to the nearest lane when one is near, else along the contour.
        const c = cell.site;
        let theta;
        let nearest = Infinity, nearDir = null;
        for (const pts of lines) for (let i = 0; i + 1 < pts.length; i++) {
          const p = pts[i], q = pts[i + 1], vx = q.x - p.x, vy = q.y - p.y, l2 = vx * vx + vy * vy;
          if (l2 < 1e-9) continue;
          const t = Math.max(0, Math.min(1, ((c.x - p.x) * vx + (c.y - p.y) * vy) / l2));
          const dd = Math.hypot(c.x - p.x - vx * t, c.y - p.y - vy * t);
          if (dd < nearest) { nearest = dd; nearDir = Math.atan2(vy, vx); }
        }
        if (nearest < toU(150)) theta = nearDir + Math.PI / 2;
        else {
          const gx = terrain.at(c.x + pitch, c.y) - terrain.at(c.x - pitch, c.y), gy = terrain.at(c.x, c.y + pitch) - terrain.at(c.x, c.y - pitch);
          theta = Math.hypot(gx, gy) > 0.05 ? Math.atan2(gy, gx) + Math.PI / 2 : rng.range(0, Math.PI);
        }
        // Parallel lines at the strip width, clipped to the cell.
        const dx = Math.cos(theta), dy = Math.sin(theta), nx = -dy, ny = dx;
        let lo = Infinity, hi = -Infinity;
        for (const p of poly) { const v = p.x * nx + p.y * ny; lo = Math.min(lo, v); hi = Math.max(hi, v); }
        const sw = toU(s.strip);
        for (let off = lo + sw * rng.range(0.3, 1); off < hi; off += sw * (1 + 0.3 * rng.range(-1, 1))) {
          // Intersections of the line {p·n = off} with the cell's edges.
          const hits = [];
          for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length];
            const fa = a.x * nx + a.y * ny - off, fb = b.x * nx + b.y * ny - off;
            if ((fa <= 0) !== (fb <= 0)) { const t = fa / (fa - fb); hits.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
          }
          if (hits.length >= 2) pieces(hits[0], hits[1], stripy, strips);
        }
      }

      // Image of the land use.
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const g = cv.getContext('2d'), img = g.createImageData(w, h);
      for (let k = 0, p = 0; k < use.data.length; k++, p += 4) {
        const col = COLOURS[CLASSES[use.data[k]]];
        if (!col) continue;
        img.data[p] = col[0]; img.data[p + 1] = col[1]; img.data[p + 2] = col[2]; img.data[p + 3] = Math.round(col[3] * 255);
      }
      g.putImageData(img, 0, 0);

      state.landUse = use;
      state.landUseImage = cv;
      state.fieldEdges = edges;
      state.fieldLines = strips;
      const ha = (n) => Math.round((n * pitch * pitch * U().METRES_PER_UNIT * U().METRES_PER_UNIT) / 10000);
      const summary = ['arable', 'wood', 'meadow', 'vineyard', 'orchard', 'garden', 'heath'].map((c) => c + ' ' + ha(counts[ID[c]]) + ' ha').join(', ');
      return summary + '; ' + cells.length + ' furlongs, ' + strips.length + ' strips, ' + edges.length + ' boundaries, ' + Math.round(performance.now() - t0) + ' ms';
    },

    draw(g, state, ctx) {
      const px = (ctx && ctx.px) || 1;
      if (!state.landUseImage) return;
      g.save();
      g.imageSmoothingEnabled = true;
      g.drawImage(state.landUseImage, 0, 0, ctx.width, ctx.height);
      if (ctx.scale > 0.45) {
        g.lineCap = 'butt';
        g.strokeStyle = 'rgba(90, 70, 40, .55)';
        g.lineWidth = 0.5 * px;
        g.beginPath();
        for (const [x1, y1, x2, y2] of state.fieldLines) { g.moveTo(x1, y1); g.lineTo(x2, y2); }
        g.stroke();
        g.strokeStyle = ctx.settings && ctx.settings.system === 'bocage' ? 'rgba(60, 95, 45, .9)' : 'rgba(80, 60, 35, .8)';
        g.lineWidth = (ctx.settings && ctx.settings.system === 'bocage' ? 1.6 : 0.9) * px;
        g.beginPath();
        for (const [x1, y1, x2, y2] of state.fieldEdges) { g.moveTo(x1, y1); g.lineTo(x2, y2); }
        g.stroke();
      }
      g.restore();
    }
  };
})(window);
