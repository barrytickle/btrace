// The picture: the original and the trace stacked at the same size, with
// zoom, pan, a draggable compare divider, and the Review clean-up tools.
//
// One viewer lives for the whole session and moves into whichever screen
// shows a picture, so zoom and pan survive moving between screens.

import { S, savedCanvas, shownSvg } from "./state.js";
import { svgURL } from "./util.js";

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 32;
/// Keep at least this many px of the image on screen, so zooming or dragging
/// can never lose it off the edge.
const KEEP_VISIBLE = 48;
/// Space around the image when it's fitted to the window.
const FIT_MARGIN = 56;

const html = `
  <div class="viewport" id="vp">
    <div class="art" id="art">
      <img class="orig" id="vOrig" alt="Original image" draggable="false">
      <div class="vec" id="vVec" role="img" aria-label="Traced SVG"></div>
      <svg class="bounds" id="vBounds" aria-hidden="true" hidden>
        <defs><pattern id="vHatch" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect fill="rgba(201,138,18,.45)"/></pattern></defs>
        <path id="vSpace" fill="url(#vHatch)" fill-rule="evenodd"/>
        <rect id="vFrame" fill="none" stroke="#c98a12" stroke-width="1.5" stroke-dasharray="5 3" vector-effect="non-scaling-stroke"/>
      </svg>
      <div class="split" id="vSplit" role="slider" tabindex="0" aria-label="Compare: drag to show more of the original or the SVG" aria-valuemin="0" aria-valuemax="100"></div>
    </div>
  </div>
  <div class="tools" id="vTools" role="toolbar" aria-label="Picture tools">
    <button data-tool="compare" title="Compare with the original (V)"><svg viewBox="0 0 16 16"><path d="M8 2v12M2 3h12v10H2z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>Compare</button>
    <button data-tool="preview" title="Just the SVG, on a transparency grid (P)"><svg viewBox="0 0 16 16"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>Preview</button>
    <button data-tool="remove" title="Click anything to remove it, the background too (R)"><svg viewBox="0 0 16 16"><path d="M2 11l5-5 4 4-3 3H4zM7 6l3-3 4 4-3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>Remove</button>
  </div>
  <span class="tag l" id="vTagL">Original</span><span class="tag r" id="vTagR">PixPath SVG</span>
  <span class="hint" id="vHint" hidden></span>
  <div class="zoombar" role="group" aria-label="Zoom">
    <button id="vOut" title="Zoom out (−)" aria-label="Zoom out">−</button>
    <button class="pct" id="vPct" title="Fit to window (0)">100%</button>
    <button id="vIn" title="Zoom in (+)" aria-label="Zoom in">+</button>
    <button id="vFit" title="Centre the picture and fit it to the window (0)">Centre</button>
  </div>
  <div class="analysing" id="vBusy" hidden><span class="spinner"></span><span>Analysing your image…</span></div>`;

const root = document.createElement("div");
root.style.display = "contents";
root.innerHTML = html;
const el = (id) => root.querySelector(`#${id}`);
const vp = el("vp"), art = el("art"), orig = el("vOrig"), vec = el("vVec"), split = el("vSplit");

const view = { zoom: 1, panX: 0, panY: 0, fitted: false };
let config = { tools: false, removable: false, trace: true, hint: "" };
let outlineImg = null;
let outlineURL = null;
let handlers = { remove: () => {}, tool: () => {} };

/// Put the viewer into `stage` with this screen's options:
///   trace: show the trace (else only the original), tools: show the toolbar,
///   removable: offer Remove, hint: a line of help at the bottom.
export function mount(stage, opts = {}) {
  config = { tools: false, removable: false, trace: true, hint: "", ...opts };
  if (root.parentElement !== stage) {
    stage.replaceChildren(root);
    stage.className = "stage has-viewer";
  }
  if (!config.removable && S.view.tool === "remove") S.view.tool = "compare";
  refresh();
  // The stage may have just been laid out (or resized by the new panel).
  requestAnimationFrame(() => (view.fitted ? layout() : fit()));
}

export function onRemove(fn) {
  handlers.remove = fn;
}

/// A new image: show it and fit it to the window.
export function setImage(url) {
  orig.src = url;
  vec.replaceChildren();
  view.fitted = false;
  if (root.isConnected) fit();
}

/// Show the open image's trace (S.result, with palette edits), or clear it.
export function setTrace() {
  vec.innerHTML = shownSvg();
  updateOutlines();
  updateBounds();
}

/// Show or hide the "Analysing" veil.
export function setBusy(on) {
  el("vBusy").hidden = !on;
}

