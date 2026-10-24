// Step 5 — sea clean-up.
//  1. Land cells touching a sea-front edge of the map become sea, unless they are
//     linked, through land cells touching that same kind of edge, to the land cell
//     of a corner that is not between two sea fronts.
//  2. Sea areas that reach no sea front (inland seas) are filled: they become land,
//     raised to the lowest land altitude around them.
//  3. Small islands (up to 3 land cells) become sea.
// Sea cells (and nodes surrounded by sea) then lose their altitude (set to 0).
(function (global) {
  'use strict';

  const EPS = 1e-6;
  const CORNERS = [
    { sides: ['N', 'W'], x: 0, y: 0 },
    { sides: ['N', 'E'], x: 1, y: 0 },
    { sides: ['S', 'E'], x: 1, y: 1 },
    { sides: ['S', 'W'], x: 0, y: 1 }
  ];

  /** Map edges a cell lies along (at least two vertices on that edge). */
  function cellSides(c, w, h) {
    const count = { N: 0, E: 0, S: 0, W: 0 };
    for (const v of c.poly) {
      if (v.y <= EPS) count.N++;
      if (v.x >= w - EPS) count.E++;
      if (v.y >= h - EPS) count.S++;
      if (v.x <= EPS) count.W++;
    }
    return Object.keys(count).filter((k) => count[k] >= 2);
  }

  /** Connected groups of cells matching `pred`, through Voronoi neighbors. */
  function components(cells, pred) {
    const comp = new Int32Array(cells.length).fill(-1);
    const groups = [];
    cells.forEach((c, start) => {
      if (comp[start] >= 0 || !pred(c)) return;
      const group = [start];
      comp[start] = groups.length;
      for (let k = 0; k < group.length; k++) {
        for (const j of cells[group[k]].neighbors) {
          if (comp[j] < 0 && pred(cells[j])) { comp[j] = groups.length; group.push(j); }
        }
      }
      groups.push(group);
    });
    return groups;
  }

  const SMALL_ISLAND = 3;

  /**
   * Islands (land groups through shared edges) of up to `maxCells` cells become
   * sea, as long as some other land exists. Changes go to `changes`.
   */
  function removeSmallIslands(cells, maxCells, changes) {
    const groups = components(cells, (c) => !c.sea);
    if (groups.length < 2) return 0;
    let removed = 0;
    for (const group of groups) {
      if (group.length > maxCells) continue;
      for (const i of group) { cells[i].sea = true; changes.push({ cell: i, toSea: true }); }
      removed++;
    }
    return removed;
  }

  /**
   * A land cell touching the map border by a single point, every other cell at
   * that point being sea, becomes sea (repeated until there is none).
   */
  function removeBorderPinches(state, w, h, changes) {
    const onBorder = (n) => n.x <= EPS || n.y <= EPS || n.x >= w - EPS || n.y >= h - EPS;
    const cellsAt = state.nodes.map(() => []);
    state.cells.forEach((c, i) => c.nodes.forEach((v) => cellsAt[v].push(i)));
    let removed = 0, again = true;
    while (again) {
      again = false;
      state.cells.forEach((c, i) => {
        if (c.sea) return;
        const pts = c.nodes.filter((v) => onBorder(state.nodes[v]));
        if (pts.length !== 1) return;
        if (!cellsAt[pts[0]].every((j) => j === i || state.cells[j].sea)) return;
        c.sea = true;
        changes.push({ cell: i, toSea: true });
        removed++;
        again = true;
      });
    }
    return removed;
  }
  global.removeSmallIslands = removeSmallIslands;
  global.removeBorderPinches = removeBorderPinches;

  global.SeaCleanupStep = {
    id: 'seaCleanup',
    title: 'Sea clean-up',
    defaultVisible: false,
    settings: [
      {
        key: 'passes', label: 'Corrections', type: 'toggles', default: ['edges', 'inland', 'islands'],
        options: [
          { value: 'edges', label: 'Front edges', title: 'Land touching a sea-front edge becomes sea, except next to a land corner' },
          { value: 'inland', label: 'Inland seas', title: 'Sea areas reaching no sea front are filled' },
          { value: 'islands', label: 'Small islands', title: 'Islands of up to 3 cells become sea' }
        ]
      }
    ],

    run(state, s, rng, ctx) {
      const cells = state.cells;
      const fronts = state.seaFronts || [];
      const isFront = (side) => fronts.indexOf(side) >= 0;
      const passes = s.passes || [];
      cells.forEach((c) => { c.sides = cellSides(c, ctx.width, ctx.height); });
      const touchesFront = (c) => c.sides.some(isFront);
      const changes = [];

      // 1. Land along sea-front edges.
      if (passes.indexOf('edges') >= 0 && fronts.length) {
        const frontLand = (c) => !c.sea && touchesFront(c);
        const kept = new Uint8Array(cells.length);
        const queue = [];
        for (const corner of CORNERS) {
          if (isFront(corner.sides[0]) && isFront(corner.sides[1])) continue;
          const cx = corner.x * ctx.width, cy = corner.y * ctx.height;
          const ci = cells.findIndex((c) => c.poly.some((v) => Math.abs(v.x - cx) <= EPS && Math.abs(v.y - cy) <= EPS));
          if (ci >= 0 && frontLand(cells[ci]) && !kept[ci]) { kept[ci] = 1; queue.push(ci); }
        }
        for (let k = 0; k < queue.length; k++) {
          for (const j of cells[queue[k]].neighbors) {
            if (!kept[j] && frontLand(cells[j])) { kept[j] = 1; queue.push(j); }
          }
        }
        cells.forEach((c, i) => {
          if (frontLand(c) && !kept[i]) { c.sea = true; changes.push({ cell: i, toSea: true }); }
        });
      }

      // 2. Inland seas. Without any sea front, only the largest sea area is kept.
      let filled = 0;
      if (passes.indexOf('inland') >= 0) {
        const seas = components(cells, (c) => c.sea);
        let open;
        if (fronts.length) {
          open = seas.map((g) => g.some((i) => touchesFront(cells[i])));
        } else {
          const largest = seas.reduce((best, g, k) => (g.length > seas[best].length ? k : best), 0);
          open = seas.map((g, k) => k === largest);
        }
        seas.forEach((group, k) => {
          if (open[k]) return;
          // Fill up to the lowest land cell around the area.
          let level = Infinity;
          for (const i of group) {
            for (const j of cells[i].neighbors) {
              if (!cells[j].sea && cells[j].altitude < level) level = cells[j].altitude;
            }
          }
          if (!isFinite(level)) return;
          for (const i of group) {
            const c = cells[i];
            c.sea = false;
            c.altitude = level;
            for (const ni of c.nodes) {
              const n = state.nodes[ni];
              if (n.altitude < level) n.altitude = level;
            }
            changes.push({ cell: i, toSea: false });
          }
          filled++;
        });
      }

      // 3. Small islands.
      let islands = 0, islandCells = changes.length;
      if (passes.indexOf('islands') >= 0) islands = removeSmallIslands(cells, SMALL_ISLAND, changes);
      islandCells = changes.length - islandCells;

      updateSeaFlags(state);
      // Sea altitude is not used further.
      for (const c of cells) if (c.sea) c.altitude = 0;
      for (const n of state.nodes) if (n.sea) n.altitude = 0;
      state.seaChanges = changes;

      const toSea = changes.filter((ch) => ch.toSea).length;
      let seaCount = 0;
      for (const c of cells) if (c.sea) seaCount++;
      return (toSea - islandCells) + ' edge cells to sea, ' + islands + ' small islands removed, ' + filled + ' inland seas filled (' + (changes.length - toSea) +
        ' cells); ' + Math.round((100 * seaCount) / Math.max(1, cells.length)) + '% sea';
    },

    // Outlines the cells changed by this step: blue = became sea, orange = became land.
    draw(g, state, ctx) {
      const px = (ctx && ctx.px) || 1;  // map units per screen px: constant widths on screen
      g.save();
      g.lineWidth = 2 * px;
      g.setLineDash([5 * px, 3 * px]);
      for (const ch of state.seaChanges) {
        const p = state.cells[ch.cell].poly;
        g.strokeStyle = ch.toSea ? '#1d3e7a' : '#d2691e';
        g.beginPath();
        g.moveTo(p[0].x, p[0].y);
        for (let k = 1; k < p.length; k++) g.lineTo(p[k].x, p[k].y);
        g.closePath();
        g.stroke();
      }
      g.restore();
    }
  };
})(window);
