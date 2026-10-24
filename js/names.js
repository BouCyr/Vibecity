// Place names in the manner of the French countryside, drawn from a seeded
// generator: the town, its villages and hamlets, the fleuve, the abbey.
(function (global) {
  'use strict';

  const ONSETS = ['b', 'br', 'c', 'ch', 'cl', 'd', 'f', 'fl', 'g', 'gr', 'j', 'l', 'm', 'n', 'p', 'pr', 'r', 's', 't', 'tr', 'v', 'vr'];
  const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ou', 'au', 'ai', 'é', 'eu'];
  const CODAS = ['', '', 'n', 'r', 'l', 's', 'ss', 'rn', 'lm'];
  const TOWN_ENDINGS = ['ac', 'ay', 'ville', 'court', 'euil', 'ières', 'ange', 'on', 'y', 'igny', 'mont', 'val', 'ieu', 'zac'];
  const VILLAGE_ENDINGS = ['ac', 'ay', 'y', 'ville', 'court', 'euil', 'ières', 'ange', 'on', 'igny', 'sac', 'illac'];
  const SAINTS = ['Martin', 'Pierre', 'Jean', 'Étienne', 'Germain', 'Hilaire', 'Rémy', 'Léger', 'Médard', 'Aubin', 'Saturnin', 'Julien', 'Loup', 'Vincent', 'Maurice', 'Sulpice', 'Marcel', 'Ouen', 'Denis', 'Laurent'];
  const HAMLETS = ['Les Granges', 'Les Bordes', 'Les Essarts', 'Les Brosses', 'Les Fougères', 'Les Vignes', 'Les Mazures', 'La Chaume', 'Le Breuil', 'La Borde', 'Le Fay', 'Les Loges', 'La Vacherie', 'Le Plessis', 'Les Landes', 'La Fosse', 'Le Tertre', 'Les Marais', 'La Brosse', 'Le Chesnay', 'La Noue', 'Les Aulnes', 'Le Buisson', 'La Hutte'];
  const RIVER_ENDINGS = ['èze', 'onne', 'ance', 'oire', 'ise', 'ère', 'aine', 'ègre', 'ande', 'elle'];
  const QUALIFIERS = ['-le-Vieux', '-le-Grand', '-la-Ville', '-sous-Bois', '-les-Bains', '-en-Val', '-le-Haut'];

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function create(rng) {
    const used = new Set();
    const unique = (fn) => {
      for (let t = 0; t < 30; t++) { const n = fn(); if (!used.has(n)) { used.add(n); return n; } }
      return fn();
    };
    const syllable = (coda) => rng.pick(ONSETS) + rng.pick(VOWELS) + (coda ? rng.pick(CODAS) : '');
    const root = () => syllable(true) + (rng.random() < 0.5 ? syllable(false) : '');
    return {
      /** The town: a root and an ending, sometimes on its river. */
      town(river) {
        return unique(() => {
          const base = cap(root() + rng.pick(TOWN_ENDINGS));
          if (river && rng.random() < 0.35) return base + '-sur-' + river.replace(/^la /i, '').replace(/^l'/i, '');
          return base;
        });
      },
      /** A village: a saint's name, or a root with an ending, with the odd qualifier. */
      village() {
        return unique(() => {
          if (rng.random() < 0.45) return 'Saint-' + rng.pick(SAINTS) + (rng.random() < 0.25 ? rng.pick(QUALIFIERS) : '');
          return cap(root() + rng.pick(VILLAGE_ENDINGS)) + (rng.random() < 0.2 ? rng.pick(QUALIFIERS) : '');
        });
      },
      hamlet() { return unique(() => rng.pick(HAMLETS)); },
      river() { return unique(() => 'la ' + cap(syllable(true).replace(/[^a-zé]+$/, '') + rng.pick(RIVER_ENDINGS))); },
      stream() { return unique(() => 'le ' + cap(root() + rng.pick(['et', 'on', 'eau', 'ou']))); },
      abbey() { return 'Abbaye Saint-' + rng.pick(SAINTS); },
      saint() { return rng.pick(SAINTS); }
    };
  }

  global.Names = { create: create };
})(window);
