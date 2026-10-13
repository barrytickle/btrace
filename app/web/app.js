// Btrace app: UI state, canvas interaction, and talking to the engine worker.

const $ = (id) => document.getElementById(id);

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

// ---- engine worker --------------------------------------------------------

const worker = new Worker("worker.js", { type: "module" });
let workerReady = false;
worker.onmessage = ({ data }) => {
  if (data.type === "ready") {
    workerReady = true;
    setStatus("");
  } else if (data.type === "loaded") {
    requestRender();
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

function options(withCrop) {
  const o = {
    hierarchical: ui.noOverlap.checked ? "cutout" : "stacked",
    mode: "spline",
    filterSpeckle: +ui.speckle.value,
    simplify: +ui.simplify.value,
    lines: ui.lines.checked,
    removeBackground: ui.removeBg.checked,
    remove: state.removals,
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

function requestRender() {
  if (!state.loaded) return;
  const id = ++state.renderId;
  setStatus("Tracing…", "busy");
  worker.postMessage({
    type: "render",
    id,
    options: options(false),
    cropped: ui.crop.checked ? options(true) : null,
  });
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

function download() {
  const out = state.cropped ?? state.result;
  if (!out) return;
  const a = document.createElement("a");
  a.href = svgURL(out.svg);
  a.download = `${state.name.replace(/\.[^.]+$/, "") || "trace"}.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- loading images ---------------------------------------------------------

async function loadBlob(blob, name) {
  try {
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data.buffer;
    bitmap.close();

    Object.assign(state, { name, width, height, removals: [], result: null, cropped: null, loaded: true, shownId: state.renderId });
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
  const f = ui.file.files[0];
  if (f) loadBlob(f, f.name);
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
  const f = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
  if (f) loadBlob(f, f.name);
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
  if (render) requestRender();
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
  // Clicked points refer to regions of the old segmentation.
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
