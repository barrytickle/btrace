// Btrace app: UI state, canvas interaction, and talking to the engine worker.

const $ = (id) => document.getElementById(id);

// The Tauri API when running as the desktop app; undefined in a browser.
const desktop = window.__TAURI__;

const ui = {
  open: $("open"), openInline: $("openInline"), file: $("file"), filename: $("filename"),
  status: $("status"), download: $("download"),
  viewport: $("viewport"), stage: $("stage"), original: $("original"),
  traceLayer: $("traceLayer"), trace: $("trace"), divider: $("divider"),
  empty: $("empty"), hint: $("hint"),
  zoomIn: $("zoomIn"), zoomOut: $("zoomOut"), zoomLabel: $("zoomLabel"), outlines: $("outlines"),
  maxColors: $("maxColors"), maxColorsOut: $("maxColorsOut"), swatches: $("swatches"),
  smooth: $("smooth"), smoothOut: $("smoothOut"),
  precision: $("precision"), precisionOut: $("precisionOut"),
  gradient: $("gradient"), gradientOut: $("gradientOut"),
  threshold: $("threshold"), thresholdOut: $("thresholdOut"), adaptive: $("adaptive"),
  simplify: $("simplify"), simplifyOut: $("simplifyOut"),
  speckle: $("speckle"), speckleOut: $("speckleOut"), lines: $("lines"),
  glow: $("glow"), noOverlap: $("noOverlap"),
  removeBg: $("removeBg"), removedCount: $("removedCount"),
  undoRemove: $("undoRemove"), clearRemove: $("clearRemove"),
  crop: $("crop"), pad: $("pad"), padOut: $("padOut"), padRow: $("padRow"),
  statShapes: $("statShapes"), statColors: $("statColors"), statSize: $("statSize"),
  statCanvas: $("statCanvas"), statTime: $("statTime"),
};

const state = {
  name: "", width: 0, height: 0,
  mode: "snap", view: "split", tool: "pan",
  zoom: 1, panX: 0, panY: 0, split: 0.5,
  removals: [],
  renderId: 0, shownId: 0,
  result: null, cropped: null,
  traceURL: null, outlineURL: null, originalURL: null,
  loaded: false,
};

// Batch state (see the batch section below). Declared up here because
// start-up code further down already consults it.
const batch = {
  items: [],
  current: -1, // index of the image open in the main view
  nextId: 1,
  busy: null, // id of the item the batch worker is tracing
  worker: null,
  refresh: 0, // debounce timer for re-tracing after a settings change
  mode: null, // tracing mode the items' removals were made in
};

// ---- engine worker --------------------------------------------------------

const worker = new Worker("worker.js", { type: "module" });
let workerReady = false;
worker.onmessage = ({ data }) => {
  if (data.type === "ready") {
    workerReady = true;
    setStatus("");
  } else if (data.type === "loaded") {
    requestRender(false);
  } else if (data.type === "rendered") {
    if (data.id < state.shownId) return; // an older render finished late
    state.shownId = data.id;
    showResult(data.result, data.cropped, data.ms);
  } else if (data.type === "error") {
    setStatus(data.message, "error");
  }
};
worker.onerror = (e) => setStatus(`Engine failed to start: ${e.message || e}`, "error");
setStatus("Starting engine…", "busy");

function setStatus(text, kind = "") {
  ui.status.textContent = text;
  ui.status.className = `status ${kind}`;
}

// ---- options ------------------------------------------------------------------

function options(withCrop, removals = state.removals) {
  const o = {
    hierarchical: ui.noOverlap.checked ? "cutout" : "stacked",
    mode: "spline",
    filterSpeckle: +ui.speckle.value,
    simplify: +ui.simplify.value,
    lines: ui.lines.checked,
    removeBackground: ui.removeBg.checked,
    remove: removals,
    crop: withCrop ? +ui.pad.value : null,
    pathPrecision: 2,
  };
  if (state.mode === "snap") {
    Object.assign(o, {
      clustering: "snap",
      maxColors: +ui.maxColors.value,
      snapSmooth: +ui.smooth.value,
      snapGlow: ui.glow.checked,
    });
  } else if (state.mode === "color") {
    Object.assign(o, {
      clustering: "color-cluster",
      colorPrecision: +ui.precision.value,
      layerDifference: +ui.gradient.value,
    });
  } else {
    Object.assign(o, {
      clustering: "bw",
      binaryThreshold: +ui.threshold.value,
      adaptive: ui.adaptive.checked,
    });
  }
  return o;
}

