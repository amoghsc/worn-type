#!/usr/bin/env python3
"""Worn Type — optional local server.

The app itself is static (public/) and runs anywhere, e.g. GitHub Pages.
Served from here it also lists the fonts in this Mac's font folders, which
browsers without the Local Font Access API can't see.

Run:  .venv/bin/python server.py   →  http://localhost:5209
"""
import json
import os
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", 5209))
EXTS = {".ttf", ".otf"}

FONT_DIRS = [
    ("This computer", Path.home() / "Library/Fonts"),
    ("Pustak (devanagari-font)", ROOT.parent / "devanagari-font/dist"),
    ("This computer", Path("/Library/Fonts")),
    ("This computer", Path("/System/Library/Fonts")),
    ("This computer", Path("/System/Library/Fonts/Supplemental")),
]

FONTS = []  # [{id, family, style, weight, italic, group, path}]
META_CACHE = ROOT / ".fontmeta.json"


def font_meta(p, cache):
    """family / style / weight from the name and OS/2 tables, cached by mtime."""
    key, mtime = str(p), p.stat().st_mtime
    hit = cache.get(key)
    if hit and hit["mtime"] == mtime:
        return hit
    try:
        f = TTFont(p, lazy=True)
        name = f["name"]
        os2 = f["OS/2"] if "OS/2" in f else None
        meta = {
            "family": name.getBestFamilyName() or p.stem,
            "style": name.getBestSubFamilyName() or "Regular",
            "weight": os2.usWeightClass if os2 else 400,
            "italic": bool(os2.fsSelection & 1) if os2 else False,
        }
        f.close()
    except Exception:
        meta = {"family": p.stem, "style": "Regular", "weight": 400, "italic": False}
    meta["mtime"] = mtime
    cache[key] = meta
    return meta


def scan_fonts():
    FONTS.clear()
    seen = set()
    try:
        cache = json.loads(META_CACHE.read_text())
    except Exception:
        cache = {}
    for group, d in FONT_DIRS:
        if not d.is_dir():
            continue
        for p in sorted(d.iterdir(), key=lambda p: p.name.lower()):
            if p.suffix.lower() in EXTS and p.resolve() not in seen:
                seen.add(p.resolve())
                m = font_meta(p, cache)
                FONTS.append({"id": len(FONTS), "group": group, "path": str(p), "file": p.name,
                              **{k: m[k] for k in ("family", "style", "weight", "italic")}})
    META_CACHE.write_text(json.dumps(cache))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT / "public"), **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # always serve fresh edits
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/" in str(args[0] if args else ""):
            sys.stderr.write("%s\n" % (fmt % args))

    def send_body(self, data, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/fonts":
            scan_fonts()
            keys = ("id", "family", "style", "weight", "italic", "group", "file")
            return self.send_body(json.dumps([{k: f[k] for k in keys} for f in FONTS]).encode(), "application/json")
        if u.path == "/api/font":
            f = FONTS[int(parse_qs(u.query)["id"][0])]
            return self.send_body(Path(f["path"]).read_bytes(), "font/sfnt")
        return super().do_GET()


if __name__ == "__main__":
    scan_fonts()
    print(f"Worn Type → http://localhost:{PORT}  ({len(FONTS)} fonts)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
