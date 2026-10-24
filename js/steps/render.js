// Step 24 — the drawing: a pen-and-ink plan of the whole map, replacing the
// working layers while it is shown. Hillshade and contour lines, the water
// with its ripples, the land with its parcels and textures, roads and lanes,
// the town to every house, the walls, the monuments, and the names of
// everything, with a cartouche. Written against a pen (js/pen.js), so the
// same code also writes the SVG to export.
(function (global) {
  'use strict';

  const U = () => global.Units;
  const INK = '#2b2017', INK_SOFT = 'rgba(43, 32, 23, .7)', PAPER = '#efe4c8', PAPER_LIGHT = '#f5edd8';
  const WATER = '#d6e3ea', SHORE = '#4a5a6a', CONTOUR = 'rgba(120, 80, 40, .5)', WOOD = '#cfd9b8', MEADOW = '#e3e9cc', MARSH = '#d9e2d4';

  /**
   * Marching squares: segments [x1, y1, x2, y2, …] of the isoline `level` of a
   * field, sampled every `stride` samples; cells with a skipped corner are left out.
   */
  function isolines(field, level, stride, skip) {
    const w = field.w, h = field.h, d = field.data, p = field.pitch;
    const out = [];
    const X = (i) => (i * stride + 0.5) * p, Y = (j) => (j * stride + 0.5) * p;
    const nx = Math.floor((w - 1) / stride), ny = Math.floor((h - 1) / stride);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k00 = j * stride * w + i * stride, k10 = k00 + stride, k01 = k00 + stride * w, k11 = k01 + stride;
        if (skip && (skip(k00) || skip(k10) || skip(k01) || skip(k11))) continue;
        const v00 = d[k00], v10 = d[k10], v11 = d[k11], v01 = d[k01];
        const c = (v00 >= level ? 1 : 0) | (v10 >= level ? 2 : 0) | (v11 >= level ? 4 : 0) | (v01 >= level ? 8 : 0);
        if (c === 0 || c === 15) continue;
        const x0 = X(i), x1 = X(i + 1), y0 = Y(j), y1 = Y(j + 1);
        const t = (a, b) => (level - a) / (b - a || 1e-9);
        const top = [x0 + (x1 - x0) * t(v00, v10), y0], right = [x1, y0 + (y1 - y0) * t(v10, v11)];
        const bottom = [x0 + (x1 - x0) * t(v01, v11), y1], left = [x0, y0 + (y1 - y0) * t(v00, v01)];
        const seg = (a, b) => out.push(a[0], a[1], b[0], b[1]);
        switch (c) {
          case 1: case 14: seg(left, top); break;
          case 2: case 13: seg(top, right); break;
          case 3: case 12: seg(left, right); break;
          case 4: case 11: seg(right, bottom); break;
          case 5: case 10: {
            const mid = (v00 + v10 + v11 + v01) / 4;
            if ((c === 5) === (mid >= level)) { seg(left, top); seg(right, bottom); } else { seg(top, right); seg(left, bottom); }
            break;
          }
          case 6: case 9: seg(top, bottom); break;
          case 7: case 8: seg(left, bottom); break;
          default: break;
        }
      }
    }
    return out;
  }

  /** Deterministic jitter in [0, 1) from integers. */
  function hash(i, j, salt) {
    let h = (i * 374761393 + j * 668265263 + salt * 2246822519) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function polyBox(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    return [x0, y0, x1, y1];
  }

  /** The drawing itself, through a pen: used for the screen and for the SVG. */
  function drawAll(pen, state, s, ctx) {
    const W = ctx.width, H = ctx.height, toU = U().toUnits;
    const z = pen.scale;  // screen px per unit (1 for the SVG)
    const r = state.render;
    if (!r) return;

    // 1. Ground: paper, hillshade, land use tints.
    pen.group('ground');
    pen.polygon([{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], { fill: PAPER });
    if (state.terrainImage) pen.image(state.terrainImage, 0, 0, W, H, 0.7);
    if (r.landImage) pen.image(r.landImage, 0, 0, W, H, 1);
    pen.endGroup();

    // 2. Contour lines.
    if (s.contours !== 'none') {
      pen.group('contours');
      pen.segments(r.contours, { stroke: CONTOUR, width: 0.45, cap: 'butt' });
      pen.segments(r.indexContours, { stroke: CONTOUR, width: 0.9, cap: 'butt' });
      pen.endGroup();
    }

    // 3. Water, its shore and ripples.
    pen.group('water');
    for (const poly of r.waterPolys) pen.polygon(poly, { fill: WATER, stroke: WATER, width: 0.8 });
    pen.segments(r.ripples, { stroke: SHORE, width: 0.35, alpha: 0.5, cap: 'butt' });
    for (const path of r.shoreLines) pen.polyline(path, { stroke: SHORE, width: 1 });
    pen.endGroup();

    // 4. Parcels and textures.
    if (z > 0.45 || z === 1) {
      pen.group('fields');
      pen.segments(r.fieldLines, { stroke: 'rgba(90, 70, 40, .45)', width: 0.4, cap: 'butt' });
      pen.segments(r.fieldEdges, { stroke: r.bocage ? 'rgba(60, 90, 45, .9)' : 'rgba(80, 60, 35, .7)', width: r.bocage ? 1.5 : 0.7, cap: 'butt' });
      pen.endGroup();
    }
    if (z > 0.8 || z === 1) {
      pen.group('textures');
      const tr = r.trees;
      if (tr) {
        for (let k = 0; k + 1 < tr.length; k += 2) {
          if (!pen.visible(tr[k] - 3, tr[k + 1] - 3, tr[k] + 3, tr[k + 1] + 3)) continue;
          pen.circle(tr[k], tr[k + 1], 1.7, { stroke: 'rgba(50, 80, 40, .75)', width: 0.5, fill: 'rgba(110, 150, 90, .35)' });
        }
      }
      pen.segments(r.orchardMarks, { stroke: 'rgba(60, 100, 50, .8)', width: 0.9, cap: 'round' });
      pen.segments(r.vineMarks, { stroke: 'rgba(110, 80, 40, .8)', width: 0.6, cap: 'butt' });
      pen.segments(r.marshMarks, { stroke: 'rgba(60, 90, 90, .7)', width: 0.5, cap: 'butt' });
      pen.endGroup();
    }

    // 5. Roads, lanes, bridge.
    pen.group('roads');
    for (const lane of state.lanes || []) pen.polyline(lane.points, { stroke: INK_SOFT, width: 0.9, dash: [4, 2.5], cap: 'butt' });
    for (const road of state.roads || []) {
      if (road.kind !== 'outward') continue;
      pen.polyline(road.points, { stroke: INK, width: 2.4 });
      pen.polyline(road.points, { stroke: PAPER_LIGHT, width: 1.2 });
    }
    if (state.bridge) {
      pen.polyline([state.bridge.a, state.bridge.b], { stroke: INK, width: 5 });
      pen.polyline([state.bridge.a, state.bridge.b], { stroke: '#fff', width: 2.2 });
    }
    pen.endGroup();

    // 6. The town: street bed, squares, blocks or houses, monuments, walls.
    pen.group('town');
    if (state.intraMuros) pen.polygon(state.intraMuros, { fill: PAPER_LIGHT });
    for (const sq of state.squares || []) pen.polygon(sq.poly, { fill: PAPER_LIGHT });
    for (const y of state.churchyards || []) pen.polygon(y.poly, { fill: '#dfe4c4', stroke: INK_SOFT, width: 0.3 });
    const detailed = z > 0.35 || z === 1;
    if (!detailed) {
      for (const b of state.blocks || []) pen.polygon(b.poly, { fill: '#5b4a3a' });
    } else {
      if (z > 2.5 || z === 1) for (const lot of state.lots || []) if (pen.visible(...polyBox(lot.poly))) pen.polygon(lot.poly, { stroke: 'rgba(90, 70, 50, .5)', width: 0.35 });
      for (const b of state.buildings || []) {
        const box = polyBox(b.poly);
        if (!pen.visible(box[0], box[1], box[2], box[3])) continue;
        pen.polygon(b.poly, { fill: INK, stroke: INK, width: 0.3 });
      }
    }
    for (const m of state.monuments || []) {
      if (m.kind === 'castle') {
        pen.polygon(m.poly, { fill: '#e8dfc8', stroke: INK, width: 2.4 });
        pen.polygon(m.keep, { fill: INK });
      } else {
        pen.polygon(m.poly, { fill: m.kind === 'halles' ? '#6d5640' : INK, stroke: INK, width: 0.4 });
      }
    }
    for (const ch of state.villageChurches || []) pen.polygon(ch.poly, { fill: INK });
    for (const e of state.extraMuros || []) {
      if (e.kind === 'quay') pen.polygon(e.poly, { fill: '#c9bea4', stroke: INK_SOFT, width: 0.6 });
      else if (e.kind === 'mill') { pen.polygon(e.poly, { fill: INK }); pen.circle(e.wheel.x, e.wheel.y, 2.4, { stroke: INK, width: 1 }); }
      else { pen.polygon(e.poly, { fill: '#e8dfc8', stroke: INK, width: 1.3 }); pen.polygon(e.church || e.chapel, { fill: INK }); if (e.cloister) pen.polygon(e.cloister, { stroke: INK, width: 1.8 }); }
    }
    for (const wall of state.walls || []) {
      const outerWall = wall.kind === 'outer';
      pen.polygon(wall.poly, { stroke: INK, width: outerWall ? 3 : 1.8 });
      for (const t of wall.towers) pen.circle(t.x, t.y, outerWall ? 2.2 : 1.6, { fill: INK });
      for (const gate of wall.gates || []) {
        const g = 3.2;
        pen.polygon([{ x: gate.x - g, y: gate.y - g }, { x: gate.x + g, y: gate.y - g }, { x: gate.x + g, y: gate.y + g }, { x: gate.x - g, y: gate.y + g }], { fill: '#fff', stroke: INK, width: 1 });
      }
    }
    pen.endGroup();

    // 7. Names.
    pen.group('names');
    const n = r.names;
    const halo = { halo: 'rgba(239, 228, 200, .85)', haloWidth: 3 };
    if (state.site && n.town) {
      const top = Math.min(...(state.walls ? state.walls.find((w) => w.kind === 'outer').poly.map((p) => p.y) : [state.site.y - 150]));
      pen.text(n.town.toUpperCase(), state.site.x, top - 18 / z, Object.assign({ size: 17, weight: 'bold', fill: INK, letterSpacing: 2.5 }, halo));
    }
    for (const v of state.villages || []) {
      if (v.kind === 'hamlet' && z < 0.8 && z !== 1) continue;
      pen.text(v.name, v.x, v.y - (v.kind === 'village' ? 14 : 10) / z, Object.assign({ size: v.kind === 'village' ? 12 : 9.5, italic: v.kind === 'hamlet', fill: INK }, halo));
    }
    for (const e of state.extraMuros || []) {
      if (!e.name || (z < 0.8 && z !== 1)) continue;
      pen.text(e.name, e.centre.x, e.centre.y + (e.kind === 'abbey' ? 28 : 14) / z, Object.assign({ size: 10, italic: true, fill: INK }, halo));
    }
    if (z > 1.2 || z === 1) {
      const labels = { castle: 'Château', halles: 'Halles', cathedral: 'Cathédrale ' + (n.cathedral || ''), church: '' };
      for (const m of state.monuments || []) if (labels[m.kind]) pen.text(labels[m.kind], m.centre.x, m.centre.y + (m.kind === 'castle' ? 14 : 12) / z, Object.assign({ size: 9, fill: INK }, halo));
      for (const sq of state.squares || []) if (sq.kind === 'market') pen.text('Marché', sq.centre.x, Math.min(...sq.poly.map((p) => p.y)) + 9 / z, Object.assign({ size: 9, fill: INK }, halo));
    }
    if (r.riverLabel) pen.textAlong(n.river, r.riverLabel, Object.assign({ size: 13, italic: true, fill: SHORE, letterSpacing: 1.5 }, halo));
    if (r.seaLabel) pen.text('LA MER', r.seaLabel.x, r.seaLabel.y, { size: 15, italic: true, fill: SHORE, letterSpacing: 4 });
    pen.endGroup();

    // 8. Cartouche and compass rose, in map units (they scale with the map).
    pen.group('cartouche');
    const cw = 560, chh = 150, cx = 24, cy = H - chh - 24;
    pen.polygon([{ x: cx, y: cy }, { x: cx + cw, y: cy }, { x: cx + cw, y: cy + chh }, { x: cx, y: cy + chh }], { fill: 'rgba(245, 237, 216, .92)', stroke: INK, width: 1.2 });
    pen.polygon([{ x: cx + 6, y: cy + 6 }, { x: cx + cw - 6, y: cy + 6 }, { x: cx + cw - 6, y: cy + chh - 6 }, { x: cx + 6, y: cy + chh - 6 }], { stroke: INK, width: 0.5 });
    const fixed = (size) => ({ size: size * z });  // sizes in map units, whatever the zoom
    pen.text('Plan de ' + n.town, cx + cw / 2, cy + 40, Object.assign({ weight: 'bold', fill: INK, letterSpacing: 1.5 * z }, fixed(26)));
    pen.text('vers 1400 — ' + r.households + ' feux, ' + (state.villages ? state.villages.filter((v) => v.kind === 'village').length : 0) + ' villages', cx + cw / 2, cy + 74, Object.assign({ italic: true, fill: INK }, fixed(15)));
    // Scale bar: 500 m.
    const bar = toU(500), bx = cx + cw / 2 - bar / 2, by = cy + 118;
    pen.polyline([{ x: bx, y: by }, { x: bx + bar, y: by }], { stroke: INK, width: 2.5 * z, cap: 'butt' });
    for (let k = 0; k <= 5; k++) pen.polyline([{ x: bx + (bar * k) / 5, y: by - 4 }, { x: bx + (bar * k) / 5, y: by + 4 }], { stroke: INK, width: 1 * z, cap: 'butt' });
    pen.text('0', bx, by - 12, Object.assign({ fill: INK }, fixed(11)));
    pen.text('500 m', bx + bar, by - 12, Object.assign({ fill: INK }, fixed(11)));
    // Compass rose, top right.
    const rx = W - 70, ry = 70, rr = 34;
    pen.circle(rx, ry, rr, { fill: 'rgba(245, 237, 216, .85)', stroke: INK, width: 0.8 * z });
    pen.polygon([{ x: rx, y: ry - rr + 4 }, { x: rx + 6, y: ry }, { x: rx, y: ry + rr - 4 }, { x: rx - 6, y: ry }], { stroke: INK, width: 0.8 * z });
    pen.polygon([{ x: rx, y: ry - rr + 4 }, { x: rx + 6, y: ry }, { x: rx, y: ry }], { fill: INK });
    pen.polyline([{ x: rx - rr + 4, y: ry }, { x: rx + rr - 4, y: ry }], { stroke: INK, width: 0.6 * z });
    pen.text('N', rx, ry - rr - 9, Object.assign({ weight: 'bold', fill: INK }, fixed(11)));
    pen.endGroup();
  }

  /** Everything the drawing needs that is worth preparing once. */
  function prepare(state, s, rng, ctx) {
    const W = ctx.width, H = ctx.height, toU = U().toUnits;
    const pitch = state.fieldPitch || 2;
    const F = (name) => global.Fields.get(state, name, pitch, ctx);
    const water = F('water'), terrain = F('terrain');
    const r = {};

    // Names.
    const names = global.Names.create(rng);
    const river = names.river();
    r.names = { river: river, town: names.town(river), cathedral: 'Saint-' + names.saint() };
    for (const v of state.villages || []) v.name = v.kind === 'village' ? names.village() : names.hamlet();
    for (const e of state.extraMuros || []) e.name = e.kind === 'abbey' ? names.abbey() : e.kind === 'leper' ? 'Maladrerie' : e.kind === 'mill' ? 'Moulin' : e.kind === 'quay' ? 'Port' : null;

    // Contours, on the land only.
    const skip = (k) => water.data[k] >= 0.5;
    r.contours = []; r.indexContours = [];
    if (s.contours !== 'none') {
      const stride = 2;
      const [lo, hi] = terrain.minMax();
      for (let level = Math.ceil(lo / s.interval) * s.interval; level <= hi; level += s.interval) {
        if (level <= 0) continue;
        const segs = isolines(terrain, level, stride, skip);
        if (level % s.indexEvery === 0) r.indexContours.push(...segs); else r.contours.push(...segs);
      }
      r.contours = Float32Array.from(r.contours);
      r.indexContours = Float32Array.from(r.indexContours);
    }

    // Water polygons (sea and river cells), shore lines, ripples (isolines of the distance to land, in the water).
    r.waterPolys = state.cells.filter((c) => (c.sea || c.river !== undefined) && c.poly.length >= 3).map((c) => c.poly);
    r.shoreLines = [];
    if (state.shore) {
      for (const [a, b] of state.shore) r.shoreLines.push([state.nodes[a], state.nodes[b]]);
    } else if (state.coastPaths) {
      for (const path of state.coastPaths) r.shoreLines.push(path.points);
    }
    const toLand = global.Fields.distanceTo(water, (v) => v < 0.5);
    const ripples = [];
    for (const d of [5, 11, 19]) ripples.push(...isolines(toLand, d, 2, (k) => water.data[k] < 0.5));
    r.ripples = Float32Array.from(ripples);

    // Land tints for the drawing, and texture marks from the land-use raster.
    const use = state.landUse;
    r.bocage = state.fieldSystem === 'bocage';
    if (use) {
      const cv = document.createElement('canvas');
      cv.width = use.w; cv.height = use.h;
      const g = cv.getContext('2d'), img = g.createImageData(use.w, use.h);
      const tint = { 3: [207, 217, 184, 255], 7: [227, 233, 204, 220], 2: [217, 226, 212, 200], 4: [232, 236, 210, 170], 5: [228, 234, 206, 170], 6: [235, 228, 200, 170], 8: [236, 230, 205, 150] };
      const trees = [], orchard = [], vine = [], marsh = [];
      const p = use.pitch;
      for (let j = 0, k = 0, q = 0; j < use.h; j++) {
        for (let i = 0; i < use.w; i++, k++, q += 4) {
          const c = use.data[k], t = tint[c];
          if (t) { img.data[q] = t[0]; img.data[q + 1] = t[1]; img.data[q + 2] = t[2]; img.data[q + 3] = t[3]; }
          const x = (i + 0.5) * p, y = (j + 0.5) * p;
          if (c === 3 && hash(i, j, 1) < s.trees) trees.push(x + (hash(i, j, 2) - 0.5) * p, y + (hash(i, j, 3) - 0.5) * p);
          else if (c === 5 && (i + j) % 2 === 0) orchard.push(x, y, x + 0.01, y);
          else if (c === 6 && j % 2 === 0) vine.push(x - 1.3, y, x + 1.3, y);
          else if (c === 2 && hash(i, j, 4) < 0.35) marsh.push(x - 1.5, y, x + 1.5, y, x - 0.6, y - 1, x - 0.6, y + 0.01, x + 0.6, y - 1, x + 0.6, y + 0.01);
        }
      }
      g.putImageData(img, 0, 0);
      r.landImage = cv;
      r.trees = Float32Array.from(trees);
      r.orchardMarks = Float32Array.from(orchard);
      r.vineMarks = Float32Array.from(vine);
      r.marshMarks = Float32Array.from(marsh);
    }

    // Where the river's and the sea's names go.
    const fleuve = (state.rivers || []).find((x) => x.kind === 'fleuve');
    if (fleuve && fleuve.centerline && fleuve.centerline.length > 20) {
      const cl = fleuve.centerline, n = cl.length;
      r.riverLabel = cl.slice(Math.floor(n * 0.3), Math.floor(n * 0.6));
    }
    if (state.cells.some((c) => c.sea)) {
      let best = -1, bk = -1;
      const sea = F('sea');
      // The widest open water, but not against the map's edge.
      for (let k = 0; k < toLand.data.length; k++) {
        if (sea.data[k] < 0.5) continue;
        const x = ((k % toLand.w) + 0.5) * toLand.pitch, y = (Math.floor(k / toLand.w) + 0.5) * toLand.pitch;
        const v = Math.min(toLand.data[k], x, y, W - x, H - y);
        if (v > best) { best = v; bk = k; }
      }
      if (bk >= 0) r.seaLabel = { x: ((bk % toLand.w) + 0.5) * toLand.pitch, y: (Math.floor(bk / toLand.w) + 0.5) * toLand.pitch };
    }
    // The parcels' segments, flat for the pen.
    const flat = (list) => { const out = new Float32Array((list || []).length * 4); (list || []).forEach((sg, i) => { out[i * 4] = sg[0]; out[i * 4 + 1] = sg[1]; out[i * 4 + 2] = sg[2]; out[i * 4 + 3] = sg[3]; }); return out; };
    r.fieldLines = flat(state.fieldLines);
    r.fieldEdges = flat(state.fieldEdges);
    r.households = (state.buildings || []).length;
    return r;
  }

  global.RenderStep = {
    id: 'render',
    title: 'Drawing',
    exclusive: true,   // shown, it replaces every other layer
    defaultVisible: false,
    settings: [
      { key: 'contours', label: 'Contour lines', type: 'select', default: 'lines', options: [{ value: 'lines', label: 'Lines' }, { value: 'none', label: 'None' }] },
      { key: 'interval', label: 'Contour interval (m)', type: 'range', min: 5, max: 50, step: 5, default: 10 },
      { key: 'indexEvery', label: 'Index contour every (m)', type: 'range', min: 20, max: 200, step: 10, default: 50 },
      { key: 'trees', label: 'Tree symbols density', type: 'range', min: 0, max: 1, step: 0.05, default: 0.45 },
      { key: 'exportSvg', label: 'Export SVG', type: 'button', action: 'exportSvg' }
    ],

    run(state, s, rng, ctx) {
      const t0 = performance.now();
      state.render = prepare(state, s, rng, ctx);
      const r = state.render;
      return 'Plan de ' + r.names.town + ' — ' + (r.contours.length / 4 + r.indexContours.length / 4) + ' contour segments, ' + (r.trees ? r.trees.length / 2 : 0) + ' trees, ' +
        Math.round(performance.now() - t0) + ' ms. Tick the box to show the drawing.';
    },

    draw(g, state, ctx) {
      const pen = new global.Pen.CanvasPen(g, ctx);
      drawAll(pen, state, ctx.settings || {}, ctx);
    },

    /** The whole map as an SVG document, one unit per px. */
    exportSvg(state, s, ctx) {
      const pen = new global.Pen.SvgPen(ctx.width, ctx.height);
      drawAll(pen, state, s, ctx);
      return pen.toString();
    }
  };
})(window);
