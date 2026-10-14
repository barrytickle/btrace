// PixPath app: start-up, actions, keyboard, and opening images.
//
// Flow: Start → "How would you like to trace it?" → Automatic / Guided /
// Advanced → Review → Save. Several images at once make a batch.

import { $, prefs, setStatus, svgName, toast } from "./util.js";
import { S, options, recommendedSettings, savedSvg, straysOf, trimCanvas, trimIsStale, trimWouldChange } from "./state.js";
import * as engine from "./engine.js";
import * as viewer from "./viewer.js";
import * as screens from "./screens.js";
import * as recent from "./recent.js";
import * as batch from "./batch.js";
import { setEnabled } from "./menu.js";
import { openDialog, closeDialog, dialogOpen, sendReport, links } from "./dialogs.js";
import { copyText, desktop, quietUpdateCheck, saveAll, saveSvg, version } from "./desktop.js";

const render = screens.render;

function go(screen) {
  S.screen = screen;
  render();
}

// ---- tracing ---------------------------------------------------------------------

function requestRender() {
  if (!S.image) return;
  engine.render(options());
}

/// A setting changed. Off Review, the trim follows the drawing; in Review it
/// only moves when Trim is clicked.
function settingsChanged() {
  if (S.screen !== "review") S.trimPending = true;
  requestRender();
}
screens.hooks.settingsChanged = settingsChanged;
screens.hooks.recolored = () => viewer.setTrace();

// A trace that fails must never leave "Analysing…" up forever.
engine.setFailHandler((message) => {
  if (S.analysing) {
    S.analysing = false;
    viewer.setBusy(false);
    if (S.screen === "mode") render();
  }
  toast(`PixPath couldn't trace this image (${message}). Try a smaller copy.`);
});

engine.setResultHandler((result, _cropped, ms) => {
  Object.assign(S, { result, ms });
  if (S.analysing) {
    S.first ??= result;
    S.analysing = false;
    viewer.setBusy(false);
  }
  if (trimWhenTraced && engine.idle()) {
    trimWhenTraced = false;
    queueMicrotask(trim);
  }
  if (S.trimPending && engine.idle()) {
    S.trimPending = false;
    // Only a trim that makes the canvas smaller is kept.
    S.trimBounds = S.settings.trim && trimWouldChange(result.bounds) ? result.bounds : null;
  }
  viewer.setTrace();
  viewer.refresh();
  setStatus(`Traced in ${Math.round(ms)} ms`);
  screens.traced();
});

viewer.onRemove((point) => {
  S.removals = [...S.removals, { kind: "click", points: [point] }];
  requestRender();
  toast(point.wholeColor ? "Removed every shape of that colour · Ctrl+Z puts it back" : "Removed · Ctrl+Z puts it back");
});

// ---- opening images ------------------------------------------------------------------

/// Open an image in the main view. `item` is a batch image to edit: its own
/// analysis, settings, removals, palette edits and trim come with it, and
/// the view opens at `where` ("mode" or "guided"). A new image starts fresh:
/// nothing carries over from the last one.
async function openImage(blob, name, item = null, where = "mode") {
  let px;
  try {
    px = await engine.decode(blob);
  } catch (e) {
    toast(`Couldn't open ${name}: it doesn't look like an image`);
    return;
  }
  if (S.image) URL.revokeObjectURL(S.image.url);
  if (!item) S.batchCtx = null;
  // width/height are the traced size; scale > 1 when a very large image is
  // traced smaller (the saved SVG gets the original size back).
  const image = { name, blob, url: URL.createObjectURL(blob), width: px.width, height: px.height, scale: px.scale, original: px.original };
  Object.assign(S, {
    image,
    analysis: item?.analysis ?? null,
    settings: item ? { ...item.settings } : recommendedSettings(null),
    removals: item ? [...item.removals] : [],
    recolor: item ? { ...item.recolor } : {},
    trimBounds: item?.trimBounds ?? null,
    trimPending: !item,
    result: item?.result ?? null,
    first: item?.first ?? null,
    autoUndo: {},
    analysing: true,
    step: 1,
    pickByHand: false,
  });
  S.view.tool = "compare";
  viewer.setImage(S.image.url);
  viewer.setTrace();
  document.title = `${name} · PixPath`;
  if (where === "guided") screens.openStep(1);
  else go(where);
  if (!item) recent.add({ name, blob, width: px.width, height: px.height });
  let analysis;
  try {
    analysis = await engine.load(px);
  } catch (e) {
    setStatus(String(e.message || e), "error");
    return;
  }
  if (S.image !== image) return; // another image was opened meanwhile
  S.analysis = analysis;
  // An engine that sends no analysis is an old copy the browser kept.
  if (!analysis) setStatus("This window is running old PixPath files. Close it and open PixPath again.", "error");
  if (!item) S.settings = recommendedSettings();
  requestRender();
}

