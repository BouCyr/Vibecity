// Step 22 — villages, hamlets and lanes: the countryside's settlements. Sites
// are scored like the town's (flat ground, a stream nearby, a road nearby,
// 1–2.8 km from the town), villages first, then hamlets between them; each
// is joined to the road network by a lane found as a cheapest path, and the
// houses line that lane as a short ribbon, a church beside it for a village.
(function (global) {
  'use strict';

  const U = () => global.Units;
  const PITCH = 8;

  global.VillagesStep = {
    id: 'villages',
    title: 'Villages and lanes',
    zIndex: 5.34,
    settings: [
      { key: 'villages', label: 'Villages', type: 'range', min: 0, max: 8, step: 1, default: 4 },
      { key: 'hamlets', label: 'Hamlets', type: 'range', min: 0, max: 12, step: 1, default: 6 },
      { key: 'villageGap', label: 'Minimum distance between villages (m)', type: 'range', min: 400, max: 1500, step: 50, default: 900 },
      { key: 'villageLength', label: 'Village street length (m)', type: 'range', min: 60, max: 400, step: 10, default: 160 }
    ],

    run(state, s, rng, ctx) {
      const t0 = performance.now();
      state.villages = null; state.lanes = null;
      if (!state.site || !state.walls || !state.roads || !state.lots) return 'No town: no villages.';
      const toU = U().toUnits, W = ctx.width, H = ctx.height;
      const pitch = state.fieldPitch || 2;
      const F = (name) => global.Fields.get(state, name, pitch, ctx);
      const water = F('water'), sea = F('sea'), slope = F('terrainSlope'), waterDist = F('waterDistance'), marsh = state.marsh;
      const outer = state.walls.find((x) => x.kind === 'outer');
      const site = state.site;
      const outward = state.roads.filter((r) => r.kind === 'outward');
      const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
      const clamp01 = (v) => Math.max(0, Math.min(1, v));
      const smooth = (v, a, b) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
      const plateau = (v, a, b, c, d) => (v < b ? smooth(v, a, b) : 1 - smooth(v, c, d));
      const distToPolyline = (p, pts) => {
        let best = Infinity;
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i], b = pts[i + 1], vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0;
          best = Math.min(best, Math.hypot(p.x - a.x - vx * t, p.y - a.y - vy * t));
        }
        return best;
      };
      const onLand = (p) => p.x > 0 && p.y > 0 && p.x < W && p.y < H && water.at(p.x, p.y) < 0.5;
      const keepAway = (state.extraMuros || []).filter((e) => e.kind === 'abbey' || e.kind === 'leper').map((e) => e.centre);

      // ---------- Sites ----------
      const ring = (r, n) => Array.from({ length: n }, (_, k) => ({ x: r * Math.cos((2 * Math.PI * k) / n), y: r * Math.sin((2 * Math.PI * k) / n) }));
      const disc = [{ x: 0, y: 0 }].concat(ring(25, 8));
      const roadDist = (p) => Math.min(Infinity, ...outward.map((r) => distToPolyline(p, r.points)));
      const scoreAt = (x, y) => {
        const p = { x: x, y: y };
        if (!onLand(p)) return -1;
        const dCity = dist(p, site);
        if (dCity < toU(1000) || dCity > toU(2800)) return -1;
        if (x < toU(300) || y < toU(300) || x > W - toU(300) || y > H - toU(300)) return -1;
        if (global.wallDepthOf(outer, p) > -toU(200)) return -1;
        if (keepAway.some((q) => dist(p, q) < toU(250))) return -1;
        let sl = 0, land = 0;
        for (const o of disc) { sl += slope.at(x + o.x, y + o.y); if (water.at(x + o.x, y + o.y) < 0.5) land++; }
        if (land < disc.length) return -1;
        const flat = 1 - clamp01(sl / disc.length / 0.15);
        const stream = plateau(waterDist.at(x, y), 8, 30, 200, 600);
        const road = 1 - clamp01(roadDist(p) / toU(400));
        return 1.5 * flat + stream + road + (marsh && marsh.at(x, y) >= 0.5 ? -1 : 0);
      };
      const candidates = [];
      const STEP = 20;
      for (let y = STEP / 2; y < H; y += STEP) for (let x = STEP / 2; x < W; x += STEP) {
        const v = scoreAt(x, y);
        if (v > 0) candidates.push({ x: x, y: y, score: v + 0.1 * rng.random() });
      }
      candidates.sort((a, b) => b.score - a.score);
      const villages = [];
      const pick = (kind, count, gapOthers, gapSame) => {
        let n = 0;
        for (const c of candidates) {
          if (n >= count) break;
          if (villages.some((v) => dist(v, c) < (v.kind === kind ? gapSame : gapOthers))) continue;
          villages.push({ x: c.x, y: c.y, kind: kind, score: c.score });
          n++;
        }
      };
      pick('village', s.villages, toU(s.villageGap), toU(s.villageGap));
      pick('hamlet', s.hamlets, toU(500), toU(500));

      // ---------- Lanes: cheapest paths to the road network ----------
      const gw = Math.ceil(W / PITCH), gh = Math.ceil(H / PITCH);
      const cellOf = (p) => Math.min(gh - 1, Math.max(0, Math.floor(p.y / PITCH))) * gw + Math.min(gw - 1, Math.max(0, Math.floor(p.x / PITCH)));
      const centre = (k) => ({ x: ((k % gw) + 0.5) * PITCH, y: (Math.floor(k / gw) + 0.5) * PITCH });
      const cost = new Float64Array(gw * gh);
      const network = new Uint8Array(gw * gh);
      for (let k = 0; k < cost.length; k++) {
        const p = centre(k);
        if (sea.at(p.x, p.y) >= 0.5 || global.wallDepthOf(outer, p) > 2) { cost[k] = Infinity; continue; }
        // A lane may ford a river, at a price (25 per unit: a 50 m river costs as much as 500 m of flat ground).
        if (water.at(p.x, p.y) >= 0.5) { cost[k] = 25; continue; }
        cost[k] = 1 + 8 * slope.at(p.x, p.y);
        if (marsh && marsh.at(p.x, p.y) >= 0.5) cost[k] *= 2.5;
      }
      const markLine = (pts, c) => {
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i], b = pts[i + 1], n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (PITCH / 2));
          for (let t = 0; t <= n; t++) { const k = cellOf({ x: a.x + ((b.x - a.x) * t) / n, y: a.y + ((b.y - a.y) * t) / n }); network[k] = 1; cost[k] = Math.min(cost[k], c); }
        }
      };
      for (const r of outward) markLine(r.points, 0.5);
      if (state.bridge) markLine([state.bridge.a, state.bridge.b], 0.5);
      const lanes = [];
      let unjoined = 0;
      villages.sort((a, b) => dist(a, site) - dist(b, site));
      for (const v of villages) {
        const path = global.Routing.route(cost, gw, gh, cellOf(v), (k) => network[k] === 1, -1);
        if (!path) { unjoined++; continue; }
        const pts = path.map(centre);
        pts[0] = { x: v.x, y: v.y };
        const fords = pts.filter((p) => water.at(p.x, p.y) >= 0.5).length;
        const lane = { kind: v.kind, points: global.Routing.smoothPolyline(pts), from: v, ford: fords > 0 };
        lanes.push(lane);
        v.lane = lane;
        markLine(lane.points, 0.5);
      }

      // ---------- Houses along the lane, a church for a village ----------
      const newLots = [], newHouses = [], churches = [];
      const allLanes = () => lanes.map((l) => l.points).concat(outward.map((r) => r.points));
      for (const v of villages) {
        if (!v.lane) continue;
        const walk = global.polylineWalker(v.lane.points);
        const isVillage = v.kind === 'village';
        const length = toU(isVillage ? s.villageLength : 70);
        const buildable = (poly) => {
          const c = global.polygonCentroid(poly);
          if (!poly.every(onLand) || !onLand(c)) return false;
          if (slope.at(c.x, c.y) > 0.3) return false;
          if (poly.some((p) => global.wallDepthOf(outer, p) > -4)) return false;
          if (churches.some((ch) => ch.poly.some((q) => global.polygonInside(poly, q)) || poly.some((q) => global.polygonInside(ch.poly, q)))) return false;
          for (const pts of allLanes()) if (pts !== v.lane.points && poly.some((p) => distToPolyline(p, pts) < 4)) return false;
          if (newLots.some((l) => l.village !== v && l.poly.some((q) => global.polygonInside(poly, q)))) return false;
          return true;
        };
        if (isVillage) {
          // The church beside the lane, 15 m in, on the side with land; the chevet to the east.
          const p = walk.at(toU(15));
          for (const side of [1, -1]) {
            const c = { x: p.x - p.ty * side * toU(16), y: p.y + p.tx * side * toU(16) };
            const poly = global.churchPolygon(c.x, c.y, toU(20), toU(7), toU(12));
            if (poly.every(onLand) && slope.at(c.x, c.y) < 0.3) { churches.push({ kind: 'village-church', poly: poly, centre: c, village: v }); v.church = c; break; }
          }
        }
        const made = global.layRibbon(walk, toU(isVillage ? 6 : 4), length, toU(2.5),
          { frontNear: toU(10), frontFar: toU(14), depth: toU(30), fullBuilt: isVillage ? 0.7 : 0.5, zone: 2 }, rng, buildable);
        for (const lot of made.lots) { lot.village = v; newLots.push(lot); }
        for (const h of made.houses) newHouses.push(h);
        v.houses = made.houses.length;
      }

      state.villages = villages;
      state.lanes = lanes;
      state.villageChurches = churches;
      state.lots = state.lots.concat(newLots);
      state.buildings = state.buildings.concat(newHouses);
      const nV = villages.filter((v) => v.kind === 'village').length, nH = villages.length - nV;
      const fords = lanes.filter((l) => l.ford).length;
      return nV + ' villages (' + churches.length + ' churches) and ' + nH + ' hamlets, ' + newHouses.length + ' houses, ' + lanes.length + ' lanes' + (fords ? ' (' + fords + ' with a ford)' : '') +
        (unjoined ? ' (' + unjoined + ' could not be joined to a road)' : '') + ', ' + Math.round(performance.now() - t0) + ' ms';
    },

    draw(g, state, ctx) {
      const px = (ctx && ctx.px) || 1;
      if (!state.lanes) return;
      g.save();
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.strokeStyle = '#7a5a3a';
      g.lineWidth = 1.2 * px;
      g.setLineDash([]);
      for (const lane of state.lanes) {
        g.beginPath();
        lane.points.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.stroke();
      }
      g.fillStyle = '#2b2017';
      for (const ch of state.villageChurches || []) {
        g.beginPath();
        ch.poly.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
        g.fill();
      }
      g.restore();
    }
  };
})(window);
