#!/usr/bin/env python3
"""Builds dist/ui.html: Figma panels are a single file, so scripts go inline."""
import re
from pathlib import Path

here = Path(__file__).parent


def inline(match):
    code = (here / match.group(1)).read_text()
    return '<script>\n' + code.replace('</script', '<\\/script') + '\n</script>'


html = re.sub(r'<script src="([^"]+)"></script>', inline, (here / 'ui.html').read_text())
out = here / 'dist' / 'ui.html'
out.parent.mkdir(exist_ok=True)
out.write_text(html)
print(f'{out} ({len(html) // 1024} KB)')
