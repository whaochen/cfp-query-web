"""Build script for the MOENV CFP Query static web app.

Copies frontend assets from `src/` and JSON datasets from `data/` into `dist/`.
Suitable for both local preview and Cloudflare Pages deployment.
"""

from __future__ import annotations

import hashlib
import re
import shutil
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT_DIR / "src"
DATA_DIR = ROOT_DIR / "data"
DIST_DIR = ROOT_DIR / "dist"


def short_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:8]


def build() -> None:
    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)
    DIST_DIR.mkdir(parents=True, exist_ok=True)

    css_hash = short_hash(SRC_DIR / "styles.css")
    js_hash = short_hash(SRC_DIR / "app.js")

    # Copy all static files from src/ to dist/
    for item in SRC_DIR.iterdir():
        target = DIST_DIR / item.name
        if item.is_dir():
            shutil.copytree(item, target)
        elif item.name == "index.html":
            html = item.read_text(encoding="utf-8")
            html = re.sub(r'(\./styles\.css)(?:\?v=[^"\']+)?', rf"\1?v={css_hash}", html)
            html = re.sub(r'(\./app\.js)(?:\?v=[^"\']+)?', rf"\1?v={js_hash}", html)
            target.write_text(html, encoding="utf-8")
        else:
            shutil.copy2(item, target)

    # Copy data/*.json to dist/data/
    dist_data_dir = DIST_DIR / "data"
    dist_data_dir.mkdir(parents=True, exist_ok=True)
    copied_json = 0
    for json_file in sorted(DATA_DIR.glob("*.json")):
        shutil.copy2(json_file, dist_data_dir / json_file.name)
        copied_json += 1

    print(f"Build completed: copied src/ and {copied_json} data JSON file(s) to {DIST_DIR}")


if __name__ == "__main__":
    build()