/// Trace the open image again. `settingsChanged` = false for things that only
/// concern this image (it just loaded, or a shape was removed), so a batch is
/// not re-traced for them.
function requestRender(settingsChanged = true) {
  if (!state.loaded) return;
  const id = ++state.renderId;
  setStatus("Tracing…", "busy");
  worker.postMessage({
    type: "render",
    id,
    options: options(false),
    cropped: ui.crop.checked ? options(true) : null,
  });
  if (settingsChanged) batchSettingsChanged();
}

// ---- results ------------------------------------------------------------------

function svgURL(svg) {
  return URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
}

/// The same SVG drawn as dashed guide lines, for the Outlines overlay. Styled
/// like an editor guide (dashed, app accent) so it never reads as artwork.
function outlineSVG(svg) {
  const style =
    "<style>path{fill:none!important;stroke:#3ccfb0;stroke-width:1.25;stroke-dasharray:4 3;" +
    "vector-effect:non-scaling-stroke;stroke-linejoin:round}</style>";
  return svg.replace(/<svg[^>]*>/, (m) => m + style);
}

function formatBytes(n) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
}

function showResult(result, cropped, ms) {
  state.result = result;
  state.cropped = cropped;

  if (state.traceURL) URL.revokeObjectURL(state.traceURL);
  state.traceURL = svgURL(result.svg);
  ui.trace.src = state.traceURL;
  updateOutlines();

  const out = cropped ?? result;
  const bytes = new Blob([out.svg]).size;
  ui.statShapes.textContent = result.shapes.toLocaleString();
  ui.statColors.textContent = result.colors.length;
  ui.statSize.textContent = formatBytes(bytes);
  ui.statCanvas.textContent = `${out.width} × ${out.height}${cropped ? " (cropped)" : ""}`;
  ui.statTime.textContent = `${Math.round(ms)} ms`;

  ui.swatches.replaceChildren(
    ...result.colors.slice(0, 32).map((hex) => {
      const s = document.createElement("span");
      s.style.background = hex;
      s.dataset.hex = hex;
      return s;
    }),
  );
  ui.download.disabled = false;
  setStatus(`Traced in ${Math.round(ms)} ms`);
  showGuidedResult(result, out, bytes);
  batchCurrentTraced(result, cropped);
  updateBounds();
}

function updateOutlines() {
  const existing = ui.traceLayer.querySelector(".outline");
  if (state.outlineURL) URL.revokeObjectURL(state.outlineURL);
  state.outlineURL = null;
  $("guideBadge").hidden = !outlinesOn();
  if (!outlinesOn() || !state.result) {
    existing?.remove();
    return;
  }
  state.outlineURL = svgURL(outlineSVG(state.result.svg));
  const img = existing ?? Object.assign(document.createElement("img"), { className: "outline", alt: "", draggable: false });
  img.src = state.outlineURL;
  if (!existing) ui.traceLayer.append(img);
}

async function download() {
  const out = state.cropped ?? state.result;
  if (!out) return;
  const name = `${state.name.replace(/\.[^.]+$/, "") || "trace"}.svg`;
  if (desktop) {
    // Desktop: a native "Save as" dialog (a webview download has nowhere to go).
    try {
      const path = await desktop.core.invoke("save_svg", { name, contents: out.svg });
      if (path) setStatus(`Saved ${path.split(/[\\/]/).pop()}`);
    } catch (e) {
      setStatus(String(e), "error");
    }
    return;
  }
  const a = document.createElement("a");
  a.href = svgURL(out.svg);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- loading images ---------------------------------------------------------

async function loadBlob(blob, name, removals = []) {
  try {
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data.buffer;
    bitmap.close();

    Object.assign(state, { name, blob, width, height, removals, result: null, cropped: null, loaded: true, shownId: state.renderId });
    if (state.originalURL) URL.revokeObjectURL(state.originalURL);
    state.originalURL = URL.createObjectURL(blob);
    ui.original.src = state.originalURL;
    ui.trace.removeAttribute("src");
    ui.filename.textContent = `${name} · ${width} × ${height}`;
    ui.filename.title = name;
    ui.empty.hidden = true;
    ui.stage.classList.add("has-image");
    updateRemovals(false);
    fit();
    setStatus("Tracing…", "busy");
    worker.postMessage({ type: "load", rgba, width, height }, [rgba]);
  } catch (e) {
    setStatus(`Couldn't open that image (${e.message || e})`, "error");
  }
}

ui.open.onclick = ui.openInline.onclick = () => ui.file.click();
ui.file.onchange = () => {
  openFiles([...ui.file.files]);
  ui.file.value = "";
};
ui.viewport.addEventListener("dragover", (e) => {
  e.preventDefault();
  ui.viewport.classList.add("drag-over");
});
ui.viewport.addEventListener("dragleave", () => ui.viewport.classList.remove("drag-over"));
ui.viewport.addEventListener("drop", (e) => {
  e.preventDefault();
  ui.viewport.classList.remove("drag-over");
  openFiles([...e.dataTransfer.files]);
});
window.addEventListener("paste", (e) => {
  const item = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
  if (item) loadBlob(item.getAsFile(), "pasted-image.png");
});

// ---- view: zoom, pan, split ---------------------------------------------------

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 32;

function layout() {
  const { stage, original } = ui;
  stage.style.left = `${state.panX}px`;
  stage.style.top = `${state.panY}px`;
  stage.style.width = `${state.width * state.zoom}px`;
  stage.style.height = `${state.height * state.zoom}px`;
  original.classList.toggle("pixelated", state.zoom >= 3);
  // Keep the whitespace hatching about 8 screen px apart at any zoom.
  const hatch = $("hatch");
  hatch.setAttribute("width", 8 / state.zoom);
  hatch.setAttribute("height", 8 / state.zoom);
  hatch.firstElementChild.setAttribute("width", 3 / state.zoom);
  hatch.firstElementChild.setAttribute("height", 8 / state.zoom);
  ui.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;

  const pct = state.split * 100;
  ui.divider.style.left = `${pct}%`;
  // Each side clips the other out: the trace has transparent areas (removed
  // regions) that must show the checkerboard, not the original beneath.
  const split = state.view === "split";
  ui.traceLayer.style.clipPath = split ? `inset(0 0 0 ${pct}%)` : "none";
  original.style.clipPath = split ? `inset(0 ${100 - pct}% 0 0)` : "none";
  ui.traceLayer.hidden = state.view === "original";
  original.hidden = state.view === "trace";
  stage.className = `stage has-image view-${state.view}`;
  if (!state.loaded) stage.classList.remove("has-image");
}

function fit() {
  const r = ui.viewport.getBoundingClientRect();
  const m = 48;
  state.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min((r.width - m) / state.width, (r.height - m) / state.height)));
  state.panX = (r.width - state.width * state.zoom) / 2;
  state.panY = (r.height - state.height * state.zoom) / 2;
  layout();
}

