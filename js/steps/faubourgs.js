// Step 21 — faubourgs: outside the gates, the town runs on along the roads
// as ribbons — strip lots on both sides, wider and sparser with the distance,
// detached houses with long gardens. Then what belongs outside the walls:
// the quay at the foot of the bridge, mills downstream, an abbey at the end
// of the longest faubourg, a leper house far out on another road. The lots
// and houses join the town's (new lists: earlier steps' data is never altered).
(function (global) {
  'use strict';

  const U = () => global.Units;
  const RAYS = 72;

  function starRadius(wall, theta) {
    const t = (((theta / (2 * Math.PI)) * RAYS) % RAYS + RAYS) % RAYS;
    const k = Math.floor(t), f = t - k;
    return wall.poly[k % RAYS].r * (1 - f) + wall.poly[(k + 1) % RAYS].r * f;
  }
  function depth(wall, p) {
    const dx = p.x - wall.centre.x, dy = p.y - wall.centre.y;
    return starRadius(wall, Math.atan2(dy, dx)) - Math.hypot(dx, dy);
  }

  /** A polyline with cumulative lengths: point and unit tangent at a distance s along it. */
  function walker(pts) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const length = cum[cum.length - 1];
    const at = (s) => {
      s = Math.max(0, Math.min(length, s));
      let i = 1;
      while (i < cum.length - 1 && cum[i] < s) i++;
      const a = pts[i - 1], b = pts[i], l = cum[i] - cum[i - 1] || 1, t = (s - cum[i - 1]) / l;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, tx: (b.x - a.x) / l, ty: (b.y - a.y) / l };
    };
    return { length: length, at: at };
  }

  function clipHalf(poly, nx, ny, c) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const fp = nx * p.x + ny * p.y - c, fq = nx * q.x + ny * q.y - c;
      if (fp <= 0) out.push(p);
      if ((fp <= 0) !== (fq <= 0)) { const t = fp / (fp - fq); out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }); }
    }
    return out;
  }

  function polygonArea(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y; }
    return Math.abs(a) / 2;
  }

  /** Is a quad convex (all turns the same way)? */
  function convex(poly) {
    let sign = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], c = poly[(i + 2) % poly.length];
      const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(z) < 1e-9) continue;
      if (sign === 0) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
    }
    return true;
  }

  function distToPolyline(p, pts) {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0;
      best = Math.min(best, Math.hypot(p.x - a.x - vx * t, p.y - a.y - vy * t));
    }
    return best;
  }

  /** Axis-aligned rectangle (local east/south axes rotated by `ang`) around (cx, cy). */
  function rect(cx, cy, w, h, ang) {
    const ex = Math.cos(ang), ey = Math.sin(ang), nx = -ey, ny = ex;
    return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([u, v]) => ({ x: cx + ex * u + nx * v, y: cy + ey * u + ny * v }));
  }

  global.FaubourgsStep = {
    id: 'faubourgs',
    title: 'Faubourgs',
    zIndex: 5.36,
    settings: [
      { key: 'length', label: 'Ribbon length past the gate (m)', type: 'range', min: 100, max: 1000, step: 25, default: 400 },
      { key: 'frontNear', label: 'Frontage near the gate (m)', type: 'range', min: 5, max: 20, step: 0.5, default: 9 },
      { key: 'frontFar', label: 'Frontage at the end (m)', type: 'range', min: 5, max: 30, step: 0.5, default: 15 },
      { key: 'lotDepth', label: 'Lot depth (m)', type: 'range', min: 15, max: 100, step: 5, default: 45 },
      { key: 'fullBuilt', label: 'Fully built share of the ribbon', type: 'range', min: 0, max: 1, step: 0.05, default: 0.4 }
    ],

    run(state, s, rng, ctx) {
      const t0 = performance.now();
      state.extraMuros = null;
      if (!state.roads || !state.walls || !state.lots) return 'No roads: no faubourgs.';
      const toU = U().toUnits;
      const pitch = state.fieldPitch || 2;
      const F = (name) => global.Fields.get(state, name, pitch, ctx);
      const water = F('water'), slope = F('terrainSlope'), waterDist = F('waterDistance');
      const outer = state.walls.find((x) => x.kind === 'outer');
      const site = state.site;
      const W = ctx.width, H = ctx.height;
      const Lf = toU(s.length), D = toU(s.lotDepth);
      const outward = state.roads.filter((r) => r.kind === 'outward');
      const others = (road) => outward.filter((r) => r !== road).map((r) => r.points);
      const onLand = (p) => p.x > 0 && p.y > 0 && p.x < W && p.y < H && water.at(p.x, p.y) < 0.5;
      const rejected = { water: 0, wall: 0, slope: 0, bridge: 0, road: 0, shape: 0 };
      const buildable = (poly, road) => {
        const c = global.polygonCentroid(poly);
        if (!convex(poly)) { rejected.shape++; return false; }
        if (!poly.every(onLand) || !onLand(c)) { rejected.water++; return false; }
        if (poly.some((p) => depth(outer, p) > -4)) { rejected.wall++; return false; }  // inside or on the wall
        if (slope.at(c.x, c.y) > 0.3) { rejected.slope++; return false; }
        if (state.bridge && (distToPolyline(c, [state.bridge.a, state.bridge.b]) < 10)) { rejected.bridge++; return false; }
        for (const pts of others(road)) if (poly.some((p) => distToPolyline(p, pts) < 4)) { rejected.road++; return false; }
        return true;
      };

      const newLots = [], newHouses = [], ribbons = [];
      for (const road of outward) {
        // The ribbon starts 15 m past the wall (the glacis) — past the bridge for the bridge road.
        const walk = walker(road.points);
        let s0 = 0;
        while (s0 < walk.length && depth(outer, walk.at(s0)) > -toU(15)) s0 += 2;
        if (road.gate.kind === 'bridge' && state.bridge) {
          while (s0 < walk.length && distToPolyline(walk.at(s0), [state.bridge.a, state.bridge.b]) < toU(12)) s0 += 2;
        }
        const roadHalf = toU(4);
        const ribbon = { road: road, lots: 0 };
        for (const side of [-1, 1]) {
          let sPos = s0;
          while (sPos < Math.min(walk.length - 4, s0 + Lf)) {
            const t = (sPos - s0) / Lf;
            const w = toU(s.frontNear + (s.frontFar - s.frontNear) * t) * (1 + 0.25 * rng.range(-1, 1));
            const a = walk.at(sPos), b = walk.at(sPos + w);
            const na = { x: -a.ty * side, y: a.tx * side }, nb = { x: -b.ty * side, y: b.tx * side };
            const d = D * (1 + 0.3 * rng.range(-1, 1));
            const poly = [
              { x: a.x + na.x * roadHalf, y: a.y + na.y * roadHalf }, { x: b.x + nb.x * roadHalf, y: b.y + nb.y * roadHalf },
              { x: b.x + nb.x * (roadHalf + d), y: b.y + nb.y * (roadHalf + d) }, { x: a.x + na.x * (roadHalf + d), y: a.y + na.y * (roadHalf + d) }
            ];
            sPos += w;
            // Built? Always in the first part of the ribbon, then less and less.
            const built = t < s.fullBuilt || rng.random() < (1 - t) / (1 - s.fullBuilt);
            if (!built || !buildable(poly, road)) continue;
            const front = { x: (poly[0].x + poly[1].x) / 2, y: (poly[0].y + poly[1].y) / 2 };
            const along = { x: (b.x - a.x) / (Math.hypot(b.x - a.x, b.y - a.y) || 1), y: (b.y - a.y) / (Math.hypot(b.x - a.x, b.y - a.y) || 1) };
            const inward = { x: (na.x + nb.x) / 2, y: (na.y + nb.y) / 2 };
            const lot = { poly: poly, block: -1, edge: -1, street: 'road', width: w, front: front, inward: inward, along: along, depth: d, zone: 1 + t, faubourg: true };
            newLots.push(lot);
            ribbon.lots++;
            // The house: at the front, a share of the frontage (detached), 8–11 m deep.
            const share = 0.95 - 0.45 * t;
            const hw = w * Math.min(1, share * (1 + 0.15 * rng.range(-1, 1)));
            const hd = Math.min(d, toU(8 + 3 * rng.random()));
            let house = clipHalf(poly, inward.x, inward.y, inward.x * front.x + inward.y * front.y + hd);
            const ea = along.x * front.x + along.y * front.y;
            house = clipHalf(house, -along.x, -along.y, -(ea - hw / 2));
            house = clipHalf(house, along.x, along.y, ea + hw / 2);
            if (house.length >= 3 && polygonArea(house) > 3) {
              newHouses.push({ poly: house, lot: lot, floors: rng.random() < 0.7 ? 1 : 2, height: 3.2 * (rng.random() < 0.7 ? 1 : 2), roof: rng.random() < 0.5 ? 'ridge' : 'gable', depth: hd });
            }
          }
        }
        ribbons.push(ribbon);
      }

      // ---------- Outside the walls ----------
      const extra = [];
      const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
      const clearOf = (poly) => poly.every((p) => onLand(p) && depth(outer, p) < -4 && slope.at(p.x, p.y) < 0.25) &&
        !newLots.some((l) => l.poly.some((q) => global.polygonInside(poly, q))) && !outward.some((r) => poly.some((p) => distToPolyline(p, r.points) < 6));

      // The quay: along the bank at the foot of the bridge, on the town's side, 50 m either way.
      if (state.bridge && site && site.toWater) {
        const ax = -site.toWater.y, ay = site.toWater.x;  // along the course
        const bank = [];
        for (let off = -toU(50); off <= toU(50); off += 4) {
          // From a point well on land, march towards the water to find its edge.
          let p = { x: state.bridge.a.x + ax * off - site.toWater.x * 20, y: state.bridge.a.y + ay * off - site.toWater.y * 20 };
          let found = null;
          for (let r = 0; r < 60; r += 1) {
            const q = { x: p.x + site.toWater.x * r, y: p.y + site.toWater.y * r };
            if (!(q.x > 0 && q.y > 0 && q.x < W && q.y < H)) break;
            if (water.at(q.x, q.y) >= 0.5) { found = { x: p.x + site.toWater.x * (r - 1), y: p.y + site.toWater.y * (r - 1) }; break; }
          }
          if (found) bank.push(found);
        }
        if (bank.length > 4) {
          const inland = bank.map((p) => ({ x: p.x - site.toWater.x * toU(10), y: p.y - site.toWater.y * toU(10) })).reverse();
          extra.push({ kind: 'quay', poly: bank.concat(inland), centre: global.polygonCentroid(bank.concat(inland)) });
        }
      }

      // Mills: on the bank downstream of the bridge, the first on the town's side, the next on the other.
      const fleuve = (state.rivers || []).find((r) => r.kind === 'fleuve');
      if (fleuve && fleuve.centerline && state.bridge) {
        const cl = fleuve.centerline;
        let k0 = 0, bd = Infinity;
        cl.forEach((p, k) => { const d = dist(p, state.bridge.a); if (d < bd) { bd = d; k0 = k; } });
        const cw = walker(cl.slice(k0));
        [[toU(150), 1], [toU(300), -1]].forEach(([along, which]) => {
          if (along > cw.length - 10) return;
          const p = cw.at(along);
          const nx = -p.ty, ny = p.tx;
          // Which side is the town's? The one whose normal points towards the site.
          const townSide = (site.x - p.x) * nx + (site.y - p.y) * ny > 0 ? 1 : -1;
          const sideSign = townSide * which;
          for (let r = 4; r < 80; r += 1) {
            const q = { x: p.x + nx * sideSign * r, y: p.y + ny * sideSign * r };
            if (!onLand(q)) continue;
            // The mill sits on the bank (it may stand under the wall); its wheel is in the water.
            const c = { x: q.x + nx * sideSign * 5, y: q.y + ny * sideSign * 5 };
            const poly = rect(c.x, c.y, toU(12), toU(8), Math.atan2(p.ty, p.tx));
            const free = poly.every((v) => onLand(v) && depth(outer, v) < 1) && !newLots.some((l) => l.poly.some((v) => global.polygonInside(poly, v))) &&
              !outward.some((rd) => poly.some((v) => distToPolyline(v, rd.points) < 5));
            if (free) extra.push({ kind: 'mill', poly: poly, centre: c, wheel: { x: q.x - nx * sideSign * 1.5, y: q.y - ny * sideSign * 1.5 } });
            break;
          }
        });
      }

      // The abbey at the end of the longest ribbon, off the road; the leper house far out on another road.
      const byLots = ribbons.slice().sort((a, b) => b.lots - a.lots);
      const placeOff = (road, sFrom, offs, w, h, make) => {
        const walk = walker(road.points);
        for (const sAt of [sFrom, sFrom + toU(80), sFrom + toU(160)]) {
          if (sAt > walk.length - 10) break;
          const p = walk.at(sAt);
          for (const side of [1, -1]) {
            const c = { x: p.x - p.ty * side * offs, y: p.y + p.tx * side * offs };
            const enclosure = rect(c.x, c.y, w, h, 0);
            if (clearOf(enclosure)) { make(c, enclosure); return true; }
          }
        }
        return false;
      };
      if (byLots[0]) {
        const walk0 = walker(byLots[0].road.points);
        let s0 = 0;
        while (s0 < walk0.length && depth(outer, walk0.at(s0)) > -toU(15)) s0 += 2;
        placeOff(byLots[0].road, s0 + Lf + toU(60), toU(90), toU(120), toU(100), (c, enclosure) => {
          const L = toU(45);
          const church = global.churchPolygon(c.x, c.y - toU(15), L, L * 0.32, L * 0.6);
          const cloister = rect(c.x - toU(4), c.y + toU(12), toU(28), toU(28), 0);
          extra.push({ kind: 'abbey', poly: enclosure, church: church, cloister: cloister, centre: c });
        });
      }
      const other = byLots.find((r) => byLots[0] && r.road !== byLots[0].road) || byLots[1];
      if (other) {
        const walk1 = walker(other.road.points);
        let s1 = 0;
        while (s1 < walk1.length && depth(outer, walk1.at(s1)) > -toU(15)) s1 += 2;
        placeOff(other.road, s1 + Lf + toU(250), toU(40), toU(36), toU(30), (c, enclosure) => {
          extra.push({ kind: 'leper', poly: enclosure, chapel: global.churchPolygon(c.x, c.y, toU(14), toU(5), toU(7)), centre: c });
        });
      }

      state.lots = state.lots.concat(newLots);
      state.buildings = state.buildings.concat(newHouses);
      state.extraMuros = extra;
      const kinds = extra.map((e) => e.kind).filter((k, i, a) => a.indexOf(k) === i).map((k) => extra.filter((e) => e.kind === k).length + ' ' + k);
      const rej = Object.keys(rejected).filter((k) => rejected[k]).map((k) => rejected[k] + ' ' + k).join(', ');
      return ribbons.length + ' ribbons, ' + newLots.length + ' lots and ' + newHouses.length + ' houses outside the walls' + (rej ? ' (lots refused: ' + rej + ')' : '') + '; ' +
        (kinds.join(', ') || 'nothing else') + ', ' + Math.round(performance.now() - t0) + ' ms';
    },

    draw(g, state, ctx) {
      const px = (ctx && ctx.px) || 1;
      if (!state.extraMuros) return;
      g.save();
      g.lineJoin = 'round';
      const poly = (pts) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); };
      for (const e of state.extraMuros) {
        if (e.kind === 'quay') {
          g.fillStyle = '#b9ab8e'; g.strokeStyle = '#5a4632'; g.lineWidth = 0.8 * px;
          poly(e.poly); g.fill(); g.stroke();
        } else if (e.kind === 'mill') {
          g.fillStyle = '#2b2017';
          poly(e.poly); g.fill();
          g.strokeStyle = '#2b2017'; g.lineWidth = 1.2 * px;
          g.beginPath(); g.arc(e.wheel.x, e.wheel.y, 2.4, 0, Math.PI * 2); g.stroke();
        } else if (e.kind === 'abbey' || e.kind === 'leper') {
          g.fillStyle = '#e4dcc4'; g.strokeStyle = '#2b2017'; g.lineWidth = 1.5 * px;
          poly(e.poly); g.fill(); g.stroke();
          g.fillStyle = '#2b2017';
          poly(e.church || e.chapel); g.fill();
          if (e.cloister) { g.strokeStyle = '#2b2017'; g.lineWidth = 2 * px; poly(e.cloister); g.stroke(); }
        }
      }
      if (ctx.scale > 1.2) {
        const names = { quay: 'Port', mill: 'Moulin', abbey: 'Abbaye', leper: 'Léproserie' };
        g.font = (11 * px) + 'px Georgia, serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = '#2b2017'; g.strokeStyle = 'rgba(243, 234, 214, .85)'; g.lineWidth = 3 * px;
        for (const e of state.extraMuros) {
          const y = e.centre.y + (e.kind === 'abbey' ? 28 : e.kind === 'leper' ? 12 : 8) * px;
          g.strokeText(names[e.kind], e.centre.x, y);
          g.fillText(names[e.kind], e.centre.x, y);
        }
      }
      g.restore();
    }
  };
})(window);
