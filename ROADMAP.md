# Roadmap — from a regional map to a city drawn building by building

Target: a fictional medieval city, around 1300–1500, drawn down to every
building (churches, cathedral, castle, market…), with its faubourgs and the
first ring of countryside. The output is a **2D ground plan** (footprints in
black, streets in white, hatched fields, contour lines — cadastral /
Belleforest style); the 3D view (step 11) is a debugging aid, not the goal.

## Decisions (settled)

| Point | Decision |
|---|---|
| Scale | **1 unit = 2.5 m**: the 2000 × 2000 map is **5 km × 5 km**, the fleuve (20 u) 50 m wide, the cells (2000 points) ~110 m apart. |
| Levels | **One level**: the current map *is* the city zone. No nested "city window", no site chosen inside a larger region. |
| Extent | 5 km covers the city (~1 km across intra muros), the faubourgs and ~2 km of countryside around. |
| Towns | **One** detailed city; villages and hamlets at low detail in the countryside. |
| Period | **c. 1300–1500**: an old core, a large 13th-century wall, faubourgs, gothic cathedral, castle. |
| Drawing | **Ground plan** first; a bird's-eye (Turgot-like) rendering stays possible later since the data is render-independent. |

Options that were considered and dropped: densifying the Voronoi map 100×
(the river/coast algorithms do not scale, and Voronoi cells are the wrong
primitive for lots), and two nested levels region → city window (more
infrastructure, and at 5 km the window would have covered the whole map).

## Where we stand

Steps 1–11 produce the **terrain**: points, Voronoi cells, altitude in
metres, sea, a fleuve with tributaries as real water cells. Coordinates
stay as they are (1 u = 2.5 m); only the interpretation changes. There is no
pan/zoom yet: the map is fitted to the window.

Convention from now on: a constant `METRES_PER_UNIT = 2.5`; every city
setting is expressed **in metres** in the panel and converted at step
entry, so that lot widths, street widths, wall lengths read naturally.

## 1. Infrastructure first (milestone M0)

Investments on which everything else depends. Keep M0 short — it is the
only milestone with nothing new to look at.

1. **Pan/zoom on the canvas**, with levels of detail at draw time: 10 000
   buildings fitted to the window are unreadable. Wheel/pinch to zoom,
   drag to pan, double-click to reset.
2. **Raster fields** (`Float32Array`, pitch 1–2 u = 2.5–5 m): fine altitude,
   distance to water, to the centre, to the gates, slope. Almost every
   urban rule is of the form *density = f(distance to X)*: trivial on a
   raster, painful on vectors. Built lazily by the step that first needs
   them, cached in the state (so rebuilt at every generation). Done:
   `js/fields.js` and step 11 (altitude, water, water distance, slope).
3. **Shared geometry module** (`js/geom.js`): polygon offset/inset,
   clipping, oriented-bounding-box split, point in polygon, smoothing,
   polyline resampling. Today each step carries its own geometry; the
   parcelling will need it everywhere.
4. **Scale constant** (`METRES_PER_UNIT`) and a scale bar on the map.
5. **SVG export**: the target is a drawing, the vector export is its proof
   of life. Can come a little later, but the data model is designed for it
   from the start (every object = polygon + class).

## 2. City pipeline (continuing the numbered steps; 11 is the raster fields, 12 the 3D view)

Known rough edges after M2, to revisit with the urban fabric: a town hemmed
in by water on two sides gets fewer gates (the 60° spacing); the old core
wall, pulled towards the bank, can come out flat against it; roads keep a
slight wiggle from the 20 m routing grid.

### Phase A — Site and terrain detail

- **13. Fine terrain** ✓ — the altitude is known per cell/node (~110 m
  apart); add fine noise octaves (metre scale) constrained by the water
  levels so the banks stay consistent; marsh in the low ground. Produces
  the altitude raster that every later step reads. Done:
  `js/steps/terrain.js` (smoothed facets, 3 noise octaves, banks above
  the nearest water, marsh patches, hillshade layer). Runs before the
  site so that the site reads smoothed slopes.
- **14. Site** ✓ — score candidate locations on the map: river bank,
  crossing point, confluence, defensible hill, distance to the sea, flat
  enough ground; keep the best according to a preference (river port /
  hilltop town / confluence). Output: the city centre and orientation,
  drawn on the map. Settings: preference, minimum distance to the map
  border (the countryside must fit around). Done: `js/steps/site.js`
  (candidates every 20 m scored from the rasters, heat map layer).

### Phase B — Skeleton

