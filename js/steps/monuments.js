// Step 20 — squares and monuments: the castle on the block nearest the core,
// the market square (a hollowed block on a main street, with the halles in
// the middle), the cathedral on the largest block of the old core that can
// hold it, and a parish church per quarter, spread out. Every church has its
// nave west–east, the chevet to the east. The lots and houses a monument
// displaces are removed (new lists: earlier steps' data is never altered);
// a church's displaced lots become its churchyard.
(function (global) {
  'use strict';

  const U = () => global.Units;

  function polygonArea(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y; }
    return Math.abs(a) / 2;
  }

  /** Point in a simple polygon (even–odd). */
  function inside(poly, p) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < a.x + ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y)) c = !c;
    }
    return c;
  }

  /** Is every point of `pts` at least `margin` inside the convex polygon? */
  function fitsIn(convex, pts, margin) {
    const c = global.polygonCentroid(convex);
    for (let i = 0; i < convex.length; i++) {
      const a = convex[i], b = convex[(i + 1) % convex.length];
      let nx = -(b.y - a.y), ny = b.x - a.x;
      const l = Math.hypot(nx, ny) || 1;
      nx /= l; ny /= l;
      if ((c.x - a.x) * nx + (c.y - a.y) * ny < 0) { nx = -nx; ny = -ny; }
      for (const p of pts) if ((p.x - a.x) * nx + (p.y - a.y) * ny < margin) return false;
    }
    return true;
  }

  function segmentsCross(a, b, c, d) {
    const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
  }

  /** Do two simple polygons overlap (a vertex of one inside the other, or crossing edges)? */
  function overlap(A, B) {
    if (A.some((p) => inside(B, p)) || B.some((p) => inside(A, p))) return true;
    for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) {
      if (segmentsCross(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return true;
    }
    return false;
  }

  /** Polygon grown by `m` units (vertices pushed away from the centroid; enough for a margin test). */
  function grown(poly, m) {
    const c = global.polygonCentroid(poly);
    return poly.map((p) => { const dx = p.x - c.x, dy = p.y - c.y, l = Math.hypot(dx, dy) || 1; return { x: p.x + (dx / l) * m, y: p.y + (dy / l) * m }; });
  }

  /**
   * Footprint of a church: nave of length L and width w from the façade
   * (west) to the apse (east), a transept of width T across at 62 % of the
   * length. Local x runs east, y south; placed with its centre at (cx, cy).
   */
  function churchPolygon(cx, cy, L, w, T) {
    const a = w / 2, tw = w * 0.9, x0 = 0.62 * L - tw / 2, x1 = 0.62 * L + tw / 2;
    const pts = [[0, -a], [x0, -a], [x0, -T / 2], [x1, -T / 2], [x1, -a], [L - a, -a]];
    for (let k = 1; k < 8; k++) { const t = -Math.PI / 2 + (Math.PI * k) / 8; pts.push([L - a + a * Math.cos(t), a * Math.sin(t)]); }
    pts.push([L - a, a], [x1, a], [x1, T / 2], [x0, T / 2], [x0, a], [0, a]);
    return pts.map(([x, y]) => ({ x: cx - L / 2 + x, y: cy + y }));
  }

  /** Try to place a church of the given size in a convex block: at its centroid, then around it. Returns the footprint or null. */
  function placeChurch(block, L, w, T, margin) {
    const c = global.polygonCentroid(block.poly);
    const xs = block.poly.map((p) => p.x), ys = block.poly.map((p) => p.y);
    const rx = (Math.max(...xs) - Math.min(...xs)) / 2, ry = (Math.max(...ys) - Math.min(...ys)) / 2;
    const tries = [[0, 0]];
    for (let r = 0.2; r <= 0.6; r += 0.2) for (let k = 0; k < 8; k++) tries.push([r * rx * Math.cos((k * Math.PI) / 4), r * ry * Math.sin((k * Math.PI) / 4)]);
    for (const [dx, dy] of tries) {
      const poly = churchPolygon(c.x + dx, c.y + dy, L, w, T);
      if (fitsIn(block.poly, poly, margin)) return poly;
    }
    return null;
  }

  global.churchPolygon = churchPolygon;
  global.polygonInside = inside;

  global.MonumentsStep = {
    id: 'monuments',
    title: 'Squares and monuments',
    zIndex: 5.35,  // on the buildings, below the roads and walls
    settings: [
      { key: 'parishArea', label: 'One parish church per (ha)', type: 'range', min: 4, max: 30, step: 1, default: 10 },
      { key: 'churchGap', label: 'Minimum distance between churches (m)', type: 'range', min: 100, max: 500, step: 25, default: 200 },
      { key: 'cathedralLength', label: 'Cathedral length (m)', type: 'range', min: 40, max: 120, step: 5, default: 70 },
      { key: 'churchLength', label: 'Parish church length (m)', type: 'range', min: 15, max: 50, step: 1, default: 28 }
    ],

    run(state, s, rng, ctx) {
      const t0 = performance.now();
      state.monuments = null; state.squares = null; state.churchyards = null;
      if (!state.blocks || !state.lots || !state.buildings) return 'No blocks: no monuments.';
      const toU = U().toUnits;
      const walls = state.walls, inner = walls.find((x) => x.kind === 'inner'), outer = walls.find((x) => x.kind === 'outer');
      const core = state.core || state.site;
      const blocks = state.blocks;
      const used = new Set();
      const monuments = [], squares = [], churchyards = [];
      const lotsOut = state.lots.slice(), buildingsOut = state.buildings.slice();
      const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
      const ha = (a) => (a * U().METRES_PER_UNIT * U().METRES_PER_UNIT) / 10000;
      /** Remove the lots (and their houses) of a block that overlap `poly`, or all of them; returns the removed lots. */
      const clear = (bi, poly) => {
        const removed = [];
        for (let i = lotsOut.length - 1; i >= 0; i--) {
          const lot = lotsOut[i];
          if (lot.block !== bi) continue;
          if (poly && !overlap(lot.poly, poly)) continue;
          removed.push(lot);
          lotsOut.splice(i, 1);
        }
        const gone = new Set(removed);
        for (let i = buildingsOut.length - 1; i >= 0; i--) if (gone.has(buildingsOut[i].lot)) buildingsOut.splice(i, 1);
        return removed;
      };
      const byDistToCore = blocks.map((b, i) => i).sort((i, j) => dist(blocks[i].centre, core) - dist(blocks[j].centre, core));
      const hasMainStreet = (bi) => state.lots.some((l) => l.block === bi && l.street === 'main');

      // 1. The castle: the block nearest the core; its enclosure is the block, the keep a square in the middle.
      const castleBlock = byDistToCore.find((i) => ha(blocks[i].area) >= 0.1);
      if (castleBlock !== undefined) {
        used.add(castleBlock);
        clear(castleBlock, null);
        const b = blocks[castleBlock], c = b.centre, k = toU(8);
        monuments.push({ kind: 'castle', block: castleBlock, poly: b.poly, keep: [{ x: c.x - k, y: c.y - k }, { x: c.x + k, y: c.y - k }, { x: c.x + k, y: c.y + k }, { x: c.x - k, y: c.y + k }], centre: c });
      }

      // 2. The market square: the nearest unused block on a main street, of a square's size; the halles in the middle.
      const marketBlock = byDistToCore.find((i) => !used.has(i) && hasMainStreet(i) && ha(blocks[i].area) >= 0.12 && ha(blocks[i].area) <= 1.2);
      if (marketBlock !== undefined) {
        used.add(marketBlock);
        clear(marketBlock, null);
        const b = blocks[marketBlock];
        squares.push({ kind: 'market', block: marketBlock, poly: b.poly, centre: b.centre });
        // The halles: a hall along the square's long axis, if it fits with room around.
        let far = [b.poly[0], b.poly[0]], fd = 0;
        for (const p of b.poly) for (const q of b.poly) { const d = dist(p, q); if (d > fd) { fd = d; far = [p, q]; } }
        const ang = Math.atan2(far[1].y - far[0].y, far[1].x - far[0].x), ex = Math.cos(ang), ey = Math.sin(ang), nx = -ey, ny = ex;
        for (const [hl, hw] of [[toU(30), toU(12)], [toU(22), toU(10)], [toU(16), toU(8)]]) {
          const c = b.centre;
          const rect = [[-hl / 2, -hw / 2], [hl / 2, -hw / 2], [hl / 2, hw / 2], [-hl / 2, hw / 2]].map(([u, v]) => ({ x: c.x + ex * u + nx * v, y: c.y + ey * u + ny * v }));
          if (fitsIn(b.poly, rect, toU(7))) { monuments.push({ kind: 'halles', block: marketBlock, poly: rect, centre: c }); break; }
        }
      }

      // 3. The cathedral: the largest block of the old core that can hold it (shrunk down to 40 m if need be); the block is its close and parvis.
      const inOld = blocks.map((b, i) => i).filter((i) => !used.has(i) && (b => Math.hypot(b.centre.x - inner.centre.x, b.centre.y - inner.centre.y))(blocks[i]) < Math.max(...inner.poly.map((p) => p.r)) * 1.1);
      inOld.sort((i, j) => blocks[j].area - blocks[i].area);
      const churches = [];
      let cathedral = null;
      for (const bi of inOld) {
        for (let Lm = s.cathedralLength; Lm >= 40 && !cathedral; Lm -= 5) {
          const L = toU(Lm), poly = placeChurch(blocks[bi], L, L * 0.3, L * 0.6, toU(4));
          if (poly) cathedral = { kind: 'cathedral', block: bi, poly: poly, centre: global.polygonCentroid(poly), length: Lm };
        }
        if (cathedral) break;
      }
      if (cathedral) {
        used.add(cathedral.block);
        clear(cathedral.block, null);
        squares.push({ kind: 'parvis', block: cathedral.block, poly: blocks[cathedral.block].poly, centre: blocks[cathedral.block].centre });
        monuments.push(cathedral);
        churches.push(cathedral.centre);
      }

      // 4. Parish churches, one per `parishArea` ha, spread by farthest-point sampling among the blocks that can hold one.
      const wanted = Math.max(1, Math.round(outer.area / s.parishArea) - (cathedral ? 1 : 0));
      const gap = toU(s.churchGap);
      const L = toU(s.churchLength), w = L * 0.38, T = L * 0.62;
      let placed = 0;
      for (let n = 0; n < wanted; n++) {
        let best = -1, bd = -1;
        blocks.forEach((b, i) => {
          if (used.has(i) || ha(b.area) < 0.15) return;
          const d = churches.length ? Math.min(...churches.map((c) => dist(c, b.centre))) : dist(b.centre, core);
          if (d > bd) { bd = d; best = i; }
        });
        if (best < 0 || (churches.length && bd < gap)) break;
        const poly = placeChurch(blocks[best], L, w, T, toU(3));
        used.add(best);  // tried, whether it fits or not
        if (!poly) { n--; if (used.size > blocks.length) break; continue; }
        const church = { kind: 'church', block: best, poly: poly, centre: global.polygonCentroid(poly) };
        // The churchyard: the lots the church (grown by 5 m, more to the west for a little parvis) touches.
        const yard = grown(poly, toU(5)).map((p) => ({ x: p.x - (p.x < church.centre.x ? toU(3) : 0), y: p.y }));
        const removed = clear(best, yard);
        churchyards.push(...removed.map((lot) => ({ poly: lot.poly, church: church })));
        monuments.push(church);
        churches.push(church.centre);
        placed++;
      }

      state.monuments = monuments;
      state.squares = squares;
      state.churchyards = churchyards;
      state.lots = lotsOut;
      state.buildings = buildingsOut;
      const removedHouses = state.buildings.length;  // after
      return monuments.map((m) => m.kind).filter((k, i, a) => a.indexOf(k) === i).map((k) => monuments.filter((m) => m.kind === k).length + ' ' + k).join(', ') +
        (cathedral ? ' (' + cathedral.length + ' m)' : ', no room for a cathedral') + '; ' + squares.length + ' squares; ' + (lotsOut.length) + ' lots and ' + removedHouses +
        ' houses remain, ' + Math.round(performance.now() - t0) + ' ms';
    },

    draw(g, state, ctx) {
      const px = (ctx && ctx.px) || 1;
      if (!state.monuments) return;
      g.save();
      g.lineJoin = 'round';
      // Squares: the street tone again, over the block fill.
      g.fillStyle = '#f3ead6';
      for (const sq of state.squares) {
        g.beginPath();
        sq.poly.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
        g.fill();
      }
      // Churchyards.
      g.fillStyle = '#cfd6b4';
      g.strokeStyle = 'rgba(90, 70, 50, .5)';
      g.lineWidth = 0.4 * px;
      for (const y of state.churchyards) {
        g.beginPath();
        y.poly.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
        g.fill();
        g.stroke();
      }
      for (const m of state.monuments) {
        if (m.kind === 'castle') {
          g.fillStyle = '#e9dfc6';
          g.strokeStyle = '#2b2017';
          g.lineWidth = 2.5 * px;
          g.beginPath();
          m.poly.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
          g.closePath();
          g.fill();
          g.stroke();
          g.fillStyle = '#2b2017';
          g.beginPath();
          m.keep.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
          g.closePath();
          g.fill();
        } else {
          g.fillStyle = m.kind === 'halles' ? '#8a6d4e' : '#2b2017';
          g.strokeStyle = '#1a120c';
          g.lineWidth = 0.6 * px;
          g.beginPath();
          m.poly.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
          g.closePath();
          g.fill();
          g.stroke();
        }
      }
      // Names, once the town fills the screen.
      if (ctx.scale > 1.2) {
        const names = { castle: 'Château', halles: 'Halles', cathedral: 'Cathédrale', church: 'Église' };
        g.font = (11 * px) + 'px Georgia, serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillStyle = '#2b2017';
        g.strokeStyle = 'rgba(243, 234, 214, .85)';
        g.lineWidth = 3 * px;
        for (const m of state.monuments) {
          if (m.kind === 'church' && ctx.scale < 2.5) continue;
          const y = m.kind === 'castle' ? m.centre.y + 14 * px : m.centre.y + 10 * px + (m.kind === 'halles' ? 0 : 6 * px);
          g.strokeText(names[m.kind], m.centre.x, y);
          g.fillText(names[m.kind], m.centre.x, y);
        }
        for (const sq of state.squares) {
          if (sq.kind !== 'market') continue;
          // At the top of the square, clear of the halles in its middle.
          const top = Math.min(...sq.poly.map((p) => p.y));
          g.strokeText('Marché', sq.centre.x, top + 9 * px);
          g.fillText('Marché', sq.centre.x, top + 9 * px);
        }
      }
      g.restore();
    }
  };
})(window);