function openFiles(files, fromFolder = false) {
  const images = [...files].filter((f) => f.type.startsWith("image/"));
  if (!images.length) {
    if (files.length) toast(fromFolder ? "No images in that folder" : "That isn't an image PixPath can open");
    return;
  }
  if (images.length === 1 && !fromFolder && !S.batch) openImage(images[0], images[0].name);
  else batch.start(images, fromFolder);
}

$("file").onchange = () => {
  openFiles($("file").files);
  $("file").value = "";
};
$("folder").onchange = () => {
  openFiles($("folder").files, true);
  $("folder").value = "";
};

// Drop anywhere on the window.
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  $("stage").classList.add("over");
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("stage").classList.remove("over");
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("stage").classList.remove("over");
  if (e.dataTransfer?.files.length) openFiles(e.dataTransfer.files);
});

// Ctrl+V anywhere.
window.addEventListener("paste", (e) => {
  if (e.target.matches?.("input, textarea")) return;
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
  if (item) openImage(item.getAsFile(), "pasted-image.png");
  else toast("There's no image on the clipboard. Copy one first");
});

async function pasteFromClipboard() {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith("image/"));
      if (type) return openImage(await it.getType(type), "pasted-image.png");
    }
    toast("There's no image on the clipboard. Copy one first");
  } catch {
    toast("Press Ctrl+V to paste your image");
  }
}
window.addEventListener("focus", () => S.screen === "start" && screens.peekClipboard());

// ---- batch ---------------------------------------------------------------------------------

batch.hooks.edit = (item, where) => openImage(item.blob, item.name, item, where);
batch.hooks.current = () => S;

function closeBatch() {
  batch.close();
}

// ---- actions --------------------------------------------------------------------------------

async function save() {
  if (S.screen === "batch" || S.screen === "breview") return saveAll(batch.files());
  if (!savedSvg()) return toast("Open an image first");
  await saveSvg(svgName(S.image.name), savedSvg());
}

async function copy() {
  if (!savedSvg()) return toast("Open an image first");
  toast((await copyText(savedSvg())) ? "SVG code copied, ready to paste" : "Couldn't copy to the clipboard");
}

function chooseMode(mode) {
  prefs.set("mode", mode);
  S.from = mode;
  if (mode === "auto") {
    applyAutomatic();
    go("auto");
  } else if (mode === "guided") {
    screens.openStep(1);
  } else {
    go("advanced");
  }
}

/// Fully automatic: every recommendation, stray shapes removed. Each part
/// can be undone on its own from "What PixPath did".
function applyAutomatic() {
  S.settings = recommendedSettings();
  S.autoUndo = {};
  S.recolor = {};
  const strays = straysOf(S.first);
  S.removals = strays.length ? [{ kind: "strays", points: strays, auto: true }] : [];
  S.trimPending = true;
  requestRender();
}

