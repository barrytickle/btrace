# PixPath build plan (next step)

Status, 2026-10-13: the clickable prototype is **approved and is the spec**.
Next: build it for real in the app, under the name **PixPath**.

- Prototype: `design/forma-prototype.html` (published at
  https://claude.ai/artifact/Mo9dYvmLArHs4VA1RLiB5C). Open it to see every
  screen; its behaviour is the reference.
- Current real app: `app/web` (UI), `app/wasm` (engine bridge),
  `app/desktop` (Tauri shell, installer, auto-update). Engine: `crates/vtracer`.
- Installed copies are on v0.2.0. Unreleased but committed: the Bounds
  overlay and the Centre button.

## Decisions (settled 2026-10-13)

1. **No v0.2.1.** The next release *is* the PixPath rebuild; don't polish the
   old UI. Centre + Bounds ship as part of it.
2. **The name PixPath is clear** (Barry checked). The Λ logo stays.

## Build stages

Stages are committed and tested locally; the first release is the whole
PixPath rebuild (suggested v0.3.0), once the new flow works end to end.

### 1. Rename to PixPath
- Product name, window title, About, installer (`tauri.conf.json`
  productName), UI copy, docs/DEVELOPMENT.md (was BTRACE.md).
- **Keep auto-update working for installed copies.** The updater endpoint is
  `github.com/barrytickle/btrace/releases/latest/download/latest.json`.
  Renaming the repo is fine (GitHub redirects), but test the update from
  v0.2.x to the renamed build before removing anything. Keep the same
  bundle `identifier` (`com.barrytickle.btrace`), or Windows treats it as a
  different app and installs side by side.
- Keep the signing key (`~/.tauri/btrace.key`, backup on `N:\Btrace Keys`).

### 2. App structure
- **Start screen:** a drop zone, plus Browse / Paste from clipboard (show
  what's on the clipboard) / Batch a folder (folder picker). Recent images.
  Dropping or opening several images starts a batch automatically.
- **"How would you like to trace it?"** shows "What PixPath noticed" chips,
  then Fully automatic (recommended) / Guided / Advanced. Remember the
  choice for next time.
- **Menu bar** (in-app HTML): File / Edit / View / Help. Help items open
  dialogs: About, Check for updates (manual trigger: checking → available →
  Install & restart), What's new (release notes), Keyboard shortcuts,
  Report a problem (pre-filled GitHub issue).
- **Look:** PixPath light theme by default, with a dark variant (see the
  prototype's tokens), and a clearly visible transparency grid.

### 3. Analysis → recommendations (engine work)
New `analyse()` in the engine / wasm, returning a report used everywhere:
- Image type guess (logo / illustration / photo / B&W) from colour count,
  flat-vs-shaded share, soft-edge share, B&W-only palette.
- Background: one colour covering most of the border (exists in
  RemoveRegions). Whether the image is already transparent.
- Empty-space margins (exists: bounds).
- Palette per colour count, for the ladder (2…N); near-duplicate pairs;
  "extra shades" beyond what the image holds.
- **Stray tiny shapes:** small isolated regions → "Found N tiny stray
  shapes · Remove them".
- Glows / soft edges (exists: snap glow detection).
- Small or blurry image → upscale / smoothing.

### 4. Automatic mode
Apply every recommendation, then show **"What PixPath did"**, with each
decision undoable on its own (type, background, trim, colours, straight
lines, stray shapes). Ends with Review.

### 5. Guided wizard
Steps: Image type → Background (+ trim) → Colours → Details → Review. Each
step pre-selects the recommendation, with a "Recommended" tag and the reason.
- **Image type cards:** illustrations (zoomed-edge drawings), and a photo for
  "Photo or detailed art".
- **Colours = palette ladder:** rows of swatches per colour count (transparency
  first, recommended row starred, "extra shades" labelled), with an editable
  palette above it (click a swatch to recolour, live). Engine needs:
  palette for N colours, and recolouring by palette entry.
- Steps with nothing to decide are skipped (e.g. no glows).

### 6. Review (every mode ends here)
- **Floating toolbar on the picture:** Compare (draggable split) · Preview
  (SVG only, on the grid) · Remove (eraser cursor, red outline on hover;
  click removes the shape, **the background included**; Shift-click removes
  every shape of that colour). R / P / Esc keys.
- **One removal history** (background + shapes): "N removed · Undo · Clear",
  Ctrl+Z.
- **Trim is a button:** it snapshots the current drawing's extent. After
  further removals: "The drawing changed since you trimmed", with Trim again
  and Undo trim. The preview stays aligned with the original; the trim shows
  as a dashed frame.
- **Stray-shapes and background recommendations** as one-click fixes.
- **Final numbers:** canvas px, colours, shapes, KB.
- **Your choices:** each choice's **Change** opens that step of the Guided
  wizard (from any mode) and continues to Review.
- Copy SVG / Save SVG.

### 7. Batch
- **Routes:** Fully automatic (each image gets its own recommendations) /
  Same settings for all (guided once → "Apply to all N") / One by one (each
  image runs the single-image flow).
- **The app must remember it's a batch:** a **batch bar** under the menu on
  every screen ("Editing image X of N · name" or "Settings for all N
  images", thumbnails with progress, Back to batch, and "Use automatic for
  the rest" in one-by-one).
- **Batch-aware finishing buttons:** one by one → "Next image (n of N)" /
  "Finish · review the batch"; editing one image from the batch review →
  "Done · back to batch review"; same-for-all → "Apply to all N"; each with a
  secondary "Review this image". A single upload → "Review →".
- **Batch review = accordion:** one row per image (trace thumbnail, name,
  what was done, Ready / Needs a look / Skipped). Expanded: original vs SVG
  side by side, quick fixes (background, trim, skip), and **Edit this
  image** (opens at "How would you like to trace it?"). Flagged images open
  first, with a suggested fix or "It's fine". Panel: totals, a Needs-a-look
  filter, and Save N to a folder (never overwrites).
- **Per-image state** (palette edits, removals, trim snapshot) belongs to
  each image; reset it between images (the prototype once leaked colours).

### 8. Viewer basics (keep from the current app)
Centre button, so the image can't be lost off-screen; zoom limits; Outlines;
Bounds; split, trace and original views.

## How to work (gotchas)
- **Build** from PowerShell, not Git Bash, which shadows the MSVC `link`:
  `cargo build --release -p vtracer-cli`; app engine: `app\build.ps1`;
  desktop: `cd app\desktop; npm run build`.
- **Windows PowerShell 5.1** turns native tools' stderr into errors: don't
  use `$ErrorActionPreference = "Stop"` around cargo, git or wasm-pack;
  check `$LASTEXITCODE` instead.
- **Preview** the web app: `python -m http.server 8765 --directory app/web`,
  then open http://127.0.0.1:8765.
- **Test images** live in `lab/samples` (git-ignored; third-party logos and
  artwork; never publish them).
- **Pushing:** `git push origin btrace:main`; never push tags except a
  release's own `v*` tag (the release script does this).