function zoomAt(factor, cx, cy) {
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, state.zoom * factor));
  const k = z / state.zoom;
  state.panX = cx - (cx - state.panX) * k;
  state.panY = cy - (cy - state.panY) * k;
  state.zoom = z;
  layout();
}

function zoomCentre(factor) {
  const r = ui.viewport.getBoundingClientRect();
  zoomAt(factor, r.width / 2, r.height / 2);
}

ui.viewport.addEventListener("wheel", (e) => {
  if (!state.loaded) return;
  e.preventDefault();
  const r = ui.viewport.getBoundingClientRect();
  zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

ui.zoomIn.onclick = () => zoomCentre(1.25);
ui.zoomOut.onclick = () => zoomCentre(0.8);
ui.zoomLabel.onclick = () => state.loaded && fit();
window.addEventListener("resize", () => state.loaded && layout());

// Pointer: pan, divider drag, or remove-click.
let drag = null;
ui.viewport.addEventListener("pointerdown", (e) => {
  if (!state.loaded || e.button === 2) return;
  const onDivider = e.target.closest(".divider");
  const panning = state.tool === "pan" || e.button === 1 || spaceHeld;
  drag = {
    kind: onDivider ? "divider" : panning ? "pan" : "click",
    x: e.clientX, y: e.clientY, panX: state.panX, panY: state.panY, moved: false,
  };
  ui.viewport.setPointerCapture(e.pointerId);
  if (drag.kind === "pan") ui.viewport.classList.add("dragging");
});
ui.viewport.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (drag.kind === "pan") {
    state.panX = drag.panX + dx;
    state.panY = drag.panY + dy;
    layout();
  } else if (drag.kind === "divider") {
    const r = ui.stage.getBoundingClientRect();
    state.split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    layout();
  }
});
ui.viewport.addEventListener("pointerup", (e) => {
  if (!drag) return;
  if (drag.kind === "click" && !drag.moved) removeAt(e);
  drag = null;
  ui.viewport.classList.remove("dragging");
});

ui.divider.addEventListener("keydown", (e) => {
  const step = e.shiftKey ? 0.1 : 0.02;
  if (e.key === "ArrowLeft") state.split = Math.max(0, state.split - step);
  else if (e.key === "ArrowRight") state.split = Math.min(1, state.split + step);
  else return;
  e.preventDefault();
  layout();
});

// ---- removal ------------------------------------------------------------------

function removeAt(e) {
  const r = ui.stage.getBoundingClientRect();
  const x = (e.clientX - r.left) / state.zoom;
  const y = (e.clientY - r.top) / state.zoom;
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return;
  state.removals = [...state.removals, { x, y, wholeColor: e.shiftKey }];
  updateRemovals();
}