function autoUndo(k) {
  const undone = (S.autoUndo[k] = !S.autoUndo[k]);
  S.trimPending = true; // off Review, the trim follows the drawing
  if (k === "bg") S.settings.removeBg = !undone;
  else if (k === "lines") S.settings.lines = !undone;
  else if (k === "glow") S.settings.glow = !undone;
  else if (k === "trim") {
    S.settings.trim = !undone;
    S.trimBounds = null;
    S.trimPending = true;
  } else if (k === "strays") {
    const strays = straysOf(S.first);
    S.removals = undone ? S.removals.filter((r) => !r.auto) : [{ kind: "strays", points: strays, auto: true }, ...S.removals];
  }
  requestRender();
  render();
}

// ---- trim (Review) ----------------------------------------------------------------------------
//
// Trim is a button: it fits the canvas to the drawing as it is now, and
// stays put until clicked again.

let trimWhenTraced = false;

function trim() {
  if (!S.result) return;
  // A removal is still being traced: trim to its result.
  if (!engine.idle()) {
    trimWhenTraced = true;
    return;
  }
  const b = S.result.bounds;
  const trimmed = S.settings.trim && S.trimBounds;
  if (!b || !trimWouldChange(b)) {
    toast("Nothing to trim: the drawing already fills the canvas");
    if (trimmed) {
      S.settings.trim = false;
      S.trimBounds = null;
      viewer.refresh();
      render();
    }
    return;
  }
  if (trimmed && !trimIsStale()) {
    toast("Already trimmed to fit the drawing");
    return;
  }
  S.settings.trim = true;
  S.trimBounds = b;
  const c = trimCanvas(b);
  toast(`Trimmed to ${c.w} × ${c.h} px`);
  viewer.refresh();
  render();
}

function setTheme() {
  const r = document.documentElement;
  r.dataset.theme = r.dataset.theme === "dark" ? "light" : "dark";
  prefs.set("theme", r.dataset.theme);
  // The early script in index.html reads the raw value.
  try {
    localStorage.setItem("pixpath.theme", r.dataset.theme);
  } catch {}
}

const hasImage = () => !!S.image && ["mode", "auto", "guided", "advanced", "review"].includes(S.screen);
const hasTrace = () => hasImage() && !!S.result;

const actions = {
  open: () => $("file").click(),
  folder: () => $("folder").click(),
  paste: pasteFromClipboard,
  save,
  saveAll: () => S.batch && saveAll(batch.files()),
  ...batch.actions,
  copy,
  start: () => go("start"),
  startOver: () => {
    closeBatch();
    go("start");
  },
  review: () => (S.screen === "guided" ? screens.openStep(5) : go("review")),
  reviewBack: () => (S.from === "guided" ? screens.openStep(screens.lastStep()) : go({ advanced: "advanced", auto: "auto" }[S.from] ?? "mode")),
  guidedNext: () => screens.nextStep(),
  guidedPrev: () => screens.prevStep(),
  mode: () => go("mode"),
  advanced: () => go("advanced"),
  closeBatch: () => {
    closeBatch();
    go("start");
  },
  trim,
  resetColours: () => {
    S.recolor = {};
    viewer.setTrace();
    render();
  },
  untrim: () => {
    S.settings.trim = false;
    S.trimBounds = null;
    viewer.refresh();
    render();
  },
  removeBg: () => {
    if (S.settings.removeBg) return;
    S.settings.removeBg = true;
    S.removals = [...S.removals, { kind: "background" }];
    toast("Removed the background · Ctrl+Z puts it back");
    requestRender();
  },
  undoRemove: () => {
    const last = S.removals.at(-1);
    if (!last) return;
    S.removals = S.removals.slice(0, -1);
    if (last.kind === "background") S.settings.removeBg = false;
    toast(last.kind === "background" ? "Put the background back" : last.kind === "strays" ? "Put the stray shapes back" : "Put it back");
    requestRender();
  },
  clearRemove: () => {
    if (S.removals.some((r) => r.kind === "background")) S.settings.removeBg = false;
    S.removals = [];
    toast("Put everything back");
    requestRender();
  },
  removeStrays: () => {
    const points = straysOf(S.result);
    if (!points.length) return;
    S.removals = [...S.removals, { kind: "strays", points }];
    toast(`Removed ${points.length} stray shape${points.length === 1 ? "" : "s"} · Ctrl+Z puts them back`);
    requestRender();
  },
  outlines: () => {
    S.view.outlines = !S.view.outlines;
    viewer.refresh();
  },
  bounds: () => {
    S.view.bounds = !S.view.bounds;
    viewer.refresh();
    if (["auto", "guided", "advanced", "review"].includes(S.screen)) render();
  },
  fit: () => viewer.fit(),
  zoomIn: () => viewer.zoomBy(1.25),
  zoomOut: () => viewer.zoomBy(0.8),
  theme: setTheme,
  sendReport,
  ...links,
};

