// Batches: several images at once.
//
// Every image is traced straight away, in the background, the way Fully
// automatic would trace it (its own analysis, stray shapes removed). Then
// the user picks a route:
//   auto: go straight to the batch review;
//   same: answer the Guided questions once (on the first image), then apply
//         those settings to every image;
//   each: go through every image with the single-image flow.
// The batch review lists every image (Ready / Needs a look / Skipped) with
// quick fixes and "Edit this image". Each image keeps its own settings,
// removals, palette edits and trim, so nothing leaks between images.

import { $, esc, icon, plural, prefs, svgName, svgURL, toast } from "./util.js";
import { S, TYPES, options, recommendedSettings, removalPoints, savedSvg, savedCanvas, trimCanvas } from "./state.js";
import * as engine from "./engine.js";
import { ladder, colourName } from "./guided.js";
import { render } from "./screens.js";

const stage = $("stage"), panel = $("panel"), foot = $("foot"), stepper = $("stepper");

export const ROUTES = {
  auto: ["Fully automatic", "Each image gets its own recommendations: background, trimming and colours decided per image."],
  same: ["Same settings for all", "Answer the guided questions once, on the first image; they apply to every image."],
  each: ["One by one", "Go through every image yourself, the same way as a single upload."],
};

// ---- the batch and its images -----------------------------------------------------------

let nextId = 1;

export function start(files, fromFolder) {
  if (!S.batch) S.batch = { items: [], fromFolder, route: prefs.get("batchRoute", "auto"), running: false, filter: "all" };
  for (const f of files) {
    S.batch.items.push({
      id: nextId++, name: f.name, blob: f, thumb: URL.createObjectURL(f), status: "waiting",
      width: 0, height: 0, analysis: null, settings: null, removals: [], recolor: {}, trimBounds: null,
      result: null, first: null, traceURL: null, fullURL: null, include: true, open: false, flag: null, edited: false, done: false,
    });
  }
  S.batchCtx = null;
  S.screen = "batch";
  render();
  pump();
}

export function close() {
  if (!S.batch) return;
  engine.cancelBatch();
  for (const it of S.batch.items) forget(it);
  S.batch = null;
  S.batchCtx = null;
}

function forget(it) {
  URL.revokeObjectURL(it.thumb);
  if (it.traceURL) URL.revokeObjectURL(it.traceURL);
  if (it.fullURL) URL.revokeObjectURL(it.fullURL);
}

/// Engine options for every kind of image, with and without its background:
/// the worker picks one per image once it has analysed it.
function autoTable() {
  const table = {};
  for (const kind of Object.keys(TYPES)) {
    table[kind] = {};
    for (const [key, removeBackground] of [["keep", false], ["remove", true]]) {
      table[kind][key] = { options: options(recommendedSettings({ kind, removeBackground }), []) };
    }
  }
  return table;
}

/// Trace waiting images one at a time.
async function pump() {
  const b = S.batch;
  if (!b || b.running) return;
  const it = b.items.find((x) => x.status === "waiting");
  if (!it) {
    if (S.screen === "batch" || S.screen === "breview") render();
    return;
  }
  b.running = true;
  it.status = "tracing";
  if (S.screen === "batch") render();
  try {
    const job = it.settings
      ? { options: options(it.settings, removalPoints(it.removals)), strays: !!it.findStrays, kind: it.settings.type }
      : { auto: autoTable(), strays: true };
    const out = await engine.traceOnce(it.blob, job);
    if (!it.settings) {
      Object.assign(it, {
        analysis: out.analysis,
        settings: recommendedSettings(out.analysis),
        removals: out.strays.length ? [{ kind: "strays", points: out.strays, auto: true }] : [],
        first: out.first,
      });
      it.flag = flagFor(it);
      it.open = !!it.flag;
    } else if (it.findStrays) {
      it.removals = out.strays.length ? [{ kind: "strays", points: out.strays, auto: true }] : [];
      it.first = out.first;
      it.findStrays = false;
    }
    Object.assign(it, { status: "done", result: out.result, width: out.width, height: out.height, scale: out.scale, original: out.original });
    it.trimBounds = it.settings.trim && trims(it, out.result.bounds) ? out.result.bounds : null;
    refreshThumbs(it);
  } catch (e) {
    if (S.batch !== b) return; // the batch was closed
    if (String(e.message) === "cancelled") it.status = "waiting";
    else Object.assign(it, { status: "error", error: String(e.message || e) });
  }
  b.running = false;
  if (S.batch !== b) return;
  if (S.screen === "batch" || S.screen === "breview") render();
  else drawBar();
  pump();
}