function updateRemovals(render = true) {
  const n = state.removals.length;
  ui.removedCount.textContent = `${n} removed`;
  $("removals").hidden = n === 0;
  batchRemovalsChanged();
  if (render) requestRender(false);
}

ui.undoRemove.onclick = () => {
  state.removals = state.removals.slice(0, -1);
  updateRemovals();
};
ui.clearRemove.onclick = () => {
  state.removals = [];
  updateRemovals();
};

// ---- toolbar ------------------------------------------------------------------

function setView(view) {
  state.view = view;
  document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  if (state.loaded) layout();
}

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === tool));
  ui.viewport.classList.toggle("tool-remove", tool === "remove");
  ui.hint.hidden = tool !== "remove" || !state.loaded;
  ui.hint.textContent = "Click a region to remove it · Shift-click removes its whole colour · Space-drag to pan";
  // Removing is about the trace, so show it.
  if (tool === "remove" && state.view === "original") setView("split");
}

function setMode(mode, render = true) {
  state.mode = mode;
  document.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  document.querySelectorAll("[data-for]").forEach((s) => (s.hidden = s.dataset.for !== mode));
  // Clicked points refer to regions of the old segmentation, in every image.
  if (state.mode !== batch.mode) {
    batch.items.forEach((it) => (it.removals = []));
    batch.mode = state.mode;
  }
  if (state.removals.length) {
    state.removals = [];
    updateRemovals(false);
  }
  syncGuidedStep3();
  if (render) requestRender();
}

document.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
document.querySelectorAll("[data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
document.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
function toggleOutlines(on = !outlinesOn()) {
  ui.outlines.setAttribute("aria-pressed", on);
  ui.outlines.classList.toggle("on", on);
  updateOutlines();
}
function outlinesOn() {
  return ui.outlines.getAttribute("aria-pressed") === "true";
}
ui.outlines.onclick = () => toggleOutlines();
ui.download.onclick = download;

// ---- settings -----------------------------------------------------------------

const sliders = [
  [ui.maxColors, ui.maxColorsOut, (v) => (+v === 0 ? "Auto" : `${v}`)],
  [ui.smooth, ui.smoothOut, (v) => (+v === 0 ? "Off" : (+v).toFixed(1))],
  [ui.precision, ui.precisionOut, (v) => v],
  [ui.gradient, ui.gradientOut, (v) => v],
  [ui.threshold, ui.thresholdOut, (v) => v],
  [ui.simplify, ui.simplifyOut, (v) => (+v === 0 ? "Off" : `${(+v).toFixed(2)} px`)],
  [ui.speckle, ui.speckleOut, (v) => `${v} px`],
  [ui.pad, ui.padOut, (v) => `${v} px`],
];
const shows = new Map();
for (const [input, out, fmt] of sliders) {
  const show = () => (out.textContent = fmt(input.value));
  shows.set(input, show);
  input.addEventListener("input", () => {
    show();
    requestRender();
  });
  show();
}

/// Set a control without triggering a render (the caller renders once).
function setControl(input, value) {
  if (input.type === "checkbox") input.checked = value;
  else input.value = value;
  shows.get(input)?.();
}
for (const box of [ui.lines, ui.removeBg, ui.adaptive, ui.glow, ui.noOverlap]) box.addEventListener("change", requestRender);
ui.crop.addEventListener("change", () => {
  g.crop.checked = ui.crop.checked;
  syncCrop();
  requestRender();
});
function syncCrop() {
  ui.pad.disabled = !ui.crop.checked;
  ui.padRow.classList.toggle("disabled", !ui.crop.checked);
}
syncCrop();

// ---- keyboard -------------------------------------------------------------------

let spaceHeld = false;
window.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea")) return;
  if (e.key === " ") {
    spaceHeld = true;
    if (state.tool === "remove") ui.viewport.classList.remove("tool-remove");
    e.preventDefault();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    if (state.removals.length) ui.undoRemove.click();
    e.preventDefault();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    download();
    e.preventDefault();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "r") setTool("remove");
  else if (k === "h") setTool("pan");
  else if (k === "o") toggleOutlines();
  else if (k === "b") toggleBounds();
  else if (k === "v") setView({ split: "trace", trace: "original", original: "split" }[state.view]);
  else if (k === "0") state.loaded && fit();
  else if (k === "+" || k === "=") zoomCentre(1.25);
  else if (k === "-") zoomCentre(0.8);
});
window.addEventListener("keyup", (e) => {
  if (e.key === " ") {
    spaceHeld = false;
    ui.viewport.classList.toggle("tool-remove", state.tool === "remove");
  }
});

// ---- guided flow ----------------------------------------------------------------
//
// Three plain questions that set the same controls as the Fine-tune panel,
// so switching panels never loses anything.

