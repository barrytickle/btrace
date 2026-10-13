"""Trace an image with several VTracer settings and score each result.

Usage: python bench.py samples/<image> [...]

For each config: runs vtracer, renders the SVG back at the source size with
resvg, and reports pixel error vs the source, path count and file size.
A contact sheet (source + each render, 3x nearest-neighbour) goes to out/.
"""
import os
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

HERE = Path(__file__).parent
OUT = HERE / "out"

VTRACER = HERE.parent / "target" / "release" / "vtracer.exe"
RESVG = Path.home() / ".cargo" / "bin" / "resvg.exe"

CONFIGS = {
    "default": [],
    "cutout": ["--hierarchical", "cutout"],
    "watershed": ["--clustering", "watershed", "--hierarchical", "cutout"],
    "max4": ["--max-colors", "4", "--hierarchical", "cutout"],
    "palette": ["--palette", "#1a2a6c,#f4f4f6,#f7a21b", "--hierarchical", "cutout"],
    "snap": ["--clustering", "snap", "--hierarchical", "cutout", "--simplify", "0.25"],
    "snap+lines": ["--clustering", "snap", "--hierarchical", "cutout", "--simplify", "0.25", "--lines"],
}
# Optional extra configs from env, e.g. BENCH_ONLY=default,max4
ONLY = os.environ.get("BENCH_ONLY")


def flatten(img: Image.Image) -> np.ndarray:
    """RGBA -> RGB on white, as float array."""
    img = img.convert("RGBA")
    bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
    return np.asarray(Image.alpha_composite(bg, img).convert("RGB"), dtype=np.float32)


def run(src: Path, name: str, args: list[str]) -> dict:
    svg = OUT / f"{src.stem}.{name}.svg"
    png = OUT / f"{src.stem}.{name}.png"
    subprocess.run([str(VTRACER), str(src), str(svg), *args], check=True,
                   capture_output=True)
    w, h = Image.open(src).size
    subprocess.run([str(RESVG), "-w", str(w), "-h", str(h), str(svg), str(png)],
                   check=True, capture_output=True)
    a, b = flatten(Image.open(src)), flatten(Image.open(png))
    text = svg.read_text()
    return {
        "name": name,
        "mae": float(np.abs(a - b).mean()),
        "paths": len(re.findall(r"<path", text)),
        "kb": svg.stat().st_size / 1024,
        "png": png,
    }


def contact_sheet(src: Path, results: list[dict], scale: int = 3) -> Path:
    tiles = [("source", Image.open(src))] + [(r["name"], Image.open(r["png"])) for r in results]
    w, h = Image.open(src).size
    tw, th = w * scale, h * scale + 18
    sheet = Image.new("RGB", (tw * len(tiles), th), (40, 40, 40))
    d = ImageDraw.Draw(sheet)
    for i, (label, im) in enumerate(tiles):
        im = Image.fromarray(flatten(im).astype(np.uint8)).resize((w * scale, h * scale), Image.NEAREST)
        sheet.paste(im, (i * tw, 18))
        d.text((i * tw + 4, 3), label, fill=(230, 230, 230))
    path = OUT / f"{src.stem}.sheet.png"
    sheet.save(path)
    return path


def main() -> None:
    OUT.mkdir(exist_ok=True)
    configs = CONFIGS
    if ONLY:
        configs = {k: v for k, v in CONFIGS.items() if k in ONLY.split(",")}
    for arg in sys.argv[1:]:
        src = Path(arg)
        results = [run(src, n, a) for n, a in configs.items()]
        print(f"\n{src.name}")
        print(f"  {'config':<12}{'error':>8}{'paths':>8}{'KB':>8}")
        for r in results:
            print(f"  {r['name']:<12}{r['mae']:>8.2f}{r['paths']:>8}{r['kb']:>8.1f}")
        print(f"  sheet: {contact_sheet(src, results)}")


if __name__ == "__main__":
    main()
