# Roadmap — from a regional map to a city drawn building by building

Target: a fictional medieval city drawn down to every building (churches,
cathedral, castle, market…), with its faubourgs and the first ring of
countryside. The output is a **2D drawing** (plan, later possibly a
Turgot-like bird's-eye sketch); the 3D view (step 11) is a debugging aid,
not the goal.

## Where we stand

Steps 1–11 produce a **regional terrain**: 2000 points by default, so
Voronoi cells about 45 units apart on a 2000 × 2000 map, a fleuve 20 units
wide, altitudes in metres. There is no pan/zoom: the map is fitted to the
window. A city drawn building by building is two orders of magnitude finer
than this; that gap shapes the whole plan.

## 1. Key decision: two nested levels

| Option | Principle | Verdict |
|---|---|---|
| A. Densify the current map | 100× more Voronoi cells | No: the river/coast algorithms do not scale, and Voronoi cells are the wrong primitive for lots and buildings. |
| B. Reinterpret the scale | Declare 2000 u = 4 km and build the city inside | Tempting (no infrastructure) but the *region* is lost: roads to other towns, hinterland, river at regional scale. A fine level is needed inside anyway. |
| **C. Two nested levels** | Region (existing) → choose a **site** → a *city* window with its own coordinate space and its own pipeline | **Chosen.** The existing work stays intact; the city gets a clean space at 1 u = 1 m. |

Scales:

- **Region**: 1 u = 5 m, so the map is 10 km × 10 km, the fleuve 100 m
  wide, cells ~225 m apart.
- **City window**: 4 km × 4 km at 1 u = 1 m (4000 × 4000). A medium
  medieval town is 30–100 ha intra muros (~1 km across); 4 km cover the
  faubourgs and the first countryside.
- Expected volumes: 5–15 000 buildings, 2–5 000 field parcels — fine for
  Canvas 2D and for an SVG export.

The only seam between the two levels is a **region → city sampler** (§2.3):
the city pipeline sees nothing else of the region.

## 2. Infrastructure first (milestone M0)

Investments on which everything else depends. Keep M0 short and strictly
necessary — it is the only milestone with nothing new to look at.

1. **Pan/zoom on the canvas**, with levels of detail at draw time: 10 000
   buildings fitted to the window are unreadable.
2. **Level selector** Region / City in the panel. City steps keep exactly
   the current step contract (`id, title, settings, run(state, settings,
   rng, ctx), draw(g, state, ctx)`); the step framework is extended, not
   rewritten. The city config (settings, visibility) joins the URL hash.
3. **Region → city sampler**: interpolated `altitude(x, y)`, water mask
   (fleuve, sea) clipped to the window, shore lines resampled into city
   units.
4. **Raster fields** (`Float32Array`, 2–4 m pitch): fine altitude, distance
   to water, to the centre, to the gates, slope. Almost every urban rule is
   of the form *density = f(distance to X)*: trivial on a raster, painful
   on vectors.
5. **Shared geometry module** (`js/geom.js`): polygon offset/inset,
   clipping, oriented-bounding-box split, point in polygon, smoothing.
   Today each step carries its own geometry; the parcelling will need it
   everywhere.
6. **SVG export**: the target is a drawing, the vector export is its proof
   of life. Can come a little later, but the data model is designed for it
   from the start (every object = polygon + class).

## 3. City pipeline (continuing the numbered steps)

### Phase A — Site (region level)

- **12. Site** — score candidate locations on the regional map: river
  bank, crossing point, confluence, defensible hill, distance to the sea,
  flat enough ground; keep the best according to preferences (river port /
  hilltop town / confluence). Output: centre, orientation and the window
  rectangle, drawn on the regional map.

### Phase B — Skeleton (city level)

- **13. Fine terrain** — regional altitude + fine noise octaves constrained
  by the water levels (banks stay consistent); marsh in the low ground.
- **14. Core and walls** — a core (castrum / castle on the hill /
  cathedral), then 1–2 successive walls (small Gallo-Roman one ~10 ha,
  large 13th-century one ~50–100 ha). The outline follows the terrain
  (ridges, the river as natural defence); towers at intervals; gates where
  the main roads leave. An old wall becomes an inner street/boulevard —
  this is what gives the historical layering.
- **15. Main roads and bridge** — incoming regional roads (towards the
  neighbouring towns, along the river) → gates → convergence on the centre
  (market / cathedral). Bridge placement. These axes structure everything
  else.

### Phase C — Urban fabric

- **16. Blocks and streets** — **reuse the existing pipeline at block
  scale**: points (density rising towards the centre) → Voronoi → Lloyd →
  merge short edges → smoothing. Edges become streets, cells become blocks
  (60–120 m). Then: drop some edges for irregular blocks, widen the axes;
  streets 3–8 m, axes 8–12 m. This is the main payoff of the current
  architecture: steps 1, 2, 6 and 8 already are an organic-mesh library.
- **17. Squares and monuments** — market square (a hollowed block),
  cathedral with parvis, one parish church per quarter (~every 300 m,
  **chevet to the east**), castle, halles, town hall, hôtel-Dieu,
  cemeteries around churches, abbey often extra muros. Monuments are
  special footprints (cross plan…).
- **18. Lots** — each block cut into strip lots perpendicular to the street
  (5–8 m frontage, 20–40 m deep), narrower towards the centre. Algorithm:
  recursive OBB split, or inward offset + division of the street frontage.
- **19. Buildings** — one footprint per lot, aligned on the street, yard at
  the back; height and roof type (ridge line) stored. The data is
  **render-independent**, so the same city can be drawn as a plan, as a
  Turgot-like bird's-eye view, or otherwise.

### Phase D — Outside the walls

- **20. Faubourgs** — ribbon development along the roads past the gates,
  decreasing density, larger lots with gardens; mills on the river,
  tanneries downstream, port and quays, leper house far away, abbeys.
- **21. Countryside** — field parcels (open-field strips or bocage)
  oriented by the lanes and the relief; market-garden belt, vineyards and
  orchards near the city; woods on steep slopes; hamlets and villages with
  their church 2–3 km away; lanes by shortest path over the terrain.

### Phase E — Drawing

- **22. Cartographic rendering** — layers: water, relief (contour lines or
  hachures), hatched fields, buildings in black, monuments in bold,
  generated place names, legend, pen-and-ink style. SVG export.

## 4. Milestones (each one shows something)

| Milestone | Content | What becomes visible |
|---|---|---|
| M0 | Pan/zoom, level selector, sampler, raster fields, geom.js | The river and the relief cut out in the city window |
| M1 | Site + fine terrain | The right spot, chosen automatically |
| M2 | Walls + gates + axes + bridge | The **silhouette** of the city |
| M3 | Blocks + streets (Voronoi reuse) | It already looks like a city plan |
| M4 | Lots + buildings | The goal: every building |
| M5 | Squares + monuments | Churches, cathedral, castle, market |
| M6 | Faubourgs | |
| M7 | Countryside | |
| M8 | Pen-and-ink rendering + labels + SVG | The final drawing |

M2–M3 are the moment of truth: if the silhouette and the blocks look right,
the rest is filling; if they look wrong, we know early.

## 5. Method and guard rails

- **Determinism** is kept: one seeded RNG per step, the whole config (city
  level included) in the URL hash.
- **Invariants checked at every step**, as already done for the cells: no
  overlapping buildings, every lot touches a street, every block fully
  parcelled, every church has its chevet to the east. The step info says
  what it had to fix.
- **Real references for calibration**: the Gallica tool is already there —
  the plans of Turgot, Belleforest, Braun & Hogenberg give densities,
  street widths, block sizes. Calibration parameters (lot, block, street)
  are settings whose defaults come from those plans.
- **Performance**: city steps only rerun when an upstream step changes (as
  for the region); rasters rather than repeated vector queries.

## 6. Open points, to settle before M0

1. **Scale**: 1 regional unit = 5 m (10 km map) proposed; to confirm.
2. **City window size**: 4 km (close countryside) or 6 km (more villages,
   heavier).
3. **Period**: a city "around 1300–1500" (two walls, faubourgs) or more
   open? This fixes the walls and the monuments.
4. **Final drawing style** (strict ground plan vs Turgot-like bird's-eye
   view): does not change the data, changes M8.
5. **One or several towns** in the region (the second one being a
   neighbouring village/bourg at low detail) — one to start with.