const g = {
  crop: $("gCrop"), clickHelp: $("gClickHelp"),
  colourTitle: $("gColourTitle"), colours: $("gColours"), found: $("gFound"),
  swatches: $("gSwatches"), stepper: $("gStepper"), fewer: $("gFewer"), count: $("gCount"), more: $("gMore"),
  detail: $("gDetail"), bw: $("gBw"), download: $("gDownload"), summary: $("gSummary"),
};

/// What each image type sets. Detail and ink levels refine these.
const TYPES = {
  logo: { mode: "snap", smooth: 1.2, lines: true, simplify: 0.25, speckle: 4, glow: false },
  illustration: { mode: "snap", smooth: 1.2, lines: true, simplify: 0.35, speckle: 4, glow: true },
  detailed: { mode: "color", lines: false, simplify: 0.5 },
  bw: { mode: "bw", lines: true, simplify: 0.3, speckle: 4, adaptive: false },
};
const DETAIL = {
  low: { precision: 5, gradient: 32, speckle: 10 },
  normal: { precision: 6, gradient: 16, speckle: 6 },
  high: { precision: 7, gradient: 8, speckle: 3 },
};
const INK = { light: 100, normal: 128, dark: 160 };

const guided = { type: "logo", detail: "normal", ink: "normal", autoColors: 0 };

function pick(selector, attr, value) {
  document.querySelectorAll(selector).forEach((b) => {
    const on = b.dataset[attr] === value;
    b.classList.toggle("on", on);
    if (b.hasAttribute("aria-checked")) b.setAttribute("aria-checked", on);
  });
}

function applyType(type) {
  guided.type = type;
  pick("[data-type]", "type", type);
  const t = TYPES[type];
  setControl(ui.lines, t.lines);
  setControl(ui.simplify, t.simplify);
  if (t.smooth !== undefined) setControl(ui.smooth, t.smooth);
  if (t.speckle !== undefined) setControl(ui.speckle, t.speckle);
  if (t.adaptive !== undefined) setControl(ui.adaptive, t.adaptive);
  if (t.glow !== undefined) setControl(ui.glow, t.glow);
  setControl(ui.maxColors, 0);
  if (type === "detailed") applyDetail(guided.detail, false);
  if (type === "bw") applyInk(guided.ink, false);
  setMode(t.mode, false);
  requestRender();
}

function applyDetail(level, render = true) {
  guided.detail = level;
  pick("[data-detail]", "detail", level);
  const d = DETAIL[level];
  setControl(ui.precision, d.precision);
  setControl(ui.gradient, d.gradient);
  setControl(ui.speckle, d.speckle);
  if (render) requestRender();
}

function applyInk(level, render = true) {
  guided.ink = level;
  pick("[data-ink]", "ink", level);
  setControl(ui.threshold, INK[level]);
  if (render) requestRender();
}

function applyBackground(choice) {
  pick("[data-bg]", "bg", choice);
  setControl(ui.removeBg, choice === "auto");
  g.clickHelp.hidden = choice !== "click";
  setTool(choice === "click" ? "remove" : "pan");
  if (choice !== "click" && state.removals.length) {
    state.removals = [];
    updateRemovals(false);
  }
  requestRender();
}

function syncGuidedStep3() {
  const m = state.mode;
  g.colours.hidden = m !== "snap";
  g.detail.hidden = m !== "color";
  g.bw.hidden = m !== "bw";
  g.colourTitle.textContent = m === "snap" ? "Colours" : m === "color" ? "Detail" : "Ink";
}

function setColourCount(n) {
  setControl(ui.maxColors, n);
  requestRender();
}

function showGuidedResult(result, out, bytes) {
  const n = result.colors.length;
  const auto = +ui.maxColors.value === 0;
  if (auto) guided.autoColors = n;
  if (state.mode === "snap") {
    g.found.textContent = auto
      ? `Btrace found ${n} colour${n === 1 ? "" : "s"}. If two of them should be the same colour, use fewer.`
      : `Using ${n} colour${n === 1 ? "" : "s"}.`;
    g.swatches.replaceChildren(
      ...result.colors.slice(0, 24).map((hex) => {
        const sw = document.createElement("span");
        sw.style.background = hex;
        sw.dataset.hex = hex;
        return sw;
      }),
    );
    g.stepper.hidden = false;
    g.count.textContent = auto ? "Auto" : `${ui.maxColors.value}`;
    g.fewer.disabled = n <= 1;
    g.more.disabled = auto;
  }
  g.download.disabled = false;
  g.summary.textContent =
    `${result.shapes} shape${result.shapes === 1 ? "" : "s"} · ${n} colour${n === 1 ? "" : "s"} · ${formatBytes(bytes)}` +
    (state.cropped ? ` · trimmed to ${out.width} × ${out.height}` : "");
}