/// Re-read S.view and the screen options (tool, outlines, bounds, hint).
export function refresh() {
  const tool = S.view.tool;
  const trace = config.trace && !!S.result;
  el("vTools").hidden = !config.tools || !S.result;
  el("vTools").querySelector('[data-tool="remove"]').hidden = !config.removable;
  el("vTools").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.tool === tool));
  const compare = trace && tool === "compare";
  vec.hidden = !trace;
  orig.hidden = trace && tool !== "compare";
  split.hidden = !compare;
  el("vTagL").hidden = !compare;
  el("vTagR").hidden = !compare;
  vp.classList.toggle("removing", trace && tool === "remove");

  let hint = config.hint;
  if (trace && tool === "remove") hint = "Click anything to remove it, the background too · Shift-click: every shape that colour · Esc to stop";
  else if (trace && tool === "preview" && config.tools) hint = "Your SVG as it will be saved · the grid shows transparency";
  el("vHint").hidden = !hint;
  el("vHint").textContent = hint;
  updateOutlines();
  updateBounds();
  layout();
}

// ---- zoom and pan -----------------------------------------------------------

function size() {
  return { w: S.image?.width || 1, h: S.image?.height || 1 };
}

function fitZoom() {
  const r = vp.getBoundingClientRect();
  const { w, h } = size();
  const z = Math.min((r.width - FIT_MARGIN) / w, (r.height - FIT_MARGIN) / h);
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z || 1));
}

/// Fit the whole image in the window, centred.
export function fit() {
  if (!S.image) return;
  const r = vp.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const { w, h } = size();
  view.zoom = fitZoom();
  view.panX = (r.width - w * view.zoom) / 2;
  view.panY = (r.height - h * view.zoom) / 2;
  view.fitted = true;
  layout();
}

function layout() {
  if (!S.image) return;
  const r = vp.getBoundingClientRect();
  const { w, h } = size();
  const zw = w * view.zoom;
  const zh = h * view.zoom;
  const keepX = Math.min(KEEP_VISIBLE, zw);
  const keepY = Math.min(KEEP_VISIBLE, zh);
  view.panX = Math.min(r.width - keepX, Math.max(keepX - zw, view.panX));
  view.panY = Math.min(r.height - keepY, Math.max(keepY - zh, view.panY));
  Object.assign(art.style, { left: `${view.panX}px`, top: `${view.panY}px`, width: `${zw}px`, height: `${zh}px` });
  orig.classList.toggle("pixelated", view.zoom >= 3);
  el("vPct").textContent = `${Math.round(view.zoom * 100)}%`;

  // Each side clips the other out: the trace has transparent areas that must
  // show the grid, not the original beneath.
  const pct = S.view.split * 100;
  const compare = !split.hidden;
  split.style.left = `${pct}%`;
  split.setAttribute("aria-valuenow", Math.round(pct));
  vec.style.clipPath = compare ? `inset(0 0 0 ${pct}%)` : "none";
  orig.style.clipPath = compare ? `inset(0 ${100 - pct}% 0 0)` : "none";

  // Keep the empty-space hatching about 8 screen px apart at any zoom.
  const hatch = root.querySelector("#vHatch");
  hatch.setAttribute("width", 8 / view.zoom);
  hatch.setAttribute("height", 8 / view.zoom);
  hatch.firstElementChild.setAttribute("width", 3 / view.zoom);
  hatch.firstElementChild.setAttribute("height", 8 / view.zoom);
}

function zoomAt(factor, cx, cy) {
  // Never zoom out past a quarter of the fit-to-window size: any further and
  // a small image becomes a dot you can lose.
  const min = Math.max(ZOOM_MIN, fitZoom() / 4);
  const z = Math.min(ZOOM_MAX, Math.max(min, view.zoom * factor));
  const k = z / view.zoom;
  view.panX = cx - (cx - view.panX) * k;
  view.panY = cy - (cy - view.panY) * k;
  view.zoom = z;
  layout();
}

export function zoomBy(factor) {
  const r = vp.getBoundingClientRect();
  zoomAt(factor, r.width / 2, r.height / 2);
}

vp.addEventListener("wheel", (e) => {
  if (!S.image) return;
  e.preventDefault();
  const r = vp.getBoundingClientRect();
  zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

el("vIn").onclick = () => zoomBy(1.25);
el("vOut").onclick = () => zoomBy(0.8);
el("vPct").onclick = el("vFit").onclick = () => fit();
new ResizeObserver(() => root.isConnected && (view.fitted ? layout() : fit())).observe(vp);

let spaceHeld = false;
window.addEventListener("keydown", (e) => {
  if (e.key === " " && !e.target.matches?.("input, textarea, button")) spaceHeld = true;
});
window.addEventListener("keyup", (e) => {
  if (e.key === " ") spaceHeld = false;
});

// Pointer: drag the divider, pan, or (Remove tool) click a shape away.
let drag = null;
vp.addEventListener("pointerdown", (e) => {
  if (!S.image || e.button === 2) return;
  const onSplit = e.target === split;
  const removing = vp.classList.contains("removing") && e.button === 0 && !spaceHeld;
  drag = { kind: onSplit ? "split" : "pan", removing, x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY, moved: false };
  vp.setPointerCapture(e.pointerId);
  if (onSplit) moveSplit(e);
  e.preventDefault();
});
vp.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) {
    drag.moved = true;
    if (drag.kind === "pan") vp.classList.add("dragging");
  }
  if (drag.kind === "split") moveSplit(e);
  else if (drag.moved) {
    view.panX = drag.panX + dx;
    view.panY = drag.panY + dy;
    layout();
  }
});
vp.addEventListener("pointerup", (e) => {
  if (drag?.removing && drag.kind === "pan" && !drag.moved) removeAt(e);
  drag = null;
  vp.classList.remove("dragging");
});
vp.addEventListener("pointercancel", () => {
  drag = null;
  vp.classList.remove("dragging");
});

