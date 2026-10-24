// Scale of the map: the 2000 × 2000 units cover 5 km × 5 km, so one unit is
// 2.5 m. Settings about the city are expressed in metres in the panel and
// converted with these helpers at step entry; altitudes are in metres already.
(function (global) {
  'use strict';

  const METRES_PER_UNIT = 2.5;

  global.Units = {
    METRES_PER_UNIT: METRES_PER_UNIT,
    /** Map units of a length in metres. */
    toUnits: (m) => m / METRES_PER_UNIT,
    /** Metres of a length in map units. */
    toMetres: (u) => u * METRES_PER_UNIT
  };
})(window);