document.querySelectorAll("[data-type]").forEach((b) => (b.onclick = () => applyType(b.dataset.type)));
document.querySelectorAll("[data-bg]").forEach((b) => (b.onclick = () => applyBackground(b.dataset.bg)));
document.querySelectorAll("[data-detail]").forEach((b) => (b.onclick = () => applyDetail(b.dataset.detail)));
document.querySelectorAll("[data-ink]").forEach((b) => (b.onclick = () => applyInk(b.dataset.ink)));
g.fewer.onclick = () => {
  const current = +ui.maxColors.value || guided.autoColors;
  setColourCount(Math.max(1, current - 1));
};
g.more.onclick = () => {
  const next = +ui.maxColors.value + 1;
  // Back at (or past) what Btrace found on its own: that's Auto.
  setColourCount(next >= guided.autoColors ? 0 : next);
};
g.count.onclick = () => setColourCount(0);
g.crop.onchange = () => {
  setControl(ui.crop, g.crop.checked);
  syncCrop();
  requestRender();
};
g.download.onclick = download;

// Panel switch: Guided / Fine-tune.
document.querySelectorAll("[data-panel]").forEach((b) => {
  b.onclick = () => {
    const which = b.dataset.panel;
    document.querySelectorAll("[data-panel]").forEach((x) => {
      x.classList.toggle("on", x === b);
      x.setAttribute("aria-selected", x === b);
    });
    $("guided").hidden = which !== "guided";
    $("advanced").hidden = which !== "advanced";
  };
});

applyType("logo");
setView("split");

// ---- desktop: version and auto-update ----------------------------------------------
//
// On start-up the desktop app asks GitHub Releases whether a newer, signed
// build exists. If so a banner offers to install it; nothing happens without
// a click, and being offline is not an error.

async function checkForUpdate() {
  if (!desktop?.updater) return;
  let update;
  try {
    update = await desktop.updater.check();
  } catch {
    return; // offline, or no release published yet
  }
  if (!update) return;
  $("updateText").textContent = `Btrace ${update.version} is available`;
  $("update").hidden = false;
  $("updateLater").onclick = () => ($("update").hidden = true);
  $("updateInstall").onclick = async () => {
    $("updateInstall").disabled = $("updateLater").disabled = true;
    let total = 0;
    let done = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength || 0;
        if (event.event === "Progress") {
          done += event.data.chunkLength;
          const pct = total ? ` ${Math.round((done / total) * 100)}%` : "";
          $("updateText").textContent = `Downloading Btrace ${update.version}…${pct}`;
        }
        if (event.event === "Finished") $("updateText").textContent = "Installing…";
      });
      await desktop.process.relaunch();
    } catch (e) {
      $("updateText").textContent = `Update failed: ${e}`;
      $("updateLater").disabled = false;
    }
  };
}

if (desktop) {
  desktop.app?.getVersion().then((v) => {
    $("version").textContent = `v${v}`;
    $("version").hidden = false;
  });
  checkForUpdate();
}

// ---- batch --------------------------------------------------------------------------
//
// Open several images and they become a batch: every image is traced in the
// background with the current settings, a strip shows progress, clicking an
// image opens it in the main view to fine-tune (its removals stay its own),
// and Save all writes every SVG at once. Settings are shared; changing one
// re-traces the whole batch.


function batchWorker() {
  if (batch.worker) return batch.worker;
  batch.worker = new Worker("worker.js", { type: "module" });
  batch.worker.onmessage = ({ data }) => {
    if (data.type !== "traced" && data.type !== "error") return;
    const item = batch.items.find((it) => it.id === data.id);
    batch.busy = null;
    if (item && item.status === "tracing") {
      if (data.type === "traced") {
        Object.assign(item, { status: "done", result: data.result, cropped: data.cropped, width: data.width, height: data.height });
      } else {
        Object.assign(item, { status: "error", error: data.message });
      }
      renderBatch();
    }
    pumpBatch();
  };
  return batch.worker;
}

function openFiles(files) {
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (!images.length) return;
  if (images.length === 1 && !batch.items.length) {
    loadBlob(images[0], images[0].name);
    return;
  }
  // Starting a batch from a single open image: keep that image in it.
  if (!batch.items.length && state.loaded && state.blob) {
    addToBatch(state.blob, state.name, state.removals);
    batch.current = 0;
  }
  for (const f of images) addToBatch(f, f.name, []);
  if (batch.current < 0) openBatchItem(0);
  renderBatch();
  pumpBatch();
}

function addToBatch(blob, name, removals) {
  batch.items.push({
    id: batch.nextId++, blob, name, removals,
    status: "waiting", result: null, cropped: null,
    thumb: URL.createObjectURL(blob), traceThumb: null,
  });
}