/// Trace image `it` again with its own (changed) settings.
function retrace(it) {
  it.status = "waiting";
  pump();
}

function refreshThumbs(it) {
  if (it.traceURL) URL.revokeObjectURL(it.traceURL);
  if (it.fullURL) URL.revokeObjectURL(it.fullURL);
  it.traceURL = svgURL(savedSvg(it));
  it.fullURL = svgURL(savedSvg({ ...it, trimBounds: null }));
}

/// Whether trimming `it` to bounds `b` makes the canvas smaller.
function trims(it, b = it.result?.bounds) {
  if (!b) return false;
  const c = trimCanvas(b, it.settings.pad);
  return c.w < it.width || c.h < it.height;
}

/// What, if anything, is worth a look in an automatic result, with a fix.
function flagFor(it) {
  const an = it.analysis;
  if (an.background && !an.removeBackground && an.transparentShare < 0.01) {
    const name = colourName(an.background.color);
    return {
      text: `The <b>${name}</b> edge was <b>kept</b>: PixPath thinks it's part of the picture.`,
      fix: "Remove the background",
      apply: (x) => Object.assign(x.settings, { removeBg: true, trim: true }),
    };
  }
  if (TYPES[it.settings.type].engine === "snap" && an.nearDuplicates.length) {
    const L = ladder(it);
    if (L.current > 2) {
      return {
        text: "Two colours look <b>almost alike</b>. If they should be one colour, use one fewer.",
        fix: "Use one fewer colour",
        apply: (x) => (x.settings.maxColors = ladder(x).maxColorsFor(L.current - 1)),
      };
    }
  }
  return null;
}

function itemWhat(it) {
  if (it.status === "error") return esc(it.error);
  if (it.status !== "done") return it.status === "tracing" ? "Tracing…" : "Waiting";
  const s = it.settings;
  return [
    TYPES[s.type].engine === "snap" ? plural(ladder(it).current, "colour") : TYPES[s.type].label,
    s.removeBg ? "background removed" : "background kept",
    s.trim && trims(it, it.trimBounds) ? "trimmed" : "not trimmed",
    it.edited ? "edited by you" : "",
  ].filter(Boolean).join(" · ");
}

// ---- batch screen: tracing + choosing a route ----------------------------------------------

export function batchScreen() {
  stepper.hidden = true;
  const b = S.batch;
  const n = b.items.length;
  const done = b.items.filter((it) => it.status === "done" || it.status === "error").length;
  stage.className = "stage list";
  stage.innerHTML = `<div class="batchlist">
      <div style="display:flex;justify-content:space-between;align-items:baseline"><b style="font-family:var(--display);font-size:20px">${plural(n, "image")}</b><span style="color:var(--ink-2);font-size:14px">${done} of ${n} traced</span></div>
      <div class="progress"><div style="width:${(100 * done) / n}%"></div></div>
      ${b.items.map((it, i) => {
        const st = { done: ["done", "Done"], tracing: ["run", "Tracing…"], error: ["", "Couldn't trace"], waiting: ["", "Waiting"] }[it.status];
        return `<div class="bfile${it.status === "error" ? " err" : ""}"><span class="th checker"><img src="${it.traceURL ?? it.thumb}" alt=""></span>
          <span><b>${esc(it.name)}</b><small>${itemWhat(it)}</small></span>
          <span class="state ${st[0]}">${st[1]}</span><button class="btn ghost small" data-act="batchRemove:${i}" title="Leave this image out" aria-label="Leave ${esc(it.name)} out">×</button></div>`;
      }).join("")}
    </div>`;
  panel.innerHTML = `<h2>Batch: ${plural(n, "image")}</h2>
    <p class="sub">${b.fromFolder ? "Every image in the folder is being traced." : "You opened several images, so PixPath made a batch."} How would you like to go through them?</p>
    ${Object.entries(ROUTES).map(([k, [t, d]]) => `<button class="mode${b.route === k ? " picked" : ""}" data-act="batchRoute:${k}"><strong>${t}</strong>${k === "auto" ? `<span class="rec">Recommended</span>` : "<span></span>"}<p>${d}</p></button>`).join("")}
    <div class="tip">${icon.bulb}<span>Whichever you pick, you'll review every image together at the end before anything is saved.</span></div>
    <button class="btn" data-act="open">Add more images…</button>`;
  const ready = done === n;
  const first = b.items[0]?.status === "done";
  const go = {
    auto: ready ? "Review the batch →" : `Tracing ${Math.min(done + 1, n)} of ${n}…`,
    same: first ? "Answer the questions →" : "Tracing the first image…",
    each: first ? "Start with image 1 →" : "Tracing the first image…",
  }[b.route];
  const can = b.route === "auto" ? ready : first;
  foot.innerHTML = `<button class="btn" data-act="closeBatch">← Back</button><div class="spacer"></div>
    <button class="btn primary" data-act="batchGo" ${can ? "" : "disabled"}>${go}</button>`;
}

