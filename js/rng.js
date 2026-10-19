// Seeded pseudo-random number generation.
// Everything random in the generator must come from an Rng built here,
// so that a given seed + settings always produces the same map.
(function (global) {
  'use strict';

  // cyrb128: hashes a string into four 32-bit integers.
  function cyrb128(str) {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < str.length; i++) {
      const k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= (h2 ^ h3 ^ h4); h2 ^= h1; h3 ^= h1; h4 ^= h1;
    return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
  }

  // sfc32: small, fast, good-quality 128-bit state PRNG.
  function sfc32(a, b, c, d) {
    return function () {
      a |= 0; b |= 0; c |= 0; d |= 0;
      const t = (((a + b) | 0) + d) | 0;
      d = (d + 1) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }

  class Rng {
    constructor(seed) {
      const s = cyrb128(String(seed));
      this._next = sfc32(s[0], s[1], s[2], s[3]);
      // Warm up to decorrelate similar seeds.
      for (let i = 0; i < 15; i++) this._next();
    }

    /** Float in [0, 1). */
    random() { return this._next(); }

    /** Float in [min, max). */
    range(min, max) { return min + (max - min) * this._next(); }

    /** Integer in [min, max] (inclusive). */
    int(min, max) { return min + Math.floor(this._next() * (max - min + 1)); }

    /** Random element of an array. */
    pick(arr) { return arr[Math.floor(this._next() * arr.length)]; }

    /** In-place Fisher–Yates shuffle. */
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(this._next() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    }

    /** Derive an independent generator, e.g. one per step. */
    fork(label) { return new Rng(this.random() + ':' + label); }
  }

  /** Random human-friendly seed (uses Math.random on purpose: it picks a NEW seed). */
  function randomSeed() {
    const syll = ['bra', 'cor', 'dun', 'el', 'fen', 'gar', 'hol', 'ith', 'kel', 'lor',
      'mar', 'nor', 'os', 'pen', 'quil', 'ros', 'sta', 'tor', 'ul', 'ven', 'wyn', 'yr'];
    let s = '';
    const n = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) s += syll[Math.floor(Math.random() * syll.length)];
    return s.charAt(0).toUpperCase() + s.slice(1) + '-' + Math.floor(Math.random() * 1000);
  }

  global.Rng = Rng;
  global.randomSeed = randomSeed;
})(window);
