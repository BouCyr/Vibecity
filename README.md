# Vibecity

Procedural generator for the plan of a fictional medieval city. Plain HTML/JS, no framework, no build: open `index.html` in a browser.

- Left panel: numbered, collapsible generation steps, each with its own settings.
- Everything is derived from the **seed** (each step gets its own seeded RNG), so the same seed + settings always give the same map.
- Seed and settings are stored in the URL hash, so a map can be shared by URL.
- Map is 2000×2000 units, scaled to fit the window.

## Steps

1. **Random points** — number of points, margin from the edges, distribution (true random or Poisson disk).
2. **Voronoi diagram** — one cell per point, clipped to the map, with neighbor adjacency and shared nodes (Voronoi vertices). Setting: Lloyd relaxation iterations (evens out cell sizes).
3. **Altitude** — altitude in [0, 1] for every cell center and node, from three layers of seeded simplex noise (hills, relief, local bumps), each with a size and a weight.
4. **Sea** — choose the sea fronts (N/E/S/W) and the share of sea cells (default 25%). A reference coast is built from the fronts: for one front, a slanted line drawn from the seed (it leaves the front edge 100–250 px from one corner, picked at random, and reaches the adjacent edge as far inland from the other corner); the same for each of two opposite fronts, drawn independently; a parabola from corner to corner bending toward the shared corner for two adjacent fronts (*Curve bend*: 0 = straight diagonal, 1 = control point on the corner, so the curve starts along the edges; default 0.4); a parabola between the corners of the land edge, with its vertex at the middle of the opposite edge, for three fronts; a centered circle for four. Altitude is lowered by the signed distance to that curve (reach, strength), rescaled to [0, 1], then the lowest cells become sea. The curve is drawn dashed on the sea layer.
5. **Sea clean-up** — (a) land cells along a sea-front edge become sea, unless linked through such land cells to the land cell of a corner that is not between two sea fronts; (b) sea areas reaching no sea front are filled up to the lowest surrounding land altitude (with no sea front, only the largest sea area is kept). (c) islands of a single land cell become sea. Sea altitude is then set to 0. Its layer outlines the changed cells (blue: became sea, orange: became land).
6. **Smooth coast** — the sea outline is resampled every 4 px and smoothed with a Gaussian-like filter (setting: radius in px, capped at 0.6 × the mean cell spacing so cells never fold), so no bend is tighter than about that radius; map-border stretches stay exact. The result is part of the data: coast nodes are moved onto the curve (`node.x/y`), the points between two coast nodes are stored per coast edge (`state.coastEdgePoints`, keyed by node pair) and inserted into the polygons of both cells along that edge (`cell.poly`, with `cell.polyAlt` giving an altitude per polygon point). Cells stay seamless. The cell-based Sea layer (step 4) is hidden by default.

Each step's checkbox toggles whether its layer is drawn.

Add a step by creating `js/steps/<name>.js` exposing `{ id, title, settings, run(state, settings, rng, ctx), draw(g, state, ctx), defaultVisible?, zIndex? }` and adding it to `STEPS` in `js/app.js`.

To get a single self-contained HTML file: `python3 tools/build-single.py vibecity.html`.