// ---- batch review -------------------------------------------------------------------------------

function itemState(it) {
  if (!it.include) return ["", "Skipped"];
  if (it.status === "error") return ["", "Couldn't trace"];
  if (it.status !== "done") return ["run", "Tracing…"];
  return it.flag ? ["run", "Needs a look"] : ["done", "Ready"];
}

export function reviewScreen() {
  stepper.hidden = true;
  const b = S.batch;
  const its = b.items;
  const look = its.filter((it) => it.include && it.flag).length;
  const skipped = its.filter((it) => !it.include).length;
  const ready = its.filter((it) => it.include && !it.flag && it.status === "done").length;
  const shown = its.map((it, i) => [it, i]).filter(([it]) => b.filter !== "look" || (it.include && it.flag));
  stage.className = "stage list";
  stage.innerHTML = `<div class="acclist">
      <div class="acchead"><b>${plural(its.length, "image")}</b>
        <span class="acctools"><button class="link" data-act="accAll:1">Expand all</button> · <button class="link" data-act="accAll:0">Collapse all</button></span></div>
      ${shown.map(([it, i]) => {
        const st = itemState(it);
        const done = it.status === "done";
        return `<details class="acc${it.flag && it.include ? " flag" : ""}${it.include ? "" : " skip"}" data-i="${i}" ${it.open ? "open" : ""}>
          <summary>
            <span class="th checker"><img src="${it.traceURL ?? it.thumb}" alt=""></span>
            <span class="nm"><b>${esc(it.name)}</b><small>${itemWhat(it)}</small></span>
            <span class="state ${st[0]}">${st[1]}</span>
            <span class="chev" aria-hidden="true">›</span>
          </summary>
          <div class="accbody">
            ${it.flag && it.include ? `<div class="why">${icon.spark}<span>${it.flag.text} <button class="link" data-act="itemFix:${i}">${it.flag.fix}</button> · <button class="link" data-act="itemFine:${i}">It's fine</button></span></div>` : ""}
            <div class="pair">
              <figure><span class="pv"><img src="${it.thumb}" alt=""></span><figcaption>Original</figcaption></figure>
              <figure><span class="pv checker"><img src="${it.fullURL ?? it.thumb}" alt=""></span><figcaption>SVG${done && it.settings.trim && trims(it, it.trimBounds) ? ` · trims to ${savedCanvas(it).w} × ${savedCanvas(it).h}` : ""}</figcaption></figure>
            </div>
            <div class="quick">
              <button class="btn" data-act="itemBg:${i}" ${done ? "" : "disabled"}>${it.settings?.removeBg ? "Keep background" : "Remove background"}</button>
              <button class="btn" data-act="itemTrim:${i}" ${done ? "" : "disabled"}>${it.settings?.trim ? "Undo trim" : "Trim"}</button>
              <button class="btn" data-act="itemSkip:${i}">${it.include ? "Skip this one" : "Include it"}</button>
              <span class="spacer"></span>
              <button class="btn primary" data-act="itemEdit:${i}" ${done ? "" : "disabled"}>Edit this image →</button>
            </div>
          </div>
        </details>`;
      }).join("") || `<p class="sub" style="margin:8px 0">Nothing needs a look. <button class="link" data-act="batchFilter:all">Show all</button></p>`}
    </div>`;
  panel.innerHTML = `<h2>Review the batch</h2>
    <p class="sub">Check each image before saving. Open any row to compare it with its original or fix it.</p>
    <div class="facts" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      <div class="fact"><b>${ready}</b><small>ready</small></div>
      <div class="fact"><b>${look}</b><small>need a look</small></div>
      <div class="fact"><b>${skipped}</b><small>skipped</small></div>
    </div>
    <div class="seg" role="group" aria-label="Show">
      <button class="${b.filter !== "look" ? "on" : ""}" data-act="batchFilter:all">All ${its.length}</button>
      <button class="${b.filter === "look" ? "on" : ""}" data-act="batchFilter:look">Needs a look ${look}</button>
    </div>
    ${look ? `<div class="why">${icon.spark}<span>PixPath opened the ${plural(look, "image")} worth checking. Everything else looked right.</span></div>` : `<div class="why">${icon.check}<span>All checked. Ready to save.</span></div>`}
    <div class="tip">${icon.bulb}<span>Files are named after the originals (logo.png → logo.svg) and never overwrite anything in the folder you pick.</span></div>`;
  const n = files().length;
  foot.innerHTML = `<button class="btn" data-act="batchBack">← Back</button><div class="spacer"></div>
    <button class="btn primary" data-act="saveAll" ${n ? "" : "disabled"}>Save ${n} to a folder…</button>`;
}

