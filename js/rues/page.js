// Streets page: fine generation of streets on a small map, step by step.
// Read by js/app.js, loaded right after this file.
window.VibecityPage = {
  width: 500,
  height: 500,
  storageKey: 'vibecity.rues.savedSettings',
  firstCached: 0,
  steps: [window.StreetsVoronoiStep, window.StreetsGraphStep, window.StreetsExitsStep]
};
