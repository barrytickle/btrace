# PixPath development notes

PixPath is a raster-to-vector tracer that branched off
[visioncortex VTracer](https://github.com/visioncortex/vtracer) 1.0.0-alpha.4
(October 2026) and now goes its own way. The aim is Vector Magic-quality traces
of logos, icons, UI and other flat-color art.

VTracer is © Chris Tsang and contributors, MIT OR Apache-2.0 (see `LICENSE`).
PixPath keeps that license and attribution. The upstream repo is kept as the
`upstream` git remote so useful fixes can still be pulled in.

## What PixPath adds

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

### Glows (`--snap-glow`, with `--hierarchical stacked`)

Where a shape fades softly into what is behind it (a moon into the sky, a
light), PixPath measures how soft that edge is and draws a matching **halo**:
the shape stays crisp, and underneath it a grown, blurred copy fades into the
backdrop. The halo is clipped to the backdrop's colour and confined to the
soft stretches of the edge, so it never paints over a silhouette or a tree in
front. Faint, low-contrast edges are ignored. On the logo samples nothing
glows; on the witch illustration only the moon does.

Snap mode is best with **stacked** layering (`--hierarchical stacked`, the
app's default): shapes sit on top of the ones beneath, which avoids the faint
hairline seams that edge-to-edge (cutout) shapes show when rendered, and
roughly halves the file size. Cutout ("shapes don't overlap") is still there
for cutting machines; glows need stacked.

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
target\release\vtracer.exe in.png out.svg --clustering snap --hierarchical stacked --simplify 0.25 --lines
```

## App

`app/` is PixPath's interface: a web page running the engine as WebAssembly
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
  zoom, drag to pan, **Centre** (or 0) fits the image back in view; the image
  can never be zoomed or dragged out of sight. **Outlines** (toolbar toggle, O) draws every path edge
  as a dashed guide; it is never part of the SVG. **Bounds** (B) frames the SVG's
  edge, hatches the empty space around the drawing and lists the margins in
  px; with "Trim empty space" on it shows the trimmed canvas instead.
- **Remove tool (R):** click a region to remove it, Shift-click to remove its
  whole colour. Removals show in the top bar with Undo (Ctrl+Z) and Clear,
  in both Guided and Fine-tune.
- **Keys:** V cycles views, H pan, O outlines, B bounds, 0 fit, +/- zoom, Ctrl+S
  download, Space-drag pans in any tool.
- **Batch:** open or drop several images at once. Each is traced in the
  background with the current settings (a strip at the bottom shows
  progress; changing a setting re-traces them all). Click any image to open
  it and fine-tune it; its removals stay its own. **Save all** writes every
  SVG into a folder you pick (desktop app; never overwrites, adds " (2)") or
  downloads a zip (browser).

## Desktop app and releases

`app/desktop/` wraps the same UI in a native window with
[Tauri 2](https://tauri.app): a normal Windows installer, a native "Save as"
dialog, drag and drop from Explorer, and **automatic updates**.

- **Build locally:** `cd app/desktop`, `npm install` once, then `npm run build`.
  The installer lands in `app/desktop/src-tauri/target/release/bundle/nsis/`.
  Building update artifacts needs the signing key:
  `$env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\.tauritrace.key"`.
- **Release:** `powershell -ExecutionPolicy Bypass -File app\desktop
elease.ps1 0.2.0`
  sets the version, commits, tags `v0.2.0` and pushes. The *Desktop release*
  GitHub Action builds the signed installer and publishes the GitHub Release
  with `latest.json`.
- **Updates:** on start-up the app reads
  `releases/latest/download/latest.json`; if there is a newer version a banner
  offers **Install & restart**. Updates must be signed with the private key
  (`~/.tauri/btrace.key`, never committed; its public half is in
  `tauri.conf.json`). The Action reads it from the repository secret
  `TAURI_SIGNING_PRIVATE_KEY`. **Keep a backup of that key file**: without it
  no future update can be signed for installed copies.
- Releases go out when you run the release script, not on every push to
  `main`, so work in progress never reaches installed apps.

## Lab

`lab/` is the test bench:

- `bench.py`: traces images with several configs, scores each render against
  the source and writes a contact sheet to `lab/out/` (git-ignored). Needs
  `pip install pillow numpy opencv-python-headless` and `cargo install resvg`.
- `sweep.py`: sweeps one option over several values and builds a zoomed
  comparison.
- `samples/` and `results/`: test images and kept outputs. **Local only and
  git-ignored**: the test set includes third-party logos and artwork that
  must not be published. Drop your own images in `lab/samples/` to test.
- `experiments/`: Python prototypes that ideas were tested in before being
  ported to Rust.

## Next up (agreed 2026-10-13)

1. **Menu bar** (in-app, so browser and desktop match): File (Open, Open
   folder, Recent, Save SVG, Save all), Edit (Undo/Redo, including settings),
   View (split / trace / original, outlines, zoom), Help (Check for updates,
   What's new, Keyboard shortcuts, Report a problem, About PixPath).
2. **PixPath's own look**, not a VTracer lookalike: design 2-3 directions as
   clickable mock-ups, pick one, then build it (brand colours and type, light
   theme, start screen, trace-reveal animation, result-first layout).
3. **Guided as a real wizard**, in the spirit of Vector Magic's flow (our own
   design and words): one step at a time with Back / Next (image type,
   quality, background, colours, review, save), and live previews of *your*
   image for each choice, e.g. 3 / 4 / 5 colours side by side.

Parked ideas: palette editing, PNG / PDF / EPS / DXF export, copy SVG to
clipboard, saved presets, a native multi-core engine in the desktop app, a
Mac build.

## Roadmap

- Smooth gradients across whole areas (shading, not just glowing edges).
- A broader sample set (line art, game UI, gradients) so tuning isn't
  logo-only.
- Code-signing the installer (removes Windows' "unknown publisher" warning).