// Accordion rows remember whether they're open across re-renders.
document.addEventListener("toggle", (e) => {
  const d = e.target.closest?.("details.acc");
  if (d && S.batch) S.batch.items[+d.dataset.i].open = d.open;
}, true);

/// SVGs to save: included, traced images, with names unique in the batch
/// (logo.png and logo.jpg would both be logo.svg).
export function files() {
  if (!S.batch) return [];
  const used = new Set();
  return S.batch.items
    .filter((it) => it.include && it.status === "done")
    .map((it) => {
      const stem = svgName(it.name).slice(0, -4);
      let name = `${stem}.svg`;
      for (let k = 2; used.has(name.toLowerCase()); k++) name = `${stem} (${k}).svg`;
      used.add(name.toLowerCase());
      return { name, contents: savedSvg(it) };
    });
}

// ---- the batch bar -------------------------------------------------------------------------------

const EDIT_SCREENS = ["mode", "auto", "guided", "advanced", "review"];

/// While working on batch images, a bar under the menu says so on every
/// screen: which image (or all of them), progress, and the way back.
export function drawBar() {
  const bar = $("batchbar");
  const ctx = S.batchCtx;
  const show = !!(ctx && S.batch && EDIT_SCREENS.includes(S.screen));
  bar.hidden = !show;
  if (!show) return;
  const its = S.batch.items;
  const all = ctx.mode === "same";
  const it = its[ctx.index];
  const title = all ? `Settings for all <b>${plural(its.length, "image")}</b> · shown on ${esc(it.name)}` : `Editing image <b>${ctx.index + 1} of ${its.length}</b> · ${esc(it.name)}`;
  bar.innerHTML = `
    <span class="bb-tag">Batch</span>
    <span class="bb-title">${title}</span>
    <span class="bb-thumbs" aria-label="Images in this batch">${its.map((x, i) => {
      const cls = all || i === ctx.index ? "cur" : x.done ? "done" : "";
      return `<span class="bb-th ${cls}" title="${esc(x.name)}"><img src="${x.traceURL ?? x.thumb}" alt="">${x.done && !all && i !== ctx.index ? "<i>✓</i>" : ""}</span>`;
    }).join("")}</span>
    <span class="spacer"></span>
    ${ctx.mode === "each" ? `<button class="link" data-act="batchRestAuto">Use automatic for the rest</button>` : ""}
    <button class="btn" data-act="batchCancel">Back to batch</button>`;
}

// ---- actions -----------------------------------------------------------------------------------
//
// `hooks.edit(item, where)` (set by main.js) opens a batch image in the main
// view; `hooks.current()` returns the open image's state to write back.

export const hooks = { edit: () => {}, current: () => null };

/// Write the open image's state back into batch image `it`.
function saveInto(it) {
  const cur = hooks.current();
  Object.assign(it, {
    settings: { ...cur.settings },
    removals: cur.removals,
    recolor: { ...cur.recolor },
    edited: true,
    done: true,
    flag: null,
    open: false,
  });
  if (cur.result) {
    it.result = cur.result;
    it.trimBounds = cur.settings.trim ? cur.trimBounds : null;
    refreshThumbs(it);
  } else retrace(it);
}