/// Whether a menu item applies right now.
setEnabled((a) => {
  if (["save", "copy"].includes(a)) return hasTrace() || (a === "save" && S.screen === "batch");
  if (a === "saveAll") return batch.files().length > 0;
  if (a === "undoRemove" || a === "clearRemove") return hasImage() && S.removals.length > 0;
  if (a.startsWith("tool:")) return hasTrace() && S.screen !== "mode";
  if (["outlines", "bounds"].includes(a)) return hasTrace();
  if (["fit", "zoomIn", "zoomOut"].includes(a)) return hasImage();
  return true;
});

function run(a, el) {
  if (a.startsWith("dlg:")) return openDialog(a.slice(4));
  if (a.startsWith("mode:")) return chooseMode(a.slice(5));
  if (a.startsWith("tool:")) return viewer.setTool(a.slice(5));
  if (a.startsWith("recent:")) {
    const r = screens.recentItem(+a.slice(7));
    if (r) openImage(r.blob, r.name);
    return;
  }

  if (a.startsWith("step:")) return screens.openStep(+a.slice(5));
  if (a.startsWith("autoUndo:")) return autoUndo(a.slice(9));
  const colon = a.indexOf(":");
  if (colon > 0 && batch.run(a.slice(0, colon), a.slice(colon + 1))) return;
  actions[a]?.(el);
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (el && !el.disabled) run(el.dataset.act, el);
});

// After any re-trace, Review's numbers change; the panel re-renders itself
// in screens.traced(). Toggles that change the trace re-render there too.

// ---- keyboard ---------------------------------------------------------------------------------

window.addEventListener("keydown", (e) => {
  if (dialogOpen()) {
    if (e.key === "Escape") closeDialog();
    return;
  }
  const typing = e.target.matches?.("input:not([type=range]), textarea");
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (ctrl) {
    const shortcut = {
      o: e.shiftKey ? "folder" : "open",
      s: e.shiftKey ? "saveAll" : "save",
      z: "undoRemove",
      c: e.shiftKey ? "copy" : null,
    }[k];
    if (!shortcut || typing) return;
    e.preventDefault();
    run(shortcut);
    return;
  }
  if (typing || e.altKey) return;
  if (e.key === "?") return openDialog("shortcuts");
  if (!hasImage()) return;
  if (e.key === "Escape" && S.view.tool !== "compare") viewer.setTool("compare");
  else if (k === "r" && viewer.canRemove()) viewer.setTool(S.view.tool === "remove" ? "compare" : "remove");
  else if (k === "p" && S.result) viewer.setTool(S.view.tool === "preview" ? "compare" : "preview");
  else if (k === "v" && S.result) viewer.setTool("compare");
  else if (k === "o") actions.outlines();
  else if (k === "b") actions.bounds();
  else if (k === "0") viewer.fit();
  else if (k === "+" || k === "=") viewer.zoomBy(1.25);
  else if (k === "-") viewer.zoomBy(0.8);
});

// ---- start-up -----------------------------------------------------------------------------------

version().then((v) => v && ($("version").textContent = `v${v}`));
if (desktop) quietUpdateCheck();
render();
