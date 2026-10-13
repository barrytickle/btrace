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

Code: `crates/vtracer/src/frontend/snap.rs`.

## Build

Windows needs the Rust MSVC toolchain and Visual Studio 2022 Build Tools (C++).
Build from PowerShell or cmd: in Git Bash, the shell's own `link` shadows the
MSVC linker.

```
cargo build --release -p vtracer-cli
target\release\vtracer.exe in.png out.svg --clustering snap --hierarchical cutout --simplify 2
```

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