/// Trace the next waiting image (one at a time; the open image is traced by
/// the main view instead).
function pumpBatch() {
  if (batch.busy !== null) return;
  const item = batch.items.find((it, i) => it.status === "waiting" && i !== batch.current);
  if (!item) {
    renderBatch();
    return;
  }
  item.status = "tracing";
  batch.busy = item.id;
  batchWorker().postMessage({
    type: "trace-once",
    id: item.id,
    blob: item.blob,
    options: options(false, item.removals),
    cropped: ui.crop.checked ? options(true, item.removals) : null,
  });
  renderBatch();
}

function openBatchItem(i) {
  const item = batch.items[i];
  if (!item || i === batch.current) return;
  batch.current = i;
  loadBlob(item.blob, item.name, item.removals);
  renderBatch();
}

/// The main view finished tracing the open image: that's its result too.
function batchCurrentTraced(result, cropped) {
  const item = batch.items[batch.current];
  if (!item) return;
  Object.assign(item, { status: "done", result, cropped });
  renderBatch();
}

function batchRemovalsChanged() {
  const item = batch.items[batch.current];
  if (item) item.removals = state.removals;
}

/// A setting changed: every other image needs tracing again. Debounced so a
/// slider drag re-queues once, after it settles.
function batchSettingsChanged() {
  if (!batch.items.length) return;
  clearTimeout(batch.refresh);
  batch.refresh = setTimeout(() => {
    batch.items.forEach((it, i) => {
      if (i !== batch.current) Object.assign(it, { status: "waiting", result: null, cropped: null });
    });
    // A trace in flight used the old settings; its result is dropped.
    batch.busy = null;
    batch.worker?.terminate();
    batch.worker = null;
    renderBatch();
    pumpBatch();
  }, 350);
}

function removeFromBatch(i) {
  const [item] = batch.items.splice(i, 1);
  URL.revokeObjectURL(item.thumb);
  if (item.traceThumb) URL.revokeObjectURL(item.traceThumb);
  if (item.id === batch.busy) {
    batch.busy = null;
    batch.worker?.terminate();
    batch.worker = null;
  }
  if (i === batch.current) {
    batch.current = -1;
    if (batch.items.length) openBatchItem(Math.min(i, batch.items.length - 1));
  } else if (i < batch.current) {
    batch.current--;
  }
  if (!batch.items.length) clearBatch();
  renderBatch();
  pumpBatch();
}

function clearBatch() {
  for (const it of batch.items) {
    URL.revokeObjectURL(it.thumb);
    if (it.traceThumb) URL.revokeObjectURL(it.traceThumb);
  }
  batch.items = [];
  batch.current = -1;
  batch.busy = null;
  batch.worker?.terminate();
  batch.worker = null;
  renderBatch();
}

function renderBatch() {
  const bar = $("batch");
  const n = batch.items.length;
  bar.hidden = n === 0;
  if (!n) return;
  const done = batch.items.filter((it) => it.status === "done").length;
  const failed = batch.items.filter((it) => it.status === "error").length;
  $("batchCount").textContent = `${done} of ${n} traced` + (failed ? ` · ${failed} failed` : "");
  $("batchProgress").style.width = `${(100 * (done + failed)) / n}%`;
  $("batchSave").disabled = done === 0;
  $("batchSave").textContent = done === n ? `Save all ${n}` : `Save ${done} traced`;

  const strip = $("batchStrip");
  strip.replaceChildren(
    ...batch.items.map((it, i) => {
      if (it.status === "done" && it.result && !it.traceThumb) it.traceThumb = svgURL(it.result.svg);
      if (it.status !== "done" && it.traceThumb) {
        URL.revokeObjectURL(it.traceThumb);
        it.traceThumb = null;
      }
      const card = document.createElement("button");
      card.className = `bitem ${it.status}${i === batch.current ? " current" : ""}`;
      card.title = it.status === "error" ? `${it.name}: ${it.error}` : it.name;
      card.onclick = () => openBatchItem(i);
      const img = document.createElement("img");
      img.src = it.traceThumb ?? it.thumb;
      img.alt = "";
      const label = document.createElement("span");
      label.textContent = it.name;
      const badge = document.createElement("i");
      badge.className = "badge-dot";
      const x = document.createElement("span");
      x.className = "bx";
      x.textContent = "×";
      x.title = "Remove from batch";
      x.onclick = (e) => {
        e.stopPropagation();
        removeFromBatch(i);
      };
      card.append(img, label, badge, x);
      return card;
    }),
  );
}

