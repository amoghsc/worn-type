# Worn Type for Figma

Gives selected text and shapes the worn letterpress look, as vector shapes. It uses the same wear
engine and sliders as the web app. Nothing leaves your computer.

## Install

1. In the Figma desktop app, open any design file.
2. Go to **Plugins → Development → Import plugin from manifest…**
3. Choose `figma-plugin/manifest.json`.
4. Run it from **Plugins → Development → Worn Type**.

## Use

1. Select text or shapes. Selecting a frame or group includes the layers inside it.
2. Pick a preset or move the sliders. **Effect size** scales the wear for all selected layers.
   **Animate** previews the boil in the panel.
3. **Apply** adds a worn vector on top of each layer and hides the original just below it.
   Fills, strokes and effects carry over. Select a worn vector later to change its settings and
   apply again; it is re-worn from the original.
4. **Make animated frames** builds one frame per variation next to your selection, linked into a
   prototype loop at 8 fps. Press **Present** to play it. It needs at least 2 variations.

## Limits

- Text becomes outlines, so it can no longer be edited. Change the hidden original, then apply again.
- Layers inside component instances are skipped.
- Mixed-colour text takes one colour.
- Curves become fine polygons, as in the web app.
- Text with mixed sizes uses the size of its longest run for **Effect size**.

## Develop

`ui.html`, `ui.js` and the engine in `../public/` (`wear.js`, `recipes.js`, `vendor/clipper.js`) are
inlined into `dist/ui.html`, because a Figma panel must be one file. Rebuild after any change:

```
python3 figma-plugin/build.py
```

`code.js` is the document side and needs no build. Wearing runs in the panel, because the plugin
sandbox is too slow for Clipper.
