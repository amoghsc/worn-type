// Worn Type — batch worker: wears one glyph outline with one recipe.
/* global Wear */
self.window = self; // clipper.js looks for window
importScripts('vendor/clipper.js', 'wear.js');

self.onmessage = (e) => {
  const { id, box, opts } = e.data;
  // structured-cloned points arrive as slow dictionary objects; rebuild them
  const base = e.data.base.map((p) => p.map((q) => new ClipperLib.IntPoint(q.X, q.Y)));
  let paths = Wear.wear(base, opts, box);
  if (!paths.length) paths = base; // a mark worn away entirely keeps its shape
  self.postMessage({ id, paths });
};
