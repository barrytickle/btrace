# Btrace

Btrace is a raster-to-vector tracer that branched off
[visioncortex VTracer](https://github.com/visioncortex/vtracer) 1.0.0-alpha.4
(October 2026) and now goes its own way. The aim is Vector Magic-quality traces
of logos, icons, UI and other flat-color art.

VTracer is © Chris Tsang and contributors, MIT OR Apache-2.0 (see `LICENSE`).
Btrace keeps that license and attribution. The upstream repo is kept as the
`upstream` git remote so useful fixes can still be pulled in.

## What Btrace adds

### Snap clustering (`--clustering snap`)

For small, compressed or anti-aliased flat-color art, where plain color
clustering splits fills into noisy patches and outlines follow the pixel
staircase.

1. **Palette detection.** Only flat pixels vote (edge pixels are blends and
   would add halo colors); they are merged in OKLab into perceptually distinct
   colors. No color count needed.
2. **Smooth upscale.** Catmull–Rom bicubic, premultiplied alpha, up to 8×
   (auto, aiming for ~4 MP; override with `--snap-scale`).
3. **Blend-aware snap.** Each pixel is modelled as a mix of the two palette
   colors whose blend line passes closest, and takes the nearer one, which
   puts each edge at its 50% coverage point.
4. **Trace** with the classic clusterer, then scale the geometry back down.

`--palette` and `--max-colors` also apply: a fixed palette skips detection,
and `--max-colors` caps the detected one.

Soft edges such as glows are smoothed before snapping so they come out clean
rather than grainy (`--snap-smooth`, default 1.2, 0 = off). Crisp edges are
recognised by their width (2–2.5 px) and left alone, so corners keep their
points.

Code: `crates/vtracer/src/frontend/snap.rs`.

### Removing regions (`--remove-at`, `--remove-color-at`, `--remove-background`)

Erase parts of the image that should not be in the vector, such as a white
background. Works in every clustering mode, and runs after segmentation, so
in an interactive session each click costs nothing extra.

- `--remove-at X,Y`: the region under a point (source pixels). Repeatable.
- `--remove-color-at X,Y`: every region of that colour, including where the
  background shows through gaps like the inside of an "O". Repeatable.
- `--remove-background`: the colour covering most of the image border,
  wherever it touches the border.

Removed areas become transparent; a removed region never exposes whatever
was beneath it.

### Straight lines and sharp corners (`--lines`)

Finds runs of an outline that are straight to within 0.35 px and do not bow
to one side (so large circles stay round), and replaces runs of 8 px or more
with exact lines. Where two lines meet across a small rounded stub at a real
angle, both are extended to their intersection: a sharp corner. The curves
between lines are kept exactly as fitted. Code: `crates/vtracer/src/lines.rs`.

Curve passes (`--simplify`, `--lines`) work in **source pixels**, whatever
scale snap mode traced at, so `--simplify 0.25` means the same on every
image.

### Crop (`--crop[=PADDING]`)

Trims the canvas to the drawing's exact bounds, like svgcrop.com but measured
from the geometry (curves by their true extent). Pairs with background
removal.

## Build

Windows needs the Rust MSVC toolchain and Visual Studio 2022 Build Tools (C++).
Build from PowerShell or cmd: in Git Bash, the shell's own `link` shadows the
MSVC linker.

```
cargo build --release -p vtracer-cli
target\release\vtracer.exe in.png out.svg --clustering snap --hierarchical cutout --simplify 0.25 --lines
```

## App

`app/` is Btrace's interface: a web page running the engine as WebAssembly
in a background worker, with a cached session so slider moves and clicks only
re-run the cheap stages.

```
powershell -ExecutionPolicy Bypass -File app\run.ps1
```

builds the engine if needed (`app\build.ps1`; needs `rustup target add
wasm32-unknown-unknown` and `cargo install wasm-pack`), serves `app/web` on
http://127.0.0.1:8765 and opens it.

- **Guided (default):** three plain questions, with a live preview: what kind
  of image it is (logo, illustration, photo/detailed, black & white), what to
  do with the background (keep, remove, click parts away, trim), and the
  colours (or detail / ink level). Each answer sets the Fine-tune controls.
- **Fine-tune:** every setting, each with a plain-English explanation.
- **Open:** button, drag and drop, or paste.
- **View:** split (drag the divider), trace only, original only; scroll to
  zoom, drag to pan. **Outlines** (toolbar toggle, O) draws every path edge
  as a dashed guide; it is never part of the SVG.
- **Remove tool (R):** click a region to remove it, Shift-click to remove its
  whole colour. Removals show in the top bar with Undo (Ctrl+Z) and Clear,
  in both Guided and Fine-tune.
- **Keys:** V cycles views, H pan, O outlines, 0 fit, +/- zoom, Ctrl+S
  download, Space-drag pans in any tool.

## Lab

`lab/` is the test bench:

- `bench.py`: traces images with several configs, scores each render against
  the source and writes a contact sheet to `lab/out/` (git-ignored). Needs
  `pip install pillow numpy opencv-python-headless` and `cargo install resvg`.
- `samples/`: test images.
- `results/`: kept outputs worth comparing against later.
- `experiments/`: Python prototypes that ideas were tested in before being
  ported to Rust.

## Roadmap

- Straight-line and sharp-corner detection.
- A broader sample set (line art, game UI, gradients) so tuning isn't
  logo-only.
- Btrace's own app: side-by-side compare, sliders and live preview.