- **15. Core and walls** ✓ — a core (castrum / castle on the hill /
  cathedral), then two successive walls (small Gallo-Roman one ~10 ha,
  large 13th-century one ~50–100 ha). The outline follows the terrain
  (ridges, the river as natural defence); towers at intervals; gates where
  the main roads leave. The old wall becomes an inner street/boulevard —
  this is what gives the historical layering. Done: `js/steps/walls.js`
  (star-shaped walls of a target area along the terrain and the banks,
  towers, bridge gate and land gates).
- **16. Main roads and bridge** ✓ — incoming roads from the map borders
  (towards the neighbouring towns, along the river) → gates → convergence
  on the centre (market / cathedral). Bridge placement (narrow, shallow,
  stable banks). These axes structure everything else. Done:
  `js/steps/roads.js` (A* on a 20 m cost grid, bridge at the shortest
  crossing near the bridge gate, old wall gates where the axes cross it).

### Phase C — Urban fabric

- **17. Blocks and streets** — **reuse the existing pipeline at block
  scale**: points (density rising towards the centre) → Voronoi → Lloyd →
  merge short edges → smoothing, restricted to the walled area. Edges
  become streets, cells become blocks (60–120 m). Then: drop some edges
  for irregular blocks, widen the axes; streets 3–8 m, axes 8–12 m. This is
  the main payoff of the current architecture: steps 1, 2, 6 and 8 already
  are an organic-mesh library — to be factored into reusable functions
  taking a polygon boundary instead of the whole map.
- **18. Squares and monuments** — market square (a hollowed block),
  cathedral with parvis, one parish church per quarter (~every 300 m,
  **chevet to the east**), castle, halles, town hall, hôtel-Dieu,
  cemeteries around churches, abbey often extra muros. Monuments are
  special footprints (cross plan…).
- **19. Lots** — each block cut into strip lots perpendicular to the street
  (5–8 m frontage, 20–40 m deep), narrower towards the centre. Algorithm:
  recursive OBB split, or inward offset + division of the street frontage.
- **20. Buildings** — one footprint per lot, aligned on the street, yard at
  the back; height and roof type (ridge line) stored. The data is
  **render-independent**.

### Phase D — Outside the walls

- **21. Faubourgs** — ribbon development along the roads past the gates,
  decreasing density, larger lots with gardens; mills on the river,
  tanneries downstream, port and quays, leper house far away, abbeys.
- **22. Countryside** — field parcels (open-field strips or bocage)
  oriented by the lanes and the relief; market-garden belt, vineyards and
  orchards near the city; woods on steep slopes; villages with their
  church 2–3 km away, hamlets; lanes by shortest path over the terrain.

### Phase E — Drawing

- **23. Cartographic rendering** — the ground plan: water, relief (contour
  lines or hachures), hatched fields, buildings in black, monuments in
  bold, generated place names, legend, scale bar, pen-and-ink style. SVG
  export.

## 3. Milestones (each one shows something)

| Milestone | Content | What becomes visible |
|---|---|---|
| M0 | Pan/zoom ✓, raster fields ✓ (step 11), scale constant ✓, geom.js | The existing map, zoomable, with a scale bar |
| M1 ✓ | Fine terrain + site | The right spot, chosen automatically; metre-scale relief |
| M2 ✓ | Walls + gates + axes + bridge | The **silhouette** of the city |
| M3 | Blocks + streets (Voronoi reuse) | It already looks like a city plan |
| M4 | Lots + buildings | The goal: every building |
| M5 | Squares + monuments | Churches, cathedral, castle, market |
| M6 | Faubourgs | |
| M7 | Countryside | |
| M8 | Pen-and-ink rendering + labels + SVG | The final drawing |

M2–M3 are the moment of truth: if the silhouette and the blocks look right,
the rest is filling; if they look wrong, we know early.

## 4. Method and guard rails

- **Determinism** is kept: one seeded RNG per step, the whole config in the
  URL hash.
- **Invariants checked at every step**, as already done for the cells: no
  overlapping buildings, every lot touches a street, every block fully
  parcelled, every church has its chevet to the east. The step info says
  what it had to fix.
- **Real references for calibration**: the Gallica tool is already there —
  the plans of Turgot, Belleforest, Braun & Hogenberg give densities,
  street widths, block sizes. Calibration parameters (lot, block, street)
  are settings whose defaults come from those plans.
- **Performance**: a step only reruns when an upstream step changes (as
  today); rasters rather than repeated vector queries; draw with level of
  detail (no building outlines when zoomed out).