function moveSplit(e) {
  const r = art.getBoundingClientRect();
  S.view.split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  layout();
}

split.addEventListener("keydown", (e) => {
  const step = e.shiftKey ? 0.1 : 0.02;
  const v = { ArrowLeft: S.view.split - step, ArrowRight: S.view.split + step, Home: 0, End: 1 }[e.key];
  if (v === undefined) return;
  S.view.split = Math.min(1, Math.max(0, v));
  e.preventDefault();
  layout();
});

function removeAt(e) {
  const r = art.getBoundingClientRect();
  const x = (e.clientX - r.left) / view.zoom;
  const y = (e.clientY - r.top) / view.zoom;
  const { w, h } = size();
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  handlers.remove({ x, y, wholeColor: e.shiftKey });
}

el("vTools").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tool]");
  if (b) setTool(b.dataset.tool);
});

/// Compare, Preview or Remove.
export function setTool(tool) {
  if (tool === "remove" && !config.removable) return;
  S.view.tool = tool;
  refresh();
}

/// Whether the current screen offers the Remove tool.
export function canRemove() {
  return config.removable && !!S.result;
}

// ---- outlines and bounds ------------------------------------------------------

/// The trace drawn as dashed guide lines, styled like an editor guide so it
/// never reads as artwork.
function outlineSVG(svg) {
  const style =
    "<style>path{fill:none!important;stroke:#10a98d;stroke-width:1.25;stroke-dasharray:4 3;" +
    "vector-effect:non-scaling-stroke;stroke-linejoin:round}</style>";
  return svg.replace(/<svg[^>]*>/, (m) => m + style);
}

function updateOutlines() {
  if (outlineURL) URL.revokeObjectURL(outlineURL);
  outlineURL = null;
  const show = S.view.outlines && config.trace && S.result;
  if (!show) {
    outlineImg?.remove();
    outlineImg = null;
    return;
  }
  outlineURL = svgURL(outlineSVG(S.result.svg));
  outlineImg ??= Object.assign(document.createElement("img"), { className: "outline", alt: "", draggable: false });
  outlineImg.src = outlineURL;
  if (!outlineImg.isConnected) art.insertBefore(outlineImg, el("vBounds"));
}

/// The empty space around the drawing, in px per side (untrimmed canvas).
export function margins(b = S.result?.bounds) {
  const { w, h } = size();
  if (!b) return null;
  const r = (v) => Math.max(0, Math.round(v));
  return { top: r(b[1]), right: r(w - b[2]), bottom: r(h - b[3]), left: r(b[0]) };
}

/// A dashed frame marks the SVG's edge as it will be saved; untrimmed, the
/// empty space around the drawing is hatched.
function updateBounds() {
  const layer = el("vBounds");
  const b = S.result?.bounds;
  const show = config.trace && b && (S.view.bounds || S.settings.trim);
  layer.toggleAttribute("hidden", !show);
  if (!show) return;
  const { w, h } = size();
  const c = savedCanvas();
  layer.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const frame = el("vFrame");
  for (const [k, v] of Object.entries({ x: c.x, y: c.y, width: c.w, height: c.h })) frame.setAttribute(k, v);
  el("vSpace").setAttribute(
    "d",
    S.settings.trim && S.trimBounds ? "" : `M${c.x},${c.y}h${c.w}v${c.h}h${-c.w}Z M${b[0]},${b[1]}h${b[2] - b[0]}v${b[3] - b[1]}h${b[0] - b[2]}Z`,
  );
}

/// A one-line description of the empty space, for panels.
export function spaceText() {
  const m = margins();
  if (!m) return "";
  const total = m.top + m.right + m.bottom + m.left;
  if (!total) return "No empty space around the drawing";
  if (m.top === m.bottom && m.left === m.right) return `${m.left} px at the sides, ${m.top} px top and bottom`;
  return `${m.top} top · ${m.right} right · ${m.bottom} bottom · ${m.left} left (px)`;
}
