# Vibecity

Procedural generator for the plan of a fictional medieval city. Plain HTML/JS, no framework, no build: open `index.html` in a browser.

- Left panel: numbered, collapsible generation steps, each with its own settings.
- Everything is derived from the **seed** (each step gets its own seeded RNG), so the same seed + settings always give the same map.
- Seed and settings are stored in the URL hash, so a map can be shared by URL.
- Map is 2000×2000 units, scaled to fit the window.

## Steps

1. **Random points** — number of points, margin from the edges, distribution (true random or Poisson disk).

Add a step by creating `js/steps/<name>.js` exposing `{ id, title, settings, run(state, settings, rng, ctx), draw(g, state, ctx) }` and adding it to `STEPS` in `js/app.js`.
