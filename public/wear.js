// Worn Type — wear engine.
// Works on polygons in "clipper units": font units scaled so 1 em = 4000.
// Every slider value is in ‰ of the em (1‰ = 4 clipper units), so settings
// look the same on a 1000-UPM or 2048-UPM font.
/* global ClipperLib */
(function () {
  const C = ClipperLib;
  const EM = 4000;
  const U = EM / 1000; // clipper units per ‰ em

  // ---------------------------------------------------------------- random

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // seeded 2D gradient noise, output roughly -1..1
  function makeNoise(seed) {
    const r = rng(seed * 7919 + 13);
    const perm = new Uint8Array(512);
    const p = [...Array(256).keys()];
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    const grad = (h, x, y) => {
      const a = (h / 256) * Math.PI * 2;
      return Math.cos(a) * x + Math.sin(a) * y;
    };
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    function noise(x, y) {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const X = xi & 255, Y = yi & 255;
      const aa = perm[perm[X] + Y], ab = perm[perm[X] + Y + 1];
      const ba = perm[perm[X + 1] + Y], bb = perm[perm[X + 1] + Y + 1];
      const u = fade(xf), v = fade(yf);
      const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf));
      const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1));
      return (x1 + v * (x2 - x1)) * 1.4;
    }
    return function fbm(x, y, octaves) {
      let sum = 0, amp = 1, f = 1, norm = 0;
      for (let o = 0; o < octaves; o++) {
        sum += amp * noise(x * f, y * f);
        norm += amp;
        amp *= 0.5;
        f *= 2.1;
      }
      return sum / norm;
    };
  }

  // ---------------------------------------------------------------- clipper helpers

  const fill = C.PolyFillType.pftNonZero;

  function normalize(paths, rule = fill) {
    // resolves overlaps; outers come out with positive area, holes negative
    return C.Clipper.SimplifyPolygons(paths, rule);
  }

  function offset(paths, delta, join) {
    if (!delta) return paths;
    const co = new C.ClipperOffset(2, 0.8 * U);
    co.AddPaths(paths, join ?? C.JoinType.jtRound, C.EndType.etClosedPolygon);
    const out = new C.Paths();
    co.Execute(out, delta);
    // drop near-duplicate points so chained offsets don't snowball
    return C.Clipper.CleanPolygons(out, 0.4 * U);
  }

  function bool(type, a, b) {
    const c = new C.Clipper();
    c.AddPaths(a, C.PolyType.ptSubject, true);
    c.AddPaths(b, C.PolyType.ptClip, true);
    const out = new C.Paths();
    c.Execute(type, out, fill, fill);
    return out;
  }
  const union = (a, b) => bool(C.ClipType.ctUnion, a, b);
  const diff = (a, b) => bool(C.ClipType.ctDifference, a, b);
  const intersect = (a, b) => bool(C.ClipType.ctIntersection, a, b);

  function inside(pt, paths) {
    let w = 0;
    for (const p of paths) {
      if (C.Clipper.PointInPolygon(pt, p) !== 0) w += C.Clipper.Area(p) > 0 ? 1 : -1;
    }
    return w > 0;
  }

  // ---------------------------------------------------------------- outline in / out

  // opentype.js path commands (font units, y-up) → clipper paths
  function fromCommands(cmds, scale, rule) {
    const paths = [];
    let cur = null, x = 0, y = 0;
    const push = (px, py) => cur.push({ X: Math.round(px * scale), Y: Math.round(py * scale) });
    for (const c of cmds) {
      if (c.type === 'M') {
        if (cur && cur.length > 2) paths.push(cur);
        cur = [];
        push(c.x, c.y);
      } else if (c.type === 'L') {
        push(c.x, c.y);
      } else if (c.type === 'Q') {
        for (let i = 1; i <= 10; i++) {
          const t = i / 10, m = 1 - t;
          push(m * m * x + 2 * m * t * c.x1 + t * t * c.x, m * m * y + 2 * m * t * c.y1 + t * t * c.y);
        }
      } else if (c.type === 'C') {
        for (let i = 1; i <= 14; i++) {
          const t = i / 14, m = 1 - t;
          push(
            m * m * m * x + 3 * m * m * t * c.x1 + 3 * m * t * t * c.x2 + t * t * t * c.x,
            m * m * m * y + 3 * m * m * t * c.y1 + 3 * m * t * t * c.y2 + t * t * t * c.y
          );
        }
      } else if (c.type === 'Z') {
        if (cur && cur.length > 2) paths.push(cur);
        cur = null;
        continue;
      }
      x = c.x;
      y = c.y;
    }
    if (cur && cur.length > 2) paths.push(cur);
    return C.Clipper.CleanPolygons(normalize(paths, rule), 0.3 * U);
  }

  // insert points so no edge is longer than `step`
  function resample(path, step) {
    const out = [];
    for (let i = 0; i < path.length; i++) {
      const a = path[i], b = path[(i + 1) % path.length];
      const d = Math.hypot(b.X - a.X, b.Y - a.Y);
      const n = Math.max(1, Math.ceil(d / step));
      for (let k = 0; k < n; k++) out.push({ X: a.X + ((b.X - a.X) * k) / n, Y: a.Y + ((b.Y - a.Y) * k) / n });
    }
    return out;
  }

  // unit normal pointing INTO the ink (material is always on the left of a
  // normalized ring: outers CCW, holes CW)
  function inwardNormals(path) {
    const n = path.length;
    return path.map((p, i) => {
      const a = path[(i - 1 + n) % n], b = path[(i + 1) % n];
      const dx = b.X - a.X, dy = b.Y - a.Y;
      const l = Math.hypot(dx, dy) || 1;
      return { x: -dy / l, y: dx / l };
    });
  }

  function boundarySamples(paths, step) {
    const pts = [];
    for (const p of paths) {
      const rs = resample(p, step);
      const ns = inwardNormals(rs);
      rs.forEach((pt, i) => pts.push({ X: pt.X, Y: pt.Y, n: ns[i] }));
    }
    return pts;
  }

  function blob(cx, cy, r, sides, jag, rnd) {
    const out = [];
    const rot = rnd() * Math.PI * 2;
    for (let i = 0; i < sides; i++) {
      const a = rot + (i / sides) * Math.PI * 2 + (rnd() - 0.5) * (Math.PI / sides);
      const rr = r * (1 - jag * 0.5 + rnd() * jag);
      out.push({ X: Math.round(cx + Math.cos(a) * rr), Y: Math.round(cy + Math.sin(a) * rr) });
    }
    return out;
  }

  // ---------------------------------------------------------------- effects

  const DEFAULTS = {
    seed: 1,
    spread: 0, //        ink gain: + fattens, − thins (‰ em)
    pool: 0, //          ink pooling in joins / ink traps filled (radius ‰)
    blunt: 0, //         corner rounding radius (‰)
    bluntStyle: 'round', // round | cut
    bluntCover: 100, //  % of corners that get worn
    erosion: 0, //       depth of edge wear (‰)
    grain: 40, //        size of wear features (‰) — small = gritty, large = wavy
    chips: 0, //         number of missing fragments
    chipSize: 20, //     ‰
    chipDelicate: 70, // % preference for thin strokes / terminals
    chipShape: 'angular', // angular | rounded
    blots: 0, //         number of ink blots
    blotSize: 14, //     ‰
    smooth: 2, //        final tidy radius (‰)
    tilt: 0, //          max rotation (degrees)
    shift: 0, //         max baseline / sideways shift (‰)
  };

  function wear(src, opts, box) {
    const o = { ...DEFAULTS, ...opts };
    const rnd = rng(o.seed * 101 + 7);
    const noise = makeNoise(o.seed);
    const J = C.JoinType;
    let g = src;

    // 1. ink gain
    if (o.spread) g = offset(g, o.spread * U);

    // 2. ink pooling: morphological closing fills acute joins / ink traps
    if (o.pool > 0) g = offset(offset(g, o.pool * U), -o.pool * U);

    // 3. blunted corners: morphological opening, optionally on only some corners
    if (o.blunt > 0) {
      const r = o.blunt * U;
      const opened = offset(offset(g, -r), r, o.bluntStyle === 'cut' ? J.jtSquare : J.jtRound);
      if (o.bluntCover >= 100) {
        g = opened;
      } else {
        // the slivers lost at each corner; put a random share of them back
        const slivers = diff(g, opened);
        const keep = slivers.filter(() => rnd() * 100 >= o.bluntCover);
        g = keep.length ? union(opened, keep) : opened;
      }
    }

    // 4. surface erosion: push the edge into the ink by smooth noise
    if (o.erosion > 0) {
      const step = Math.max(2 * U, Math.min(o.grain * U * 0.25, 6 * U));
      const freq = 1 / (Math.max(o.grain, 2) * U);
      const depth = o.erosion * U;
      const moved = g.map((p) => {
        const rs = resample(p, step);
        const ns = inwardNormals(rs);
        return rs.map((pt, i) => {
          // bias toward 0..1 so the edge mostly loses material, rarely gains
          const v = Math.max(0, noise(pt.X * freq, pt.Y * freq, 3) * 0.8 + 0.35);
          return { X: Math.round(pt.X + ns[i].x * v * depth), Y: Math.round(pt.Y + ns[i].y * v * depth) };
        });
      });
      g = C.Clipper.CleanPolygons(normalize(moved), 0.5 * U);
    }

    // 5. chipped edges: bite fragments out, preferring delicate parts
    if (o.chips > 0) {
      const samples = boundarySamples(g, 4 * U);
      // delicate = the stroke is thinner than ~56‰ here: probing that far
      // into the ink lands outside it. Checked lazily via rejection sampling.
      const probe = 56 * U;
      const isThin = (s) => !inside({ X: Math.round(s.X + s.n.x * probe), Y: Math.round(s.Y + s.n.y * probe) }, g);
      const bias = 1 + (o.chipDelicate / 100) * 12;
      const picks = [];
      for (let tries = 0; picks.length < o.chips && tries < o.chips * 60; tries++) {
        const s = samples[Math.floor(rnd() * samples.length)];
        if (rnd() * bias <= (isThin(s) ? bias : 1)) picks.push(s);
      }
      const chips = [];
      for (const s of picks) {
        const r = o.chipSize * U * (0.45 + rnd() * 0.9);
        // centre just outside the edge so the chip takes a bite, not a hole
        const out = r * (0.15 + rnd() * 0.45);
        const cx = s.X - s.n.x * out, cy = s.Y - s.n.y * out;
        const angular = o.chipShape === 'angular';
        let b = [blob(cx, cy, r, angular ? 4 + Math.floor(rnd() * 3) : 14, angular ? 0.7 : 0.35, rnd)];
        if (!angular) b = offset(offset(b, -r * 0.2), r * 0.2);
        chips.push(...b);
      }
      g = diff(g, normalize(chips));
    }

    // 6. ink blots: small bulges sitting on the edge
    if (o.blots > 0) {
      const samples = boundarySamples(g, 3 * U);
      const blots = [];
      for (let k = 0; k < o.blots; k++) {
        const s = samples[Math.floor(rnd() * samples.length)];
        const r = o.blotSize * U * (0.4 + rnd() * 0.8);
        const cx = s.X - s.n.x * r * 0.2, cy = s.Y - s.n.y * r * 0.2;
        blots.push(...offset([blob(cx, cy, r * 0.75, 12, 0.5, rnd)], r * 0.25));
      }
      // fuse the blot into the stroke with a little closing
      g = union(g, normalize(blots));
      g = offset(offset(g, 3 * U), -3 * U);
    }

    // 7. tidy: removes slivers and specks so the glyph reads as solid metal
    if (o.smooth > 0) {
      const r = o.smooth * U;
      g = offset(offset(g, -r), r);
      g = offset(offset(g, r), -r);
    }
    g = g.filter((p) => Math.abs(C.Clipper.Area(p)) > (6 * U) ** 2);

    // 8. imperfect setting: a slight tilt and shift of the sort
    if (o.tilt || o.shift) {
      const a = ((rnd() * 2 - 1) * o.tilt * Math.PI) / 180;
      const dx = (rnd() * 2 - 1) * o.shift * U, dy = (rnd() * 2 - 1) * o.shift * U;
      const cx = (box.xMin + box.xMax) / 2, cy = 0;
      const cos = Math.cos(a), sin = Math.sin(a);
      g = g.map((p) =>
        p.map((pt) => ({
          X: Math.round(cx + (pt.X - cx) * cos - (pt.Y - cy) * sin + dx),
          Y: Math.round(cy + (pt.X - cx) * sin + (pt.Y - cy) * cos + dy),
        }))
      );
    }

    return C.Clipper.CleanPolygons(g, 0.6 * U);
  }

  // clipper paths → [{pts:[[x,y]..], hole}] in font units for the server
  function toContours(paths, scale) {
    return paths.map((p) => ({
      hole: C.Clipper.Area(p) < 0,
      pts: p.map((pt) => [pt.X / scale, pt.Y / scale]),
    }));
  }

  function bounds(paths) {
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    for (const p of paths)
      for (const pt of p) {
        if (pt.X < xMin) xMin = pt.X;
        if (pt.X > xMax) xMax = pt.X;
        if (pt.Y < yMin) yMin = pt.Y;
        if (pt.Y > yMax) yMax = pt.Y;
      }
    return { xMin, yMin, xMax, yMax };
  }

  (typeof window !== 'undefined' ? window : self).Wear = { EM, U, DEFAULTS, fromCommands, wear, toContours, bounds, rng, intersect };
})();