function endEdit(where = "breview") {
  S.batchCtx = null;
  S.screen = where;
  render();
}

export const actions = {
  batchGo() {
    const b = S.batch;
    prefs.set("batchRoute", b.route);
    if (b.route === "auto") {
      b.filter = "all";
      S.screen = "breview";
      render();
    } else if (b.route === "same") {
      S.batchCtx = { mode: "same", index: 0 };
      hooks.edit(b.items[0], "guided");
    } else {
      S.batchCtx = { mode: "each", index: 0 };
      hooks.edit(b.items[0], "mode");
    }
  },
  batchNext() {
    const ctx = S.batchCtx;
    saveInto(S.batch.items[ctx.index]);
    const next = ctx.index + 1;
    if (next >= S.batch.items.length) {
      toast("All done. Review the batch before saving");
      endEdit();
      return;
    }
    S.batchCtx = { mode: "each", index: next };
    hooks.edit(S.batch.items[next], "mode");
  },
  batchRestAuto() {
    saveInto(S.batch.items[S.batchCtx.index]);
    toast("The rest keep their automatic settings");
    endEdit();
  },
  batchApplyAll() {
    const cur = hooks.current();
    S.batch.items.forEach((it, i) => {
      // Settings and colour edits are shared. A colour count only means
      // something for the image it was picked on; the others keep all their
      // colours. Removals belong to each image: its own strays are found again.
      const settings = { ...cur.settings, maxColors: i === 0 ? cur.settings.maxColors : 0 };
      const removals = i === 0 ? cur.removals : [];
      Object.assign(it, { settings, recolor: { ...cur.recolor }, removals, findStrays: i !== 0, edited: true, flag: null, open: false, status: "waiting" });
    });
    toast(`Applied your settings to all ${plural(S.batch.items.length, "image")}`);
    endEdit();
    pump();
  },
  batchDone() {
    const it = S.batch.items[S.batchCtx.index];
    saveInto(it);
    toast(`Saved your changes to ${it.name}`);
    endEdit();
  },
  batchCancel() {
    toast("No changes saved");
    endEdit(S.batchCtx?.mode === "edit" ? "breview" : "batch");
  },
  batchBack() {
    if (S.batchCtx) return actions.batchCancel();
    S.screen = S.screen === "breview" ? "batch" : "start";
    render();
  },
};

/// Actions with an argument: "name:arg".
export function run(name, arg) {
  const b = S.batch;
  const it = b?.items[+arg];
  switch (name) {
    case "batchRoute":
      b.route = arg;
      render();
      return true;
    case "batchFilter":
      b.filter = arg;
      render();
      return true;
    case "accAll":
      b.items.forEach((x) => (x.open = arg === "1"));
      render();
      return true;
    case "itemFix":
      it.flag.apply(it);
      it.flag = null;
      retrace(it);
      render();
      return true;
    case "itemFine":
      it.flag = null;
      render();
      return true;
    case "itemBg":
      it.settings.removeBg = !it.settings.removeBg;
      if (it.settings.removeBg) it.settings.trim = true;
      retrace(it);
      render();
      return true;
    case "itemTrim":
      it.settings.trim = !it.settings.trim;
      it.trimBounds = it.settings.trim ? it.result?.bounds ?? null : null;
      if (it.settings.trim && !trims(it)) toast(`${it.name}: nothing to trim`);
      refreshThumbs(it);
      render();
      return true;
    case "itemSkip":
      it.include = !it.include;
      if (!it.include) it.open = false;
      render();
      return true;
    case "itemEdit":
      S.batchCtx = { mode: "edit", index: +arg };
      hooks.edit(it, "mode");
      return true;
    case "batchRemove": {
      const [gone] = b.items.splice(+arg, 1);
      forget(gone);
      if (gone.status === "tracing") {
        // Restart the worker so the abandoned trace doesn't hold up the rest.
        engine.cancelBatch();
        b.running = false;
      }
      if (!b.items.length) {
        close();
        S.screen = "start";
      }
      render();
      pump();
      return true;
    }
  }
  return false;
}
