"""Sweep one CLI option over values; score each and build a zoomed comparison.

Usage: python sweep.py <image> <flag> <v1,v2,...> [--crop x0,y0,x1,y1] [--zoom N] [extra vtracer args...]
"""
import subprocess, sys, re
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from bench import VTRACER, RESVG, OUT, flatten

src = Path(sys.argv[1]); flag = sys.argv[2]; values = sys.argv[3].split(",")
rest = sys.argv[4:]
crop = None; zoom = 4
if "--crop" in rest:
    i = rest.index("--crop"); crop = tuple(map(int, rest[i + 1].split(","))); del rest[i:i + 2]
if "--zoom" in rest:
    i = rest.index("--zoom"); zoom = int(rest[i + 1]); del rest[i:i + 2]
base = ["--clustering", "snap", "--hierarchical", "cutout", "--simplify", "0.25"] + rest
OUT.mkdir(exist_ok=True)
w, h = Image.open(src).size
tiles = [("source", Image.open(src).convert("RGBA").resize((w * zoom, h * zoom), Image.LANCZOS))]
print(f"{src.name}  {flag}")
for v in values:
    svg = OUT / f"{src.stem}.sweep.{v}.svg"
    subprocess.run([str(VTRACER), str(src), str(svg), *base, flag, v], check=True, capture_output=True)
    small = OUT / "sweep_small.png"; big = OUT / f"{src.stem}.sweep.{v}.png"
    subprocess.run([str(RESVG), "-w", str(w), "-h", str(h), str(svg), str(small)], check=True, capture_output=True)
    subprocess.run([str(RESVG), "-w", str(w * zoom), "-h", str(h * zoom), str(svg), str(big)], check=True, capture_output=True)
    mae = np.abs(flatten(Image.open(src)) - flatten(Image.open(small))).mean()
    paths = len(re.findall("<path", svg.read_text()))
    print(f"  {v:>6}  error {mae:5.2f}  paths {paths:4}  {svg.stat().st_size/1024:6.1f} KB")
    tiles.append((f"{flag} {v}", Image.open(big)))
box = tuple(c * zoom for c in crop) if crop else None
tiles = [(n, Image.fromarray(flatten(t.crop(box) if box else t).astype(np.uint8))) for n, t in tiles]
tw, th = tiles[0][1].size
sheet = Image.new("RGB", (tw * len(tiles) + 6 * (len(tiles) - 1), th + 18), (40, 40, 40))
d = ImageDraw.Draw(sheet)
for i, (n, t) in enumerate(tiles):
    sheet.paste(t, (i * (tw + 6), 18)); d.text((i * (tw + 6) + 4, 3), n, fill=(230, 230, 230))
out = OUT / f"{src.stem}.sweep.png"; sheet.save(out); print(" ", out)
