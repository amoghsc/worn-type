# Worn Type

Give a whole font one consistent worn, letterpress look: eroded edges, blunted
corners, chipped thin strokes, ink spread and blots. Each glyph gets a few
slightly different variations, so no two letters print quite alike.

**Use it:** https://amoghsc.github.io/worn-type/ (Chrome, Edge, Firefox or Safari on a computer).

**In Figma:** the [plugin](figma-plugin/README.md) wears selected text and shapes as vectors.

## How to use

1. Pick a **font** and **weight**: any Google Font, or **Device fonts** for the fonts installed
   on your computer (Chrome/Edge ask for permission), or **Open font…** / drop a `.ttf`/`.otf` file.
   Google families that cover several scripts get a **Script** picker (e.g. Devanagari / Latin).
2. Type a **glyph** to look at it large, or click any letter in the paragraph.
3. Move the sliders on the right (or start from a preset). **Variations** sets how many versions
   each glyph gets and how much they differ. **New pattern** keeps the settings and reshuffles the wear.
4. Check the paragraph: size, line height, letter spacing, alignment, colours.
   **T** flips worn / original. **A** animates: letters keep swapping variations, like hand-drawn film.
5. **Download SVG** saves the paragraph exactly as it looks (the current animation frame too) as
   vector shapes, to use in any design app.

Everything runs in your browser; fonts are never uploaded anywhere.

**Worn font files** are built only on a local copy (see *Run locally*), where the save bar also has
**Download** (a renamed copy of the font that swaps the variations in by itself, via OpenType
`rand` / `calt`) and **Save font**. Check the source font's licence before sharing a worn copy.

## How it works

- `public/wear.js` — the wear pipeline on polygons (Clipper): ink spread → ink pooling → blunt corners →
  surface erosion → edge chips (biased to thin strokes) → ink blots → tidy → tilt/shift. Settings are
  in ‰ of the em, so they look the same on any font. Runs on a Web Worker pool (`wear-worker.js`).
- `public/app.js` — UI. Paragraph shaped with HarfBuzz (wasm), so Indic scripts render correctly.
  Google Fonts come from Fontsource's CDN, device fonts from the Local Font Access API.
- `public/wornfont.py` — the font writer (fontTools), run in the browser with Pyodide (`save-worker.js`).
  Alternates `<base>.worn1..N` keep advance widths; GSUB `rand` (HarfBuzz: Chrome, Firefox, Android,
  most design apps), `calt` keyed on the preceding glyph (CoreText), `salt` and a free `ssNN` per
  variation. Kerning, mark anchors and GDEF classes are copied to the alternates.
- Variable fonts are saved at their default instance; CFF2 and .ttc aren't supported.

## Run locally

On `localhost` the app also builds worn font files.

```
python3 -m http.server -d public 5209
```

or `python server.py` (needs `fontTools`), which also lists the fonts in this Mac's font folders.