/// SVG file names for the batch, unique within it (logo.png and logo.jpg
/// would both be logo.svg).
function batchFiles() {
  const used = new Set();
  return batch.items
    .filter((it) => it.status === "done")
    .map((it) => {
      const stem = it.name.replace(/\.[^.]+$/, "") || "trace";
      let name = `${stem}.svg`;
      for (let k = 2; used.has(name.toLowerCase()); k++) name = `${stem} (${k}).svg`;
      used.add(name.toLowerCase());
      return { name, contents: (it.cropped ?? it.result).svg };
    });
}

async function saveBatch() {
  const files = batchFiles();
  if (!files.length) return;
  if (desktop) {
    try {
      const saved = await desktop.core.invoke("save_all", { files });
      if (saved) setStatus(`Saved ${saved.count} SVGs to ${saved.folder.split(/[\\/]/).pop()}`);
    } catch (e) {
      setStatus(String(e), "error");
    }
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(zipStore(files));
  a.download = "btrace-svgs.zip";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  setStatus(`Downloaded ${files.length} SVGs as a zip`);
}

$("batchSave").onclick = saveBatch;
$("batchClear").onclick = () => {
  clearBatch();
};
$("batchAdd").onclick = () => ui.file.click();

// ---- zip (store-only; SVGs are small and this keeps it dependency-free) ------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/// A .zip of `files` ({ name, contents }) with no compression.
function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = enc.encode(f.contents);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(local, name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

// ---- bounds: the SVG's edge and the empty space around the drawing --------------------
//
// A dashed frame marks the edge of the SVG as it will be saved, and hatching
// shades the space between that edge and the drawing, so it's easy to see
// whether trimming would help. With "Trim empty space" on, the frame is the
// trimmed canvas (drawing + padding), mirroring the engine's crop.

function boundsOn() {
  return $("boundsBtn").getAttribute("aria-pressed") === "true";
}

function toggleBounds(on = !boundsOn()) {
  $("boundsBtn").setAttribute("aria-pressed", on);
  $("boundsBtn").classList.toggle("on", on);
  updateBounds();
}

/// The saved SVG's canvas in source px: the whole image, or the crop.
function savedCanvas(b) {
  if (!ui.crop.checked) return { x: 0, y: 0, w: state.width, h: state.height };
  const pad = +ui.pad.value;
  const bw = b[2] - b[0] + 2 * pad;
  const bh = b[3] - b[1] + 2 * pad;
  const w = Math.max(1, Math.ceil(bw));
  const h = Math.max(1, Math.ceil(bh));
  // The engine centres the drawing in the rounding slack.
  return { x: b[0] - pad - (w - bw) / 2, y: b[1] - pad - (h - bh) / 2, w, h };
}

function updateBounds() {
  const layer = $("boundsLayer");
  const badge = $("boundsBadge");
  const b = state.result?.bounds;
  const show = boundsOn() && state.loaded && b;
  // An <svg> has no `hidden` property (that's HTMLElement); use the attribute.
  layer.toggleAttribute("hidden", !show);
  badge.hidden = !show;
  if (!show) return;

  const c = savedCanvas(b);
  layer.setAttribute("viewBox", `0 0 ${state.width} ${state.height}`);
  const set = (el, x, y, w, h) => {
    el.setAttribute("x", x);
    el.setAttribute("y", y);
    el.setAttribute("width", w);
    el.setAttribute("height", h);
  };
  set($("boundsCanvas"), c.x, c.y, c.w, c.h);
  set($("boundsContent"), b[0], b[1], b[2] - b[0], b[3] - b[1]);
  $("boundsSpace").setAttribute(
    "d",
    `M${c.x},${c.y}h${c.w}v${c.h}h${-c.w}Z M${b[0]},${b[1]}h${b[2] - b[0]}v${b[3] - b[1]}h${b[0] - b[2]}Z`,
  );

  const r = (v) => Math.max(0, Math.round(v));
  const m = { top: r(b[1] - c.y), right: r(c.x + c.w - b[2]), bottom: r(c.y + c.h - b[3]), left: r(b[0] - c.x) };
  const total = m.top + m.right + m.bottom + m.left;
  const sides = `${m.top} top · ${m.right} right · ${m.bottom} bottom · ${m.left} left`;
  badge.textContent = ui.crop.checked
    ? `Trimmed to ${c.w} × ${c.h} px · space around the drawing: ${sides}`
    : total === 0
      ? `SVG ${c.w} × ${c.h} px · no empty space around the drawing`
      : `SVG ${c.w} × ${c.h} px · empty space: ${sides} px · "Trim empty space" removes it`;
}

$("boundsBtn").onclick = () => toggleBounds();
for (const el of [ui.crop, ui.pad, g.crop]) el.addEventListener("input", updateBounds);
for (const el of [ui.crop, g.crop]) el.addEventListener("change", updateBounds);

