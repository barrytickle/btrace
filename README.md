<div align="center">
  <img src="app/desktop/icon.svg" width="72" height="72" alt="">
  <h1>PixPath</h1>
  <p><strong>Turn images into clean SVG vectors.</strong><br>
  Logos, icons, illustrations and line art: drop a PNG in, get a tidy SVG out.</p>
  <p><a href="https://github.com/barrytickle/btrace/releases/latest"><strong>Download for Windows</strong></a></p>
</div>

## What it does

- **Flat colours, done right:** finds the real colours in your image and ignores
  compression noise and blurry edges, so letters come out solid and clean.
- **Smooth, accurate edges:** traces small or low-resolution images at higher
  detail, so outlines are smooth rather than stair-stepped.
- **Straight lines and sharp corners** where the design has them.
- **Glows stay glows:** soft edges, like a moon in the sky, are traced as soft
  edges, not hard cut-outs.
- **Clean-up:** remove the background, or click away any stray shape, then trim
  the empty space around the drawing.
- **Batches:** drop a whole folder and review every result before saving.
- **Updates itself:** installed copies offer new versions as they're released.

PixPath runs entirely on your computer. Your images are never uploaded.

## Install

Download the latest `PixPath_x.y.z_x64-setup.exe` from
[Releases](https://github.com/barrytickle/btrace/releases/latest) and run it.
Windows may say the publisher is unknown, because the installer isn't
code-signed: choose **More info → Run anyway**.

## Build from source

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): the engine, the app, the
desktop build and how releases work.

## Credits

PixPath is built on [visioncortex VTracer](https://github.com/visioncortex/vtracer)
by Chris Tsang and contributors, under the MIT or Apache-2.0 licence (see
[LICENSE](LICENSE)). VTracer's own documentation is kept in
[docs/VTRACER-README.md](docs/VTRACER-README.md).
