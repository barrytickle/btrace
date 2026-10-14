// PixPath app: start-up, actions, keyboard, and opening images.
//
// Flow: Start → "How would you like to trace it?" → Automatic / Advanced →
// Review → Save. Several images at once make a batch.

import { $, prefs, setStatus, svgName, svgURL, toast } from "./util.js";
import { S, options, croppedOptions, recommendedSettings } from "./state.js";
import * as engine from "./engine.js";
import * as viewer from "./viewer.js";
import * as screens from "./screens.js";
import * as recent from "./recent.js";
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
  engine.render(options(), croppedOptions());
}
screens.hooks.settingsChanged = requestRender;

engine.setResultHandler((result, cropped, ms) => {
  Object.assign(S, { result, cropped, ms });
  if (S.analysing) {
    S.first = result;
    S.analysing = false;
    viewer.setBusy(false);
  }
  viewer.setTrace(result);
  viewer.refresh();
  setStatus(`Traced in ${Math.round(ms)} ms`);
  screens.traced();
});

viewer.onRemove((point) => {
  S.removals = [...S.removals, point];
  requestRender();
  toast(point.wholeColor ? "Removed every shape of that colour · Ctrl+Z puts it back" : "Removed · Ctrl+Z puts it back");
});

// ---- opening images ------------------------------------------------------------------

async function openImage(blob, name) {
  let px;
  try {
    px = await engine.decode(blob);
  } catch (e) {
    toast(`Couldn't open ${name}: it doesn't look like an image`);
    return;
  }
  if (S.image) URL.revokeObjectURL(S.image.url);
  // Per-image state starts fresh: nothing carries over from the last image.
  const image = { name, blob, url: URL.createObjectURL(blob), width: px.width, height: px.height, transparent: px.transparent, whiteBorder: px.whiteBorder };
  Object.assign(S, {
    image,
    settings: recommendedSettings(image),
    removals: [],
    result: null,
    cropped: null,
    first: null,
    analysing: true,
  });
  S.view.tool = "compare";
  viewer.setImage(S.image.url);
  viewer.setTrace(null);
  document.title = `${name} · PixPath`;
  go("mode");
  recent.add({ name, blob, width: px.width, height: px.height });
  try {
    await engine.load(px);
  } catch (e) {
    setStatus(String(e.message || e), "error");
    return;
  }
  requestRender();
}

