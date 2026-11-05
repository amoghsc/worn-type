// Worn Type for Figma — the document side. Reads outlines of the selection and
// writes worn vectors back. The wearing itself happens in the panel (ui.js),
// because Clipper is far too slow in Figma's plugin sandbox.
/* global figma, __html__ */
const WORN_OF = 'wornOf'; //     on a worn vector: id of the layer it was made from
const WORN_OPTS = 'wornOpts'; // on a worn vector: the settings, JSON

figma.showUI(__html__, { width: 340, height: 660, themeColors: true });

const insideInstance = (node) => {
  for (let p = node.parent; p; p = p.parent) if (p.type === 'INSTANCE') return true;
  return false;
};
const hasOutline = (n) => 'fillGeometry' in n && !('children' in n && n.type !== 'BOOLEAN_OPERATION');

// the selection's drawable layers, looking inside frames and groups
function leaves(node, out) {
  if (!node.visible || node.type === 'INSTANCE' || insideInstance(node)) return out;
  if (hasOutline(node)) out.push(node);
  else if ('children' in node) node.children.forEach((c) => leaves(c, out));
  return out;
}

function letterSize(node) {
  if (node.type !== 'TEXT') return Math.max(8, node.height);
  if (typeof node.fontSize === 'number') return node.fontSize;
  const runs = node.getStyledTextSegments(['fontSize']);
  return runs.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a)).fontSize;
}

let readToken = 0;
async function sendSelection() {
  const token = ++readToken;
  const items = [];
  let saved = null;
  const seen = new Set();
  for (const node of figma.currentPage.selection.flatMap((n) => leaves(n, []))) {
    // a worn vector stands for its original, so it can be re-worn from clean outlines
    const sourceId = node.getPluginData(WORN_OF);
    const source = sourceId ? await figma.getNodeByIdAsync(sourceId) : null;
    if (token !== readToken) return;
    const src = source || node;
    if (seen.has(src.id)) continue;
    seen.add(src.id);
    if (source && !saved) saved = node.getPluginData(WORN_OPTS);
    if (src.fillGeometry.length) {
      items.push({
        id: src.id,
        wornId: source ? node.id : null,
        name: src.name,
        em: letterSize(src),
        paths: src.fillGeometry.map((g) => ({ windingRule: g.windingRule, data: g.data })),
      });
    }
  }
  figma.ui.postMessage({ type: 'selection', items, saved: saved ? JSON.parse(saved) : null });
}

// a vector with the layer's fills, strokes and effects, in the layer's place
async function outlined(src) {
  if (src.type === 'TEXT') {
    await Promise.all(src.getRangeAllFontNames(0, src.characters.length).map((f) => figma.loadFontAsync(f)));
  }
  const copy = src.clone();
  copy.visible = true;
  return figma.flatten([copy], src.parent, src.parent.children.indexOf(src) + 1);
}

async function apply({ items, opts }) {
  const made = [];
  for (const it of items) {
    const src = await figma.getNodeByIdAsync(it.id);
    if (!src) continue;
    let worn = it.wornId ? await figma.getNodeByIdAsync(it.wornId) : null;
    if (!worn) {
      worn = await outlined(src);
      worn.name = src.name + ' (worn)';
      worn.setPluginData(WORN_OF, src.id);
    }
    // paths are in the source's coordinates; Figma keeps them where they land
    worn.relativeTransform = src.relativeTransform;
    worn.vectorPaths = it.paths;
    worn.setPluginData(WORN_OPTS, JSON.stringify(opts));
    src.visible = false;
    made.push(worn);
  }
  figma.currentPage.selection = made;
  figma.ui.postMessage({ type: 'done', text: `Worn ${made.length} layer${made.length === 1 ? '' : 's'}. The originals are hidden just below.` });
}

// the backdrop the text sits on, so a frame of white text doesn't vanish
function backdrop(node) {
  for (let p = node.parent; p && p.type !== 'PAGE'; p = p.parent) {
    if ('fills' in p && Array.isArray(p.fills) && p.fills.some((f) => f.visible !== false)) return p.fills;
  }
  return figma.currentPage.backgrounds;
}

// one frame per variation, looping on a prototype timer
async function boil({ frames, fps }) {
  const sources = (await Promise.all(frames[0].map((it) => figma.getNodeByIdAsync(it.id)))).filter(Boolean);
  if (!sources.length) return;
  const boxes = sources.map((n) => n.absoluteBoundingBox);
  const left = Math.min(...boxes.map((b) => b.x)), top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width)), bottom = Math.max(...boxes.map((b) => b.y + b.height));
  const pad = Math.ceil(0.15 * (bottom - top)) + 8;
  const width = right - left + pad * 2, height = bottom - top + pad * 2;

  const made = [];
  for (const [f, items] of frames.entries()) {
    const frame = figma.createFrame();
    frame.name = `Boil ${f + 1}`;
    frame.resize(width, height);
    frame.fills = backdrop(sources[0]);
    frame.x = right + 120 + f * (width + 40);
    frame.y = top - pad;
    for (const it of items) {
      const src = sources.find((n) => n.id === it.id);
      if (!src) continue;
      const v = await outlined(src);
      frame.appendChild(v);
      const [[a, b, x], [c, d, y]] = src.absoluteTransform;
      v.relativeTransform = [[a, b, x - left + pad], [c, d, y - top + pad]];
      v.vectorPaths = it.paths;
    }
    made.push(frame);
  }
  const trigger = { type: 'AFTER_TIMEOUT', timeout: 1 / fps };
  await Promise.all(
    made.map((frame, i) =>
      frame.setReactionsAsync([
        {
          trigger,
          actions: [{ type: 'NODE', destinationId: made[(i + 1) % made.length].id, navigation: 'NAVIGATE', transition: null, preserveScrollPosition: false }],
        },
      ])
    )
  );
  const page = figma.currentPage;
  // Figma starts a flow by itself once frames are linked; keep one, with a clear name
  const others = page.flowStartingPoints.filter((p) => !made.some((f) => f.id === p.nodeId));
  page.flowStartingPoints = [...others, { nodeId: made[0].id, name: `Boil ${others.length + 1}` }];
  figma.viewport.scrollAndZoomIntoView(made);
  figma.ui.postMessage({ type: 'done', text: `Made ${made.length} frames. Press Present to play the loop.` });
}

figma.on('selectionchange', sendSelection);
figma.on('currentpagechange', sendSelection);
figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === 'ready') await sendSelection();
    if (msg.type === 'apply') await apply(msg);
    if (msg.type === 'boil') await boil(msg);
  } catch (e) {
    figma.ui.postMessage({ type: 'done', text: e.message, error: true });
  }
};
