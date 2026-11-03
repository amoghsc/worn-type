// Worn Type — font writer worker. Runs wornfont.py (fontTools) in Pyodide so
// fonts are built in the browser; nothing is uploaded anywhere.
/* global loadPyodide */
importScripts('https://cdn.jsdelivr.net/pyodide/v0.29.5/full/pyodide.js');

let ready = null;
async function boot() {
  const py = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.29.5/full/' });
  await py.loadPackage('fonttools');
  const src = await (await fetch('wornfont.py', { cache: 'no-store' })).text();
  py.FS.writeFile('/home/pyodide/wornfont.py', src);
  py.runPython('import sys; sys.path.insert(0, "/home/pyodide")');
  return py;
}

self.onmessage = async (e) => {
  const { id, kind } = e.data;
  try {
    const py = await (ready ||= boot());
    if (kind === 'boot') return self.postMessage({ id, ok: true });
    py.globals.set('font_bytes', e.data.font);
    py.globals.set('items_json', e.data.items);
    py.globals.set('suffix', e.data.suffix);
    const res = py.runPython(`
import json, wornfont
wornfont.save_worn(bytes(font_bytes.to_py()), json.loads(items_json), suffix)
`);
    const out = res.toJs({ dict_converter: Object.fromEntries });
    res.destroy();
    const data = out.data.slice().buffer;
    self.postMessage({ id, ok: true, res: { ...out, data } }, [data]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err.message || err).split('\n').filter(Boolean).pop() });
  }
};