function openFiles(files, fromFolder = false) {
  const images = [...files].filter((f) => f.type.startsWith("image/"));
  if (!images.length) {
    if (files.length) toast(fromFolder ? "No images in that folder" : "That isn't an image PixPath can open");
    return;
  }
  if (images.length === 1 && !fromFolder && !S.batch) openImage(images[0], images[0].name);
  else addToBatch(images, fromFolder);
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

// ---- batch -------------------------------------------------------------------------------
//
// Every image is traced in turn in a second worker with the same settings
// "Fully automatic" would give it. Choosing how per batch, and reviewing each
// image, come later.

function addToBatch(files, fromFolder) {
  if (!S.batch) S.batch = { items: [], fromFolder, running: false };
  for (const f of files) {
    S.batch.items.push({ name: f.name, blob: f, thumb: URL.createObjectURL(f), status: "waiting", result: null, cropped: null, traceURL: null });
  }
  go("batch");
  pumpBatch();
}

async function pumpBatch() {
  const b = S.batch;
  if (!b || b.running) return;
  const it = b.items.find((x) => x.status === "waiting");
  if (!it) return;
  b.running = true;
  it.status = "tracing";
  if (S.screen === "batch") render();
  try {
    const settings = recommendedSettings(await engine.decode(it.blob));
    const out = await engine.traceOnce(it.blob, options(settings, []), croppedOptions(settings, []));
    Object.assign(it, { status: "done", result: out.result, cropped: out.cropped, traceURL: svgURL((out.cropped ?? out.result).svg) });
  } catch (e) {
    if (S.batch !== b) return; // the batch was closed
    Object.assign(it, { status: "error", error: String(e.message || e) });
  }
  b.running = false;
  if (S.batch !== b) return;
  if (S.screen === "batch") render();
  pumpBatch();
}

function closeBatch() {
  if (!S.batch) return;
  engine.cancelBatch();
  for (const it of S.batch.items) {
    URL.revokeObjectURL(it.thumb);
    if (it.traceURL) URL.revokeObjectURL(it.traceURL);
  }
  S.batch = null;
}

function removeFromBatch(i) {
  const b = S.batch;
  const [it] = b.items.splice(i, 1);
  URL.revokeObjectURL(it.thumb);
  if (it.traceURL) URL.revokeObjectURL(it.traceURL);
  if (it.status === "tracing") {
    // Restart the worker so the abandoned trace doesn't hold up the rest.
    engine.cancelBatch();
    b.running = false;
  }
  if (!b.items.length) {
    closeBatch();
    go("start");
    return;
  }
  render();
  pumpBatch();
}

/// SVG names for the batch, unique within it (logo.png and logo.jpg would
/// both be logo.svg).
function batchFiles() {
  const used = new Set();
  return S.batch.items
    .filter((it) => it.status === "done")
    .map((it) => {
      const stem = svgName(it.name).slice(0, -4);
      let name = `${stem}.svg`;
      for (let k = 2; used.has(name.toLowerCase()); k++) name = `${stem} (${k}).svg`;
      used.add(name.toLowerCase());
      return { name, contents: (it.cropped ?? it.result).svg };
    });
}

// ---- actions --------------------------------------------------------------------------------

function savedSvg() {
  return (S.cropped ?? S.result)?.svg;
}

async function save() {
  if (S.screen === "batch") return saveAll(batchFiles());
  if (!savedSvg()) return toast("Open an image first");
  await saveSvg(svgName(S.image.name), savedSvg());
}

async function copy() {
  if (!savedSvg()) return toast("Open an image first");
  toast((await copyText(savedSvg())) ? "SVG code copied, ready to paste" : "Couldn't copy to the clipboard");
}

function chooseMode(mode) {
  if (mode === "guided") {
    toast("Guided is on its way. Try Fully automatic or Advanced for now");
    return;
  }
  prefs.set("mode", mode);
  S.from = mode;
  if (mode === "auto") {
    S.settings = recommendedSettings();
    requestRender();
    go("review");
  } else {
    go("advanced");
  }
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

const hasImage = () => !!S.image && ["mode", "advanced", "review"].includes(S.screen);
const hasTrace = () => hasImage() && !!S.result;

const actions = {
  open: () => $("file").click(),
  folder: () => $("folder").click(),
  paste: pasteFromClipboard,
  save,
  saveAll: () => S.batch && saveAll(batchFiles()),
  copy,
  start: () => go("start"),
  startOver: () => {
    closeBatch();
    go("start");
  },
  review: () => go("review"),
  reviewBack: () => go(S.from === "advanced" ? "advanced" : "mode"),
  mode: () => go("mode"),
  advanced: () => go("advanced"),
  closeBatch: () => {
    closeBatch();
    go("start");
  },
  trim: () => {
    S.settings.trim = true;
    requestRender();
  },
  untrim: () => {
    S.settings.trim = false;
    requestRender();
  },
  removeBg: () => {
    S.settings.removeBg = true;
    requestRender();
  },
  undoRemove: () => {
    if (!S.removals.length) return;
    S.removals = S.removals.slice(0, -1);
    requestRender();
  },
  clearRemove: () => {
    S.removals = [];
    requestRender();
  },
  outlines: () => {
    S.view.outlines = !S.view.outlines;
    viewer.refresh();
  },
  bounds: () => {
    S.view.bounds = !S.view.bounds;
    viewer.refresh();
    if (["advanced", "review"].includes(S.screen)) render();
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
  if (a === "saveAll") return !!S.batch?.items.some((it) => it.status === "done");
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
  if (a.startsWith("batchRemove:")) return removeFromBatch(+a.slice(12));
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
