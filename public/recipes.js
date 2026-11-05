// Worn Type — the wear recipe, shared by the web app and the Figma plugin:
// presets, slider definitions, and how variations differ from each other.
/* global Wear */
(function () {
  const PRESETS = {
    'Light wear': { erosion: 4, grain: 40, blunt: 6, chips: 1, chipSize: 14, spread: 2, smooth: 2 },
    'Old press': { erosion: 7, grain: 30, blunt: 12, bluntCover: 80, chips: 2, chipSize: 18, spread: 5, pool: 10, blots: 1, tilt: 0.6, shift: 3, smooth: 2 },
    Chipped: { erosion: 4, grain: 35, blunt: 8, chips: 6, chipSize: 22, chipDelicate: 85, smooth: 2 },
    'Heavy ink': { spread: 10, pool: 25, blots: 3, blotSize: 14, blunt: 10, erosion: 3, smooth: 3 },
    Battered: { erosion: 13, grain: 25, blunt: 16, bluntCover: 70, chips: 7, chipSize: 26, spread: 3, tilt: 1.2, shift: 5, smooth: 2 },
    Fresh: {},
  };

  // [key, label, min, max, step]; groups render as titled blocks
  const GROUPS = [
    ['Variations', [
      ['count', 'Variations per glyph', 1, 5, 1],
      ['variation', 'Difference %', 0, 100, 1],
    ]],
    ['Edge wear', [
      ['erosion', 'Surface erosion', 0, 30, 0.5],
      ['grain', 'Wear grain size', 5, 120, 1],
    ]],
    ['Corners', [
      ['blunt', 'Blunt corners', 0, 40, 0.5],
      ['bluntCover', 'Corners affected %', 0, 100, 1],
      ['bluntStyle', 'Corner wear', ['round', 'cut']],
    ]],
    ['Chipped edges', [
      ['chips', 'Chips', 0, 20, 1],
      ['chipSize', 'Chip size', 4, 60, 1],
      ['chipDelicate', 'Delicate parts %', 0, 100, 1],
      ['chipShape', 'Chip shape', ['angular', 'rounded']],
    ]],
    ['Ink', [
      ['spread', 'Ink spread', -15, 25, 0.5],
      ['pool', 'Ink pooling', 0, 60, 1],
      ['blots', 'Ink blots', 0, 12, 1],
      ['blotSize', 'Blot size', 4, 40, 1],
    ]],
    ['Setting', [
      ['tilt', 'Tilt °', 0, 4, 0.1],
      ['shift', 'Shift', 0, 20, 0.5],
      ['smooth', 'Tidy edges', 0, 8, 0.5],
    ]],
  ];

  // how each setting may differ between variations: relative to its value,
  // or a whole-number count
  const JITTER = {
    erosion: 'rel', grain: 'rel', blunt: 'rel', bluntCover: 'rel', chipSize: 'rel',
    spread: 'rel', pool: 'rel', blotSize: 'rel', tilt: 'rel', shift: 'rel',
    chips: 'count', blots: 'count',
  };

  const seedFor = (opts, gid) => (Math.imul(opts.seed, 1000003) + Math.imul(gid, 7919)) >>> 0;

  function variantOpts(o, k) {
    const v = { ...o, seed: o.seed + k * 7777 };
    if (k === 0) return strip(v);
    const r = Wear.rng(o.seed * 31 + k * 977);
    const amt = o.variation / 100;
    for (const [key, kind] of Object.entries(JITTER)) {
      const d = (r() * 2 - 1) * amt;
      if (kind === 'rel') v[key] = +(o[key] * (1 + d * 0.45)).toFixed(2);
      else v[key] = Math.max(0, Math.round(o[key] * (1 + d * 0.6)));
    }
    return strip(v);
  }
  // only the wear settings — keeps cache keys stable when UI-only values change
  function strip(v) {
    const out = {};
    for (const k of Object.keys(Wear.DEFAULTS)) out[k] = v[k];
    return out;
  }

  (typeof window !== 'undefined' ? window : self).Recipes = { PRESETS, GROUPS, seedFor, variantOpts };
})();
