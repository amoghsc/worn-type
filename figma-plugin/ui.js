// Worn Type for Figma — the panel. Takes outlines from code.js, splits them into
// letters, wears each with the web app's engine, and sends vector paths back.
/* global ClipperLib, Wear, Recipes */
(function () {
  const C = ClipperLib;
  const $ = (s) => document.querySelector(s);
  const { PRESETS, GROUPS, seedFor, variantOpts } = Recipes;
  const FPS = 8; // "on threes", like hand-drawn animation
  const PREVIEW_LETTERS = 250;

  const state = {
    opts: { ...Wear.DEFAULTS, ...PRESETS['Old press'], seed: 17, count: 5, variation: 30, preset: 'Old press', emScale: 100 },
    items: [],
    anim: false,
    busy: false,
  };
  const send = (msg) => parent.postMessage({ pluginMessage: msg }, '*');
  const setStatus = (text, err) => {
    $('#status').textContent = text;
    $('#status').classList.toggle('err', !!err);
  };

  // ---------------------------------------------------------------- outlines → letters

  function commands(data) {
    const t = data.match(/[MLQCZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
    const out = [];
    let i = 0;
    const n = () => +t[i++];
    while (i < t.length) {
      const c = t[i++].toUpperCase();
      if (c === 'M' || c === 'L') out.push({ type: c, x: n(), y: n() });
      else if (c === 'Q') out.push({ type: c, x1: n(), y1: n(), x: n(), y: n() });
      else if (c === 'C') out.push({ type: c, x1: n(), y1: n(), x2: n(), y2: n(), x: n(), y: n() });
      else out.push({ type: 'Z' });
    }
    return out;
  }

  const within = (a, b) => a.xMin >= b.xMin && a.xMax <= b.xMax && a.yMin >= b.yMin && a.yMax <= b.yMax;

  // each outer contour with its holes
  function islands(paths) {
    const parts = paths.map((p) => ({ p, box: Wear.bounds([p]), area: C.Clipper.Area(p) }));
    const outers = parts.filter((x) => x.area > 0).map((x) => ({ ...x, paths: [x.p] }));
    for (const hole of parts.filter((x) => x.area <= 0)) {
      const home = outers
        .filter((o) => within(hole.box, o.box) && C.Clipper.PointInPolygon(hole.p[0], o.p) !== 0)
        .sort((a, b) => a.area - b.area)[0];
      if (home) home.paths.push(hole.p);
    }
    return outers;
  }

  // islands stacked in one column are one letter: the dot of an i, a Devanagari matra
  function groupLetters(parts, em) {
    const sorted = parts.slice().sort((a, b) => a.box.xMin - b.box.xMin);
    const parent = sorted.map((_, i) => i);
    const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    sorted.forEach((a, i) => {
      for (let j = i + 1; j < sorted.length && sorted[j].box.xMin < a.box.xMax; j++) {
        const b = sorted[j];
        const overlap = Math.min(a.box.xMax, b.box.xMax) - b.box.xMin;
        const narrow = Math.min(a.box.xMax - a.box.xMin, b.box.xMax - b.box.xMin);
        const gap = Math.max(a.box.yMin, b.box.yMin) - Math.min(a.box.yMax, b.box.yMax);
        if (overlap > narrow * 0.5 && gap < em * 0.35) parent[root(j)] = root(i);
      }
    });
    const groups = new Map();
    sorted.forEach((x, i) => {
      const r = root(i);
      groups.set(r, [...(groups.get(r) || []), ...x.paths]);
    });
    return [...groups.values()];
  }

  // centred on its own origin, so tilt turns a letter about itself
  function makeLetter(paths, scale) {
    const b = Wear.bounds(paths);
    const cx = Math.round((b.xMin + b.xMax) / 2), cy = Math.round((b.yMin + b.yMax) / 2);
    const base = paths.map((p) => p.map((q) => ({ X: q.X - cx, Y: q.Y - cy })));
    return { base, box: Wear.bounds(base), cx, cy, scale, worn: new Map() };
  }

  const letterCache = new Map();
  function lettersOf(item) {
    const key = item.id + '|' + state.opts.emScale;
    if (letterCache.has(key)) return letterCache.get(key);
    const scale = Wear.EM / ((item.em * state.opts.emScale) / 100);
    const paths = item.paths.flatMap((g) =>
      Wear.fromCommands(commands(g.data), scale, g.windingRule === 'EVENODD' ? C.PolyFillType.pftEvenOdd : C.PolyFillType.pftNonZero)
    );
    const letters = groupLetters(islands(paths), Wear.EM).map((p) => makeLetter(p, scale));
    letterCache.set(key, letters);
    return letters;
  }

  // ---------------------------------------------------------------- wearing

  let settingsGen = 0;
  const clearWorn = () => {
    settingsGen++;
    letterCache.forEach((letters) => letters.forEach((l) => l.worn.clear()));
  };

  // letter i of a frame: each frame moves every letter on to its next variation
  function wornLetter(letter, i, frame) {
    const o = state.opts;
    const k = (i + frame) % o.count;
    if (letter.worn.has(k)) return letter.worn.get(k);
    const opts = variantOpts(o, k);
    let paths = Wear.wear(letter.base, { ...opts, seed: seedFor(opts, i) }, letter.box);
    if (!paths.length) paths = letter.base; // a mark worn away entirely keeps its shape
    const polys = paths.map((p) => p.map((q) => [(q.X + letter.cx) / letter.scale, (q.Y + letter.cy) / letter.scale]));
    letter.worn.set(k, polys);
    return polys;
  }

  const breathe = () => new Promise((r) => setTimeout(r));

  // one array of polygons per letter; stays responsive, gives up if settings change
  async function wearItem(item, frame, limit, onLetter) {
    const gen = settingsGen;
    const letters = lettersOf(item).slice(0, limit);
    const out = [];
    let t = performance.now();
    for (let i = 0; i < letters.length; i++) {
      out.push(wornLetter(letters[i], i, frame));
      if (onLetter) onLetter();
      if (performance.now() - t > 16) {
        await breathe();
        if (gen !== settingsGen) return null;
        t = performance.now();
      }
    }
    return out;
  }

  const num = (n) => +n.toFixed(3);
  const toPaths = (letters) =>
    letters.map((polys) => ({
      windingRule: 'NONZERO',
      data: polys.map((p) => 'M ' + p.map(([x, y]) => num(x) + ' ' + num(y)).join(' L ') + ' Z').join(' '),
    }));

  // ---------------------------------------------------------------- preview

  const canvas = $('#preview');
  let shown = null;

  function paint(letters) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const box = fitBox();
    if (!box) return;
    const air = 16;
    const k = Math.min((w - air * 2) / (box.xMax - box.xMin), (h - air * 2) / (box.yMax - box.yMin));
    const ox = (w - (box.xMax - box.xMin) * k) / 2 - box.xMin * k;
    const oy = (h - (box.yMax - box.yMin) * k) / 2 - box.yMin * k;
    ctx.fillStyle = '#111';
    for (const polys of letters) {
      ctx.beginPath();
      for (const p of polys) {
        p.forEach(([x, y], i) => (i ? ctx.lineTo(ox + x * k, oy + y * k) : ctx.moveTo(ox + x * k, oy + y * k)));
        ctx.closePath();
      }
      ctx.fill();
    }
  }

  // the frame stays put while the letters move
  function fitBox() {
    const letters = state.items.length ? lettersOf(state.items[0]).slice(0, PREVIEW_LETTERS) : [];
    if (!letters.length) return null;
    const xs = letters.flatMap((l) => [l.box.xMin + l.cx, l.box.xMax + l.cx].map((v) => v / l.scale));
    const ys = letters.flatMap((l) => [l.box.yMin + l.cy, l.box.yMax + l.cy].map((v) => v / l.scale));
    return { xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.min(...ys), yMax: Math.max(...ys) };
  }

  let previewTimer = 0, animFrame = 0;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(preview, 60);
  }
  async function preview() {
    if (!state.items.length) return;
    const letters = await wearItem(state.items[0], state.anim ? animFrame : 0, PREVIEW_LETTERS);
    if (!letters) return;
    shown = letters;
    paint(letters);
  }

  let animTimer = 0;
  function setAnim(on) {
    state.anim = on;
    $('#anim').classList.toggle('on', on);
    clearInterval(animTimer);
    animFrame = 0;
    if (on) {
      animTimer = setInterval(() => {
        animFrame = (animFrame + 1) % state.opts.count;
        preview();
      }, 1000 / FPS);
    }
    preview();
  }

  // ---------------------------------------------------------------- controls

  function buildControls() {
    $('#preset').innerHTML = Object.keys(PRESETS).map((p) => `<option>${p}</option>`).join('') + '<option disabled>Custom</option>';
    const groups = [['Size', [['emScale', 'Effect size %', 25, 300, 5]]], ...GROUPS];
    $('#sliders').innerHTML = groups
      .map(([title, rows]) => {
        const body = rows
          .map(([k, label, min, max, step]) =>
            Array.isArray(min)
              ? `<div class="sl"><span>${label}</span><div class="opts" data-k="${k}">${min.map((v) => `<button data-v="${v}">${v}</button>`).join('')}</div></div>`
              : `<label class="sl"><span>${label}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}"><output></output></label>`
          )
          .join('');
        return `<div class="group"><h3>${title}</h3>${body}</div>`;
      })
      .join('');
    syncControls();
  }

  function syncControls() {
    const o = state.opts;
    document.querySelectorAll('input[data-k]').forEach((el) => {
      el.value = o[el.dataset.k];
      el.nextElementSibling.textContent = o[el.dataset.k];
    });
    document.querySelectorAll('.opts').forEach((row) => {
      row.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === o[row.dataset.k]));
    });
    $('#preset').value = o.preset;
    updateButtons();
  }

  function updateButtons() {
    const none = !state.items.length || state.busy;
    $('#apply').disabled = none;
    $('#boil').disabled = none || state.opts.count < 2;
  }

  function settingsChanged() {
    clearWorn();
    schedulePreview();
  }

  function setOpt(k, v) {
    state.opts[k] = v;
    if (k !== 'count' && k !== 'variation' && k !== 'emScale') state.opts.preset = 'Custom';
    syncControls();
    settingsChanged();
  }

  // ---------------------------------------------------------------- actions

  async function wearAll(frames) {
    const total = state.items.reduce((a, it) => a + lettersOf(it).length, 0) * frames;
    let n = 0;
    const out = [];
    for (let f = 0; f < frames; f++) {
      const row = [];
      for (const item of state.items) {
        const letters = await wearItem(item, f, Infinity, () => {
          if (++n % 20 === 0) setStatus(`Wearing… ${n} / ${total}`);
        });
        if (!letters) return null;
        row.push({ id: item.id, wornId: item.wornId, paths: toPaths(letters) });
      }
      out.push(row);
    }
    return out;
  }

  async function run(type, frames) {
    state.busy = true;
    updateButtons();
    try {
      const out = await wearAll(frames);
      if (!out) throw new Error('Settings changed while wearing. Try again.');
      setStatus('Writing to Figma…');
      if (type === 'apply') send({ type, items: out[0], opts: state.opts });
      else send({ type, frames: out, fps: FPS });
    } catch (e) {
      finish(e.message, true);
    }
  }

  function finish(text, err) {
    state.busy = false;
    updateButtons();
    setStatus(text, err);
  }

  function selectionChanged(msg) {
    state.items = msg.items;
    if (msg.saved) {
      state.opts = { ...state.opts, ...msg.saved };
      syncControls();
      clearWorn();
    }
    shown = null;
    $('#empty').hidden = msg.items.length > 0;
    const n = msg.items.length;
    $('#what').textContent = n ? (n === 1 ? msg.items[0].name : `${n} layers`) : '';
    updateButtons();
    if (n) preview();
    else paint([]);
  }

  window.onmessage = (e) => {
    const msg = e.data.pluginMessage;
    if (!msg) return;
    if (msg.type === 'selection') selectionChanged(msg);
    if (msg.type === 'done') finish(msg.text, msg.error);
  };

  buildControls();
  $('#sliders').addEventListener('input', (e) => {
    if (e.target.dataset.k) setOpt(e.target.dataset.k, parseFloat(e.target.value));
  });
  $('#sliders').addEventListener('click', (e) => {
    const b = e.target.closest('.opts button');
    if (b) setOpt(b.parentElement.dataset.k, b.dataset.v);
  });
  $('#preset').addEventListener('change', (e) => {
    const o = state.opts;
    state.opts = { ...Wear.DEFAULTS, ...PRESETS[e.target.value], seed: o.seed, count: o.count, variation: o.variation, emScale: o.emScale, preset: e.target.value };
    syncControls();
    settingsChanged();
  });
  $('#reroll').addEventListener('click', () => {
    state.opts.seed = Math.floor(Math.random() * 99999);
    settingsChanged();
  });
  $('#anim').addEventListener('click', () => setAnim(!state.anim));
  $('#apply').addEventListener('click', () => run('apply', 1));
  $('#boil').addEventListener('click', () => run('boil', state.opts.count));
  window.addEventListener('resize', () => shown && paint(shown));
  send({ type: 'ready' });
})();
