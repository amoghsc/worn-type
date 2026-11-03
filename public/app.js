// Worn Type — editor UI. Runs entirely in the browser.
// One wear effect for the whole font. Each glyph gets N variations of it:
// variation 1 is exactly the settings on screen, the others nudge every
// setting a little (by "Difference") and use a different random pattern.
/* global opentype, Wear, hbjs */
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const RED = 'rgba(224,53,43,.9)';

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

  const state = {
    fonts: [], fontId: null, font: null, buf: null, scale: 1,
    glyph: null, base: null, box: null,
    opts: { ...Wear.DEFAULTS, ...PRESETS['Old press'], seed: 17, count: 5, variation: 30, preset: 'Old press' },
    view: 0, // which variation is shown large
    hb: null, hbFont: null,
    mode: 'worn',
    anim: false,
    align: 'left',
    saving: false,
  };

  // ---------------------------------------------------------------- variations

  const seedFor = (opts, gid) => (Math.imul(opts.seed, 1000003) + Math.imul(gid, 7919)) >>> 0;

  function variantOpts(k) {
    const o = state.opts;
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
  const variants = () => Array.from({ length: state.opts.count }, (_, k) => variantOpts(k));
  const wearNow = (base, box, opts, gid) => Wear.wear(base, { ...opts, seed: seedFor(opts, gid) }, box);

  // ---------------------------------------------------------------- outlines + worker pool

  const outlines = new Map(); // gid → {base, box}
  const worn = new Map(); //     gid|opts → Promise<paths>
  const ready = new Map(); //    gid|opts → paths
  const pendingKeys = new Set();

  function outlineOf(gid) {
    let o = outlines.get(gid);
    if (!o) {
      const g = state.font.glyphs.get(gid);
      const base = Wear.fromCommands(g.path.commands, state.scale);
      o = { base, box: Wear.bounds(base), empty: !base.length };
      outlines.set(gid, o);
    }
    return o;
  }

  const POOL = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
  const waiting = new Map();
  let workers = null, taskId = 0;

  function startWorkers() {
    workers = Array.from({ length: POOL }, () => {
      const w = new Worker('wear-worker.js');
      w.busy = 0;
      w.onmessage = (e) => {
        w.busy--;
        const cb = waiting.get(e.data.id);
        waiting.delete(e.data.id);
        cb?.(e.data.paths);
      };
      return w;
    });
  }

  // drop queued work for settings nobody is looking at any more
  function resetPool() {
    if (state.saving || !workers) return;
    workers.forEach((w) => w.terminate());
    workers = null;
    waiting.clear();
    for (const k of pendingKeys) worn.delete(k);
    pendingKeys.clear();
  }

  function wornOf(gid, opts) {
    const key = gid + '|' + JSON.stringify(opts);
    if (!worn.has(key)) {
      const { base, box, empty } = outlineOf(gid);
      if (empty) {
        worn.set(key, Promise.resolve(base));
        ready.set(key, base);
        return worn.get(key);
      }
      if (!workers) startWorkers();
      const w = workers.reduce((a, b) => (b.busy < a.busy ? b : a));
      w.busy++;
      const id = ++taskId;
      pendingKeys.add(key);
      const p = new Promise((resolve) => {
        waiting.set(id, (paths) => {
          pendingKeys.delete(key);
          ready.set(key, paths);
          resolve(paths);
        });
        w.postMessage({ id, base, box, opts: { ...opts, seed: seedFor(opts, gid) } });
      });
      worn.set(key, p);
    }
    return worn.get(key);
  }
  const readyOf = (gid, opts) => ready.get(gid + '|' + JSON.stringify(opts));

  // ---------------------------------------------------------------- drawing

  function frame(canvas, h) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    if (h != null) canvas.style.height = h + 'px';
    else h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = $('#pBg').value;
    ctx.fillRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function tracePaths(ctx, paths, v) {
    ctx.beginPath();
    for (const p of paths) {
      p.forEach((pt, i) => {
        const x = v.ox + pt.X * v.k, y = v.oy - pt.Y * v.k;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.closePath();
    }
  }

  // same framing for original and worn so they line up exactly
  function glyphView(w, h) {
    const f = state.font, s = state.scale, b = state.box;
    const air = f.unitsPerEm * 0.1 * s;
    const xh = (f.tables.os2?.sxHeight || 0) * s;
    const top = Math.max(xh, b.yMax) + air, bot = Math.min(0, b.yMin) - air;
    const left = b.xMin - air, right = b.xMax + air;
    const k = Math.min(w / (right - left), h / (top - bot));
    return { k, ox: (w - (right - left) * k) / 2 - left * k, oy: (h - (top - bot) * k) / 2 + top * k };
  }

  function drawBig(canvas, paths, ghost) {
    const { ctx, w, h } = frame(canvas);
    if (!state.base) return;
    const v = glyphView(w, h);
    ctx.strokeStyle = 'rgba(128,128,128,.25)';
    ctx.lineWidth = 1;
    for (const y of [0, state.font.tables.os2?.sxHeight || 0]) {
      const py = Math.round(v.oy - y * state.scale * v.k) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(w, py);
      ctx.stroke();
    }
    ctx.fillStyle = $('#pInk').value;
    tracePaths(ctx, paths, v);
    ctx.fill('evenodd');
    if (ghost) {
      ctx.strokeStyle = RED;
      ctx.lineWidth = 1.25;
      tracePaths(ctx, state.base, v);
      ctx.stroke();
    }
  }

  let glyphRaf = 0;
  function drawGlyphs() {
    if (glyphRaf) return;
    glyphRaf = requestAnimationFrame(() => {
      glyphRaf = 0;
      if (!state.base) return;
      const vs = variants();
      state.view = Math.min(state.view, vs.length - 1);
      const gid = state.glyph.index;
      const all = vs.map((o) => wearNow(state.base, state.box, o, gid));
      drawBig($('#orig'), state.base);
      drawBig($('#worn'), all[state.view], $('#ghost').checked ? state.base : null);
      $('#variantLabel').textContent = vs.length > 1 ? `variation ${state.view + 1} of ${vs.length}` : '';
      const thumbs = $('#thumbs');
      if (thumbs.children.length !== vs.length) {
        thumbs.innerHTML = vs.map((_, i) => `<button data-i="${i}"><canvas></canvas></button>`).join('');
      }
      [...thumbs.children].forEach((b, i) => {
        b.classList.toggle('on', i === state.view);
        drawBig(b.firstChild, all[i]);
      });
    });
  }

  // ---------------------------------------------------------------- paragraph

  const SAMPLE_LATIN =
    'Every sheet that came off the old press carried a little of the press itself: a corner softened by ten thousand impressions, a serif nicked when the forme was locked up too tight, ink pooling where two strokes met. No two letters were ever quite the same.';
  const SAMPLE_DEVA = 'पावसाळ्यात नदीकाठची गावं हिरवीगार होतात। कुठं जाणार कुठं थांबणार। चालत राहणार गाणं गात गात। कमळ कणकण कलश।';

  function shape(text) {
    const b = state.hb.createBuffer();
    b.addText(text);
    b.guessSegmentProperties();
    state.hb.shape(state.hbFont, b);
    const out = b.json();
    b.destroy();
    return out;
  }

  // stable pseudo-random pick of a variation per glyph position
  const pick = (i, gid, n) => ((Math.imul(i + 1, 2654435761) ^ Math.imul(gid, 40503)) >>> 0) % n;

  let paraToken = 0, paraTimer = 0, layout = [], para = null;
  function scheduleParagraph(delay = 0) {
    clearTimeout(paraTimer);
    paraTimer = setTimeout(drawParagraph, delay);
  }

  // choice[i]: which variation glyph i shows, or -1 for the original.
  // Yields each visible glyph's outline and where it sits on the page.
  function* placed(choice) {
    const { size, k, pad, lineH, vs } = para;
    const s = 1 / state.scale; // clipper units → font units
    for (const [i, g] of layout.entries()) {
      const o = outlineOf(g.gid);
      if (o.empty || g.gid === 0) continue; // no box for characters the font lacks
      const c = choice[i];
      const paths = (c >= 0 && vs[c] && readyOf(g.gid, vs[c])) || o.base;
      const by = pad + size * 0.95 + g.line * lineH;
      g.box = [pad + g.x, by - size, g.w, size * 1.3];
      yield { paths, v: { k: k * s, ox: pad + g.x, oy: by - g.dy } };
    }
  }

  let shown = [];
  function paintParagraph(choice) {
    if (!para) return;
    shown = choice;
    const { ctx } = frame($('#para'), para.h);
    ctx.fillStyle = $('#pInk').value;
    for (const { paths, v } of placed(choice)) {
      tracePaths(ctx, paths, v);
      ctx.fill('evenodd');
    }
  }

  // the paragraph exactly as on screen (this animation frame too), as vector shapes
  async function downloadSvg() {
    if (!para) return;
    const choice = shown.slice();
    await Promise.all(layout.map((g, i) => choice[i] >= 0 && para.vs[choice[i]] && wornOf(g.gid, para.vs[choice[i]])));
    const r = (n) => Math.round(n * 10) / 10;
    const d = [];
    for (const { paths, v } of placed(choice)) {
      for (const p of paths) d.push('M' + p.map((pt) => r(v.ox + pt.X * v.k) + ' ' + r(v.oy - pt.Y * v.k)).join('L') + 'Z');
    }
    const w = Math.round($('#para').clientWidth), h = Math.round(para.h);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n` +
      `<rect width="100%" height="100%" fill="${$('#pBg').value}"/>\n` +
      `<path fill="${$('#pInk').value}" fill-rule="evenodd" d="${d.join('')}"/>\n</svg>\n`;
    const name = (state.font.names.fontFamily?.en || 'text').replace(/[^\w-]+/g, '') + (state.mode === 'worn' ? '-worn' : '') + '.svg';
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setStatus(`Downloaded <b>${name}</b> (${Math.round(svg.length / 1024)} KB)`);
  }

  async function drawParagraph() {
    if (!state.hbFont) return;
    const token = ++paraToken;
    const canvas = $('#para');
    const size = +$('#pSize').value, lead = +$('#pLead').value;
    const track = (+$('#pTrack').value / 1000) * size;
    const pad = Math.max(16, size * 0.5);
    const maxW = canvas.clientWidth - pad * 2;
    const k = size / state.font.unitsPerEm; // px per font unit
    const spaceW = (shape(' ')[0]?.ax || state.font.unitsPerEm * 0.25) * k + track;

    // greedy word wrap on shaped words
    layout = [];
    let x = 0, line = 0;
    for (const p of $('#pText').value.split('\n')) {
      for (const word of p.split(/ +/)) {
        if (!word) continue;
        const gl = shape(word);
        const wpx = gl.reduce((a, g) => a + g.ax * k + track, 0);
        if (x > 0 && x + wpx > maxW) {
          x = 0;
          line++;
        }
        for (const g of gl) {
          layout.push({ gid: g.g, x: x + g.dx * k, line, dy: g.dy * k, w: g.ax * k });
          x += g.ax * k + track;
        }
        x += spaceW;
      }
      x = 0;
      line++;
    }
    // alignment: shift each line by its leftover width
    const lineW = [];
    for (const g of layout) lineW[g.line] = Math.max(lineW[g.line] || 0, g.x + g.w);
    const shiftOf = (l) => (state.align === 'left' ? 0 : (maxW - (lineW[l] || 0)) * (state.align === 'center' ? 0.5 : 1));
    for (const g of layout) g.x += shiftOf(g.line);
    const lineH = size * lead;
    const h = Math.max(lineH * line + pad * 2 - lineH + size, 80);

    const vs = variants();
    para = { size, k, pad, lineH, h, vs };
    const worn = state.mode === 'worn';
    const choice = layout.map((g, i) => (worn ? pick(i, g.gid, vs.length) : -1));
    anim.choice = choice.slice();
    paintParagraph(choice);
    if (!worn) return;
    // animating needs every variation of every glyph on the page
    const jobs = state.anim
      ? layout.flatMap((g) => vs.map((o) => wornOf(g.gid, o)))
      : layout.map((g, i) => wornOf(g.gid, vs[choice[i]]));
    if (layout.every((g, i) => outlineOf(g.gid).empty || readyOf(g.gid, vs[choice[i]]))) return;
    await Promise.all(jobs);
    if (token === paraToken && !state.anim) paintParagraph(choice);
  }

  // hand-drawn "boil": every frame each letter swaps to another of its variations
  const anim = { timer: 0, frame: 0, choice: [] };
  function animTick() {
    if (!para || state.mode !== 'worn') return;
    const n = para.vs.length;
    if (n < 2) return;
    anim.frame++;
    anim.choice = layout.map((g, i) => {
      const prev = anim.choice[i] >= 0 ? anim.choice[i] : 0;
      const next = (prev + 1 + (pick(i + anim.frame * 7919, g.gid, n - 1))) % n;
      return readyOf(g.gid, para.vs[next]) ? next : prev;
    });
    paintParagraph(anim.choice);
  }
  function setAnim(on) {
    state.anim = on;
    $('#pAnim').classList.toggle('on', on);
    clearInterval(anim.timer);
    if (on) {
      if (state.mode !== 'worn') setMode('worn');
      anim.timer = setInterval(animTick, 1000 / FPS);
    }
    scheduleParagraph();
  }
  const FPS = 8; // "on threes", like hand-drawn animation

  function setMode(mode) {
    state.mode = mode;
    const [w, o] = $('#pMode').querySelectorAll('span');
    w.classList.toggle('on', mode === 'worn');
    o.classList.toggle('on', mode === 'orig');
    scheduleParagraph();
  }

  // ---------------------------------------------------------------- controls

  function buildControls() {
    $('#preset').innerHTML = Object.keys(PRESETS).map((p) => `<option>${p}</option>`).join('') + '<option disabled>Custom</option>';
    $('#sliders').innerHTML = GROUPS.map(
      ([title, rows]) =>
        `<div class="group"><h3>${title}</h3>${rows
          .map(([k, label, a, b, step]) =>
            Array.isArray(a)
              ? `<div class="sl"><span>${label}</span><div class="opts" data-k="${k}">${a.map((x) => `<button data-v="${x}">${x}</button>`).join('')}</div></div>`
              : `<label class="sl"><span>${label}</span><input type="range" data-k="${k}" min="${a}" max="${b}" step="${step}"><output></output></label>`
          )
          .join('')}</div>`
    ).join('');
    syncControls();
  }

  function syncControls() {
    const o = state.opts;
    for (const el of document.querySelectorAll('#sliders input[data-k]')) {
      el.value = o[el.dataset.k];
      el.nextElementSibling.textContent = o[el.dataset.k];
    }
    for (const el of document.querySelectorAll('#sliders .opts')) {
      for (const b of el.children) b.classList.toggle('on', b.dataset.v === o[el.dataset.k]);
    }
    $('#preset').value = o.preset;
    $('#seed').textContent = '#' + o.seed;
  }

  function settingsChanged() {
    resetPool();
    drawGlyphs();
    scheduleParagraph(120);
  }

  // ---------------------------------------------------------------- fonts
  // One list from several sources: files dropped in, fonts on this device
  // (Local Font Access API in Chrome/Edge, or the optional local server), and
  // Google Fonts (static files from Fontsource's CDN). Each entry knows how to
  // fetch its own bytes; nothing is ever uploaded.

  const GF_LIST = 'https://api.fontsource.org/v1/fonts?type=google';
  const GF_FILE = (id, subset, weight, style) => `https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/${subset}-${weight}-${style}.ttf`;
  const WEIGHT_NAMES = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
  // subsets that only extend a script; the script picker hides them when there's a main one
  const EXTRA_SUBSET = /^(latin-ext|cyrillic-ext|greek-ext|vietnamese|math|symbols|emoji|menu)$/;
  const SCRIPT_ORDER = ['devanagari', 'latin'];

  const sources = { upload: [], server: [], device: [], google: [] };
  const uploads = new Map(); // key → ArrayBuffer
  let deviceFonts = new Map(); // postscriptName → FontData

  function mergeFonts() {
    const seen = new Set([...sources.server].map((f) => f.family + '|' + f.style));
    const device = sources.device.filter((f) => !seen.has(f.family + '|' + f.style));
    state.fonts = [...sources.upload, ...sources.server, ...device, ...sources.google];
  }

  const fetchBuf = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} fetching font`);
    return r.arrayBuffer();
  };

  async function loadServerFonts() {
    try {
      const r = await fetch('api/fonts');
      if (!r.ok) return;
      sources.server = (await r.json()).map((f) => ({ ...f, id: 's' + f.id, src: { kind: 'server', sid: f.id } }));
    } catch {
      /* static hosting — no local server */
    }
  }

  async function loadGoogleFonts() {
    try {
      const list = await (await fetch(GF_LIST)).json();
      sources.google = list.flatMap((g) =>
        g.styles.flatMap((st) =>
          g.weights.map((w) => ({
            id: `g:${g.id}:${w}:${st}`,
            group: 'Google Fonts',
            family: g.family,
            style: (WEIGHT_NAMES[w] || w) + (st === 'italic' ? ' Italic' : ''),
            weight: w,
            italic: st === 'italic',
            src: { kind: 'google', fsId: g.id, weight: w, style: st, subsets: g.subsets },
          }))
        )
      );
    } catch {
      setStatus("Couldn't reach Google Fonts — device fonts and uploads still work", true);
    }
  }

  const weightOf = (style) => {
    const s = style.toLowerCase().replace(/[\s-]/g, '');
    for (const [re, w] of [[/thin|hairline/, 100], [/(extra|ultra)light/, 200], [/light/, 300], [/medium/, 500], [/(semi|demi)bold/, 600], [/(extra|ultra)bold|heavy/, 800], [/black/, 900], [/bold/, 700]])
      if (re.test(s)) return w;
    return 400;
  };

  // ask: true when the user clicked the button (the browser needs that to show its prompt)
  async function loadDeviceFonts(ask) {
    if (!('queryLocalFonts' in window)) return;
    if (!ask) {
      try {
        if ((await navigator.permissions.query({ name: 'local-fonts' })).state !== 'granted') return;
      } catch {
        return;
      }
    }
    try {
      const list = await window.queryLocalFonts();
      deviceFonts = new Map(list.map((f) => [f.postscriptName, f]));
      sources.device = list.map((f) => ({
        id: 'd:' + f.postscriptName,
        group: 'This device',
        family: f.family,
        style: f.style,
        weight: weightOf(f.style),
        italic: /italic|oblique/i.test(f.style),
        src: { kind: 'device', ps: f.postscriptName },
      }));
      $('#deviceFonts').hidden = true;
      mergeFonts();
      fillFamilies();
      if (ask) setStatus(`${list.length} fonts from this device added to the list`);
    } catch (e) {
      if (ask) setStatus("The browser didn't share this device's fonts — you can still drop a font file in", true);
    }
  }

  const familyKey = (f) => f.group + '\u0001' + f.family;
  const fontById = (id) => state.fonts.find((f) => f.id === id);

  function fillFamilies(selectId) {
    const q = $('#familyFilter').value.trim().toLowerCase();
    const cur = fontById(selectId ?? state.fontId);
    const groups = {};
    const seen = new Set();
    for (const f of state.fonts) {
      const key = familyKey(f);
      if (seen.has(key)) continue;
      if (q && !f.family.toLowerCase().includes(q) && key !== (cur && familyKey(cur))) continue;
      seen.add(key);
      (groups[f.group] ||= []).push(f);
    }
    const sel = $('#family');
    sel.innerHTML = '';
    for (const [g, fams] of Object.entries(groups)) {
      const og = document.createElement('optgroup');
      og.label = g;
      for (const f of fams.sort((a, b) => a.family.localeCompare(b.family))) {
        og.appendChild(new Option(f.family, familyKey(f), false, cur && familyKey(f) === familyKey(cur)));
      }
      sel.appendChild(og);
    }
    fillStyles(cur ? familyKey(cur) : sel.value, cur?.id);
  }

  function fillStyles(key, selectId) {
    const files = state.fonts
      .filter((f) => familyKey(f) === key)
      .sort((a, b) => a.italic - b.italic || a.weight - b.weight || a.style.localeCompare(b.style));
    const dupes = new Set(files.map((f) => f.style).filter((s, i, a) => a.indexOf(s) !== i));
    $('#style').innerHTML = files
      .map((f) => `<option value="${f.id}"${f.id === selectId ? ' selected' : ''}>${f.style}${dupes.has(f.style) && f.file ? ` (${f.file})` : ''}</option>`)
      .join('');
    if (selectId == null) {
      const regular = files.find((f) => !f.italic && /^(regular|book|roman|normal)$/i.test(f.style)) || files[0];
      if (regular) $('#style').value = regular.id;
    }
  }

  // Google families come split by script; offer the main scripts
  function fillScripts(f, want) {
    const sel = $('#script');
    const subs = f?.src.kind === 'google' ? f.src.subsets : [];
    const main = subs.filter((x) => !EXTRA_SUBSET.test(x));
    const opts = main.length ? main : subs;
    opts.sort((a, b) => ((SCRIPT_ORDER.indexOf(a) + 1 || 99) - (SCRIPT_ORDER.indexOf(b) + 1 || 99)));
    sel.innerHTML = opts.map((x) => `<option value="${x}">${x.replace(/-/g, ' ')}</option>`).join('');
    sel.parentElement.hidden = opts.length < 2;
    if (opts.length) sel.value = opts.includes(want) ? want : opts[0];
  }

  async function fontBytes(f) {
    const s = f.src;
    if (s.kind === 'server') return fetchBuf(`api/font?id=${s.sid}`);
    if (s.kind === 'device') return (await deviceFonts.get(s.ps).blob()).arrayBuffer();
    if (s.kind === 'google') return fetchBuf(GF_FILE(s.fsId, $('#script').value || 'latin', s.weight, s.style));
    return uploads.get(s.key);
  }

  async function loadFont(id, script) {
    const f = fontById(id);
    if (!f) return;
    fillScripts(f, script ?? $('#script').value);
    setStatus('Loading font…');
    let buf;
    try {
      buf = await fontBytes(f);
      state.font = opentype.parse(buf);
    } catch (e) {
      return setStatus(`Can't read this font: ${e.message}`, true);
    }
    state.fontId = id;
    state.buf = buf;
    $('#familyBase').textContent = state.font.names.fontFamily?.en || f.family;
    state.scale = Wear.EM / state.font.unitsPerEm;
    outlines.clear();
    worn.clear();
    ready.clear();
    resetPool();

    if (state.hbFont) state.hbFont.destroy();
    const blob = state.hb.createBlob(buf);
    state.hbFont = state.hb.createFont(state.hb.createFace(blob, 0));

    const has = (c) => state.font.charToGlyph(c).index > 0;
    const latin = has('a');
    if (!latin) $('#scope').value = $('#scope').value === 'latin' ? 'all' : $('#scope').value;
    const text = $('#pText');
    if (!text.dataset.touched || [...text.value].some((c) => !/\s/.test(c) && !has(c))) {
      text.value = latin ? SAMPLE_LATIN : SAMPLE_DEVA;
    }
    const ch = [...$('#char').value][0];
    if (!ch || !has(ch)) $('#char').value = [...'gaकअ'].find(has) || [...text.value].find((c) => !/\s/.test(c) && has(c)) || '';
    selectGlyph(state.font.charToGlyph([...$('#char').value][0] || ' '));
    updateScopeCount();
    scheduleParagraph();
    setStatus('');
  }

  function selectGlyph(glyph) {
    if (!glyph || glyph.index === 0) {
      state.base = null;
      drawBig($('#orig'));
      drawBig($('#worn'));
      return setStatus(`“${$('#char').value}” isn't in this font`, true);
    }
    state.glyph = glyph;
    const o = outlineOf(glyph.index);
    state.base = o.base;
    state.box = o.box;
    const cp = glyph.unicode ? ' · U+' + glyph.unicode.toString(16).toUpperCase().padStart(4, '0') : '';
    $('#glyphLabel').textContent = (glyph.name || 'glyph ' + glyph.index) + cp;
    drawGlyphs();
  }

  async function upload(file) {
    if (!/\.(ttf|otf)$/i.test(file.name)) return setStatus('Drop a .ttf or .otf font file', true);
    const buf = await file.arrayBuffer();
    let font;
    try {
      font = opentype.parse(buf);
    } catch (e) {
      return setStatus(`Can't read this font: ${e.message}`, true);
    }
    const key = file.name + ':' + file.size;
    uploads.set(key, buf);
    idb('uploads', 'readwrite', (st) => st.put(buf, key)).catch(() => {});
    addUpload(key, font, file.name);
    mergeFonts();
    fillFamilies('u:' + key);
    loadFont('u:' + key);
  }

  function addUpload(key, font, file) {
    if (sources.upload.some((f) => f.src.key === key)) return;
    const style = font.names.fontSubfamily?.en || 'Regular';
    sources.upload.push({
      id: 'u:' + key, group: 'Dropped in', file,
      family: font.names.fontFamily?.en || file.replace(/\.\w+$/, ''),
      style, weight: font.tables.os2?.usWeightClass || weightOf(style), italic: /italic|oblique/i.test(style),
      src: { kind: 'upload', key },
    });
  }

  // ---------------------------------------------------------------- browser storage

  let dbp = null;
  const db = () =>
    (dbp ||= new Promise((res, rej) => {
      const r = indexedDB.open('worn-type', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('projects', { keyPath: 'id' });
        r.result.createObjectStore('uploads');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  async function idb(store, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => res(req?.result);
      tx.onerror = () => rej(tx.error);
    });
  }

  // ---------------------------------------------------------------- save

  const LATIN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  function scopeGids() {
    const f = state.font, mode = $('#scope').value;
    const byChars = (s) => [...s].map((c) => f.charToGlyph(c).index);
    let ids;
    if (mode === 'latin') ids = byChars(LATIN);
    else if (mode === 'custom') ids = byChars($('#customChars').value.replace(/\s/g, ''));
    else if (mode === 'text') ids = $('#pText').value.split(/\s+/).filter(Boolean).flatMap((w) => shape(w).map((g) => g.g));
    else {
      ids = [];
      for (let i = 1; i < f.glyphs.length; i++) if (mode === 'all' || f.glyphs.get(i).unicodes?.length) ids.push(i);
    }
    return [...new Set(ids)]
      .filter((i) => i > 0 && !/\.worn/.test(f.glyphs.get(i).name || '') && !outlineOf(i).empty)
      .sort((a, b) => a - b);
  }

  function updateScopeCount() {
    if (!state.font) return;
    $('#customChars').hidden = $('#scope').value !== 'custom';
    const n = scopeGids().length;
    $('#scopeCount').textContent = `${n} glyphs × ${state.opts.count} variations`;
  }

  // everything needed to reopen a saved font and keep editing it
  function projectState() {
    const f = fontById(state.fontId);
    const suffix = $('#suffix').value.trim() || 'Worn';
    const family = `${$('#familyBase').textContent} ${suffix}`;
    return {
      id: `${family} ${f.style}`,
      family, style: f.style,
      source: { id: f.id, kind: f.src.kind, family: f.family, style: f.style, script: $('#script').value, key: f.src.key },
      opts: state.opts,
      char: $('#char').value,
      scope: $('#scope').value,
      custom: $('#customChars').value,
      suffix,
      para: {
        text: $('#pText').value, size: +$('#pSize').value, lead: +$('#pLead').value, track: +$('#pTrack').value,
        align: state.align, bg: $('#pBg').value, ink: $('#pInk').value,
      },
      savedAt: Date.now(),
    };
  }

  // the font writer: fontTools running in Pyodide, in its own worker
  let writer = null, writeId = 0;
  const writeWaiting = new Map();
  function writeFont(msg) {
    if (!writer) {
      writer = new Worker('save-worker.js');
      writer.onmessage = (e) => {
        const cb = writeWaiting.get(e.data.id);
        writeWaiting.delete(e.data.id);
        cb?.(e.data);
      };
    }
    return new Promise((res, rej) => {
      const id = ++writeId;
      writeWaiting.set(id, (d) => (d.ok ? res(d.res) : rej(new Error(d.error))));
      writer.postMessage({ id, ...msg });
    });
  }
  let writerBoot = null;
  const warmWriter = () => (writerBoot ||= writeFont({ kind: 'boot' }).catch((e) => ((writerBoot = null), Promise.reject(e))));

  // Save font: remember the settings in this browser, to reopen and keep editing
  async function saveProject() {
    if (!state.font) return;
    const p = projectState();
    try {
      await idb('projects', 'readwrite', (st) => st.put(p));
    } catch (e) {
      return setStatus("This browser won't store saved fonts: " + e.message, true);
    }
    await loadProjects(p.id);
    setStatus(`Saved <b>${p.id}</b> in this browser — reopen it any time from Saved. Download builds the font file.`);
  }

  // Download: wear every glyph in scope, write the font, hand over the file
  async function download() {
    const gids = scopeGids();
    if (!gids.length) return setStatus('Nothing to wear', true);
    const btns = [$('#save'), $('#download')];
    btns.forEach((b) => (b.disabled = true));
    state.saving = true;
    const vs = variants();
    const total = gids.length * vs.length;
    let n = 0;
    try {
      const booting = warmWriter();
      const items = await Promise.all(
        gids.map(async (gid) => ({
          gid,
          variants: await Promise.all(
            vs.map(async (o) => {
              const p = await wornOf(gid, o);
              if (++n % 10 === 0 || n === total) setStatus(`Wearing… ${n} / ${total}`);
              return p;
            })
          ),
        }))
      );
      setStatus('Loading the font writer (first time takes a few seconds)…');
      await booting;
      setStatus(`Writing font with ${total} worn glyphs…`);
      const round = (paths) =>
        Wear.toContours(paths, state.scale).map((c) => ({ hole: c.hole, pts: c.pts.map(([x, y]) => [Math.round(x), Math.round(y)]) }));
      const res = await writeFont({
        kind: 'save',
        font: new Uint8Array(state.buf.slice(0)),
        suffix: $('#suffix').value.trim() || 'Worn',
        items: JSON.stringify(items.map((it) => ({ gid: it.gid, variants: it.variants.map((p) => ({ contours: round(p) })) }))),
      });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'font/' + res.file.split('.').pop() }));
      const a = document.createElement('a');
      a.href = url;
      a.download = res.file;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setStatus(`Downloaded <b>${res.file}</b> — ${res.count} glyphs × ${vs.length} (${Math.round(res.size / 1024)} KB)`);
    } catch (e) {
      setStatus('Download failed: ' + e.message, true);
    }
    state.saving = false;
    btns.forEach((b) => (b.disabled = false));
  }

  let projects = [];
  async function loadProjects(selectId) {
    try {
      projects = (await idb('projects', 'readonly', (st) => st.getAll())) || [];
    } catch {
      projects = [];
    }
    projects.sort((a, b) => b.savedAt - a.savedAt);
    $('#projects').innerHTML =
      `<option value="">${projects.length ? 'open a saved font…' : 'nothing saved yet'}</option>` +
      projects.map((p) => `<option value="${p.id}"${p.id === selectId ? ' selected' : ''}>${p.id}</option>`).join('');
  }

  async function findSource(src) {
    if (src.kind === 'upload' && !uploads.has(src.key)) {
      const buf = await idb('uploads', 'readonly', (st) => st.get(src.key)).catch(() => null);
      if (buf) {
        uploads.set(src.key, buf);
        addUpload(src.key, opentype.parse(buf), src.key.replace(/:\d+$/, ''));
        mergeFonts();
      }
    }
    return fontById(src.id) || state.fonts.find((f) => f.family === src.family && f.style === src.style);
  }

  async function openProject(id) {
    const p = projects.find((x) => x.id === id);
    if (!p) return;
    const f = await findSource(p.source);
    if (!f) {
      const hint = p.source.kind === 'device' && 'queryLocalFonts' in window ? ' — click Device fonts first' : '';
      return setStatus(`Can't find the source font ${p.source.family} ${p.source.style}${hint}`, true);
    }
    fillFamilies(f.id);
    await loadFont(f.id, p.source.script);
    state.opts = { ...Wear.DEFAULTS, ...p.opts };
    syncControls();
    const q = p.para || {};
    for (const [id, v] of [['pSize', q.size], ['pLead', q.lead], ['pTrack', q.track], ['pBg', q.bg], ['pInk', q.ink]]) {
      if (v == null) continue;
      $('#' + id).value = v;
      if ($('#' + id).nextElementSibling?.tagName === 'OUTPUT') $('#' + id).nextElementSibling.textContent = v;
    }
    state.align = q.align || 'left';
    $('#pAlign').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.a === state.align));
    if (q.text) {
      $('#pText').value = q.text;
      $('#pText').dataset.touched = '1';
    }
    $('#scope').value = p.scope || 'text';
    $('#customChars').value = p.custom || '';
    $('#suffix').value = p.suffix || 'Worn';
    if (p.char) {
      $('#char').value = p.char;
      selectGlyph(state.font.charToGlyph([...p.char][0]));
    }
    updateScopeCount();
    settingsChanged();
    setStatus(`Opened <b>${p.id}</b> — keep editing, then Save font to update it.`);
  }

  function setStatus(html, err) {
    const el = $('#status');
    el.innerHTML = html;
    el.classList.toggle('err', !!err);
  }

  // ---------------------------------------------------------------- wiring

  // Building font files is for local copies only; the shared site exports SVG
  const HOSTED = !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  async function init() {
    document.body.classList.toggle('hosted', HOSTED);
    buildControls();
    for (const el of document.querySelectorAll('.paratools input[type=range]')) el.nextElementSibling.textContent = el.value;
    setStatus('Loading fonts…');
    const [wasm] = await Promise.all([fetchBuf('vendor/hb.wasm'), loadServerFonts(), loadGoogleFonts(), loadDeviceFonts(false)]);
    state.hb = hbjs((await WebAssembly.instantiate(wasm)).instance);
    mergeFonts();
    if (!state.fonts.length) return setStatus('No fonts found — drop a .ttf or .otf file anywhere on the page', true);
    const start =
      state.fonts.find((f) => f.family === 'Georgia' && f.style === 'Regular') ||
      state.fonts.find((f) => f.id === 'g:eb-garamond:400:normal') ||
      state.fonts[0];
    fillFamilies(start.id);
    await loadFont(start.id);

    $('#deviceFonts').hidden = !('queryLocalFonts' in window) || sources.device.length > 0;
    $('#deviceFonts').addEventListener('click', () => loadDeviceFonts(true));
    $('#family').addEventListener('change', (e) => {
      fillStyles(e.target.value);
      loadFont($('#style').value);
    });
    $('#style').addEventListener('change', (e) => loadFont(e.target.value));
    $('#script').addEventListener('change', () => loadFont(state.fontId));
    $('#familyFilter').addEventListener('input', () => fillFamilies());
    $('#char').addEventListener('input', () => {
      const c = [...$('#char').value][0];
      if (state.font && c) selectGlyph(state.font.charToGlyph(c));
    });

    const setOpt = (k, v) => {
      const o = state.opts;
      o[k] = v;
      if (k !== 'count' && k !== 'variation') o.preset = 'Custom';
      if (k === 'count') updateScopeCount();
      syncControls();
      settingsChanged();
    };
    $('#sliders').addEventListener('input', (e) => {
      if (e.target.dataset.k) setOpt(e.target.dataset.k, parseFloat(e.target.value));
    });
    $('#sliders').addEventListener('click', (e) => {
      const b = e.target.closest('.opts button');
      if (b) setOpt(b.parentElement.dataset.k, b.dataset.v);
    });
    $('#preset').addEventListener('change', (e) => {
      const o = state.opts;
      state.opts = { ...Wear.DEFAULTS, ...PRESETS[e.target.value], seed: o.seed, count: o.count, variation: o.variation, preset: e.target.value };
      syncControls();
      settingsChanged();
    });
    $('#reroll').addEventListener('click', () => {
      state.opts.seed = Math.floor(Math.random() * 99999);
      syncControls();
      settingsChanged();
    });
    $('#thumbs').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state.view = +b.dataset.i;
      drawGlyphs();
    });
    $('#ghost').addEventListener('change', drawGlyphs);

    for (const id of ['pSize', 'pLead', 'pTrack']) {
      $('#' + id).addEventListener('input', (e) => {
        e.target.nextElementSibling.textContent = e.target.value;
        scheduleParagraph();
      });
    }
    for (const id of ['pBg', 'pInk']) {
      $('#' + id).addEventListener('input', () => {
        drawGlyphs();
        scheduleParagraph();
      });
    }
    $('#pText').addEventListener('input', (e) => {
      e.target.dataset.touched = '1';
      scheduleParagraph(150);
      if ($('#scope').value === 'text') updateScopeCount();
    });
    const toggleMode = () => setMode(state.mode === 'worn' ? 'orig' : 'worn');
    const toggleAnim = () => setAnim(!state.anim);
    $('#pMode').addEventListener('click', toggleMode);
    $('#pAnim').addEventListener('click', toggleAnim);
    // T flips worn / original, A starts / stops the animation — from anywhere except while typing
    document.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      if ((key !== 't' && key !== 'a') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.closest('input:not([type=range]):not([type=checkbox]), textarea, select')) return;
      e.preventDefault();
      (key === 't' ? toggleMode : toggleAnim)();
    });
    $('#pAlign').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state.align = b.dataset.a;
      $('#pAlign').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      scheduleParagraph();
    });
    // click a letter in the paragraph to edit it — reaches conjuncts too
    $('#para').addEventListener('click', (e) => {
      const r = e.target.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const hit = layout.find((g) => g.box && x >= g.box[0] && x <= g.box[0] + g.box[2] && y >= g.box[1] && y <= g.box[1] + g.box[3] && !outlineOf(g.gid).empty);
      if (!hit) return;
      const glyph = state.font.glyphs.get(hit.gid);
      $('#char').value = glyph.unicode ? String.fromCodePoint(glyph.unicode) : '';
      selectGlyph(glyph);
      $('.left').scrollTo({ top: 0, behavior: 'smooth' });
    });

    $('#scope').addEventListener('change', updateScopeCount);
    $('#customChars').addEventListener('input', updateScopeCount);
    $('#svg').addEventListener('click', downloadSvg);
    if (!HOSTED) {
      $('#save').addEventListener('click', saveProject);
      $('#download').addEventListener('click', download);
      // start fetching the font writer once the pointer heads for the save bar
      $('.savebar').addEventListener('pointerenter', () => warmWriter().catch(() => {}), { once: true });
      $('#projects').addEventListener('change', (e) => openProject(e.target.value));
      loadProjects();
    }
    $('#upload').addEventListener('change', (e) => e.target.files[0] && upload(e.target.files[0]));
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
    });
    let rt;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => (drawGlyphs(), scheduleParagraph()), 100);
    });
  }

  init();
})();
