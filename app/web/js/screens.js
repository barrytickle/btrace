// The screens. Each one fills the stage (picture), the panel (decisions) and
// the footer (Back / Next). Buttons carry data-act, handled in main.js.

import { $, esc, formatBytes, icon, plural, prefs } from "./util.js";
import { S, TYPES, withType, savedCanvas, savedSvg, trimIsStale, trimWouldChange, trimCanvas, removalCount, straysOf } from "./state.js";
import * as wizard from "./guided.js";
import * as batchUI from "./batch.js";
import * as viewer from "./viewer.js";
import * as recent from "./recent.js";

const stage = $("stage"), panel = $("panel"), foot = $("foot"), stepper = $("stepper");

/// Set by main.js: re-trace after a setting changed in a panel; redraw the
/// picture after a palette edit.
export const hooks = { settingsChanged: () => {}, recolored: () => {} };

export const { openStep, nextStep, prevStep, lastStep } = wizard;

export const MODES = {
  auto: "Fully automatic",
  guided: "Guided",
  advanced: "Advanced",
};

function backButton(act = "start") {
  return `<button class="btn" data-act="${act}">← Back</button>`;
}

function boundsButton(label = "bounds") {
  return `<button class="btn ghost" data-act="bounds">${S.view.bounds ? "Hide" : "Show"} ${label}</button>`;
}

// ---- Start ----------------------------------------------------------------------

let clipboardNote = "Copy an image, then click here or press <kbd>Ctrl+V</kbd>";

function start() {
  stage.className = "stage start";
  stage.innerHTML = `<div class="dropzone" id="dz">
      <div>
        <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M14 10l26 22-12 2 7 15-6 3-7-15-8 8z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/><rect x="38" y="38" width="20" height="20" rx="3" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="4 3"/></svg>
        <div class="big">Drag and drop your images here</div>
        <div class="small">One image opens it. Several start a batch automatically.</div>
        <div class="demo"><button class="btn primary" data-act="open">Browse…</button></div>
      </div>
    </div>`;
  panel.innerHTML = `<h2>Start</h2>
    <button class="action" data-act="open"><span class="ic"><svg viewBox="0 0 40 40"><path d="M5 12h11l3 4h16v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/></svg></span>
      <span><strong>Browse for an image</strong><span>PNG, JPEG, WebP or GIF · <kbd>Ctrl+O</kbd></span></span></button>
    <button class="action" data-act="paste"><span class="ic"><svg viewBox="0 0 40 40"><rect x="9" y="7" width="22" height="28" rx="3" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="2"/><rect x="14" y="4" width="12" height="6" rx="2" fill="var(--panel)" stroke="var(--accent)" stroke-width="2"/></svg></span>
      <span><strong>Paste from clipboard</strong><span id="clipNote">${clipboardNote}</span></span></button>
    <button class="action" data-act="folder"><span class="ic"><svg viewBox="0 0 40 40"><rect x="11" y="6" width="18" height="14" rx="2" fill="var(--panel)" stroke="var(--accent)" stroke-width="1.8"/><rect x="7" y="10" width="18" height="14" rx="2" fill="var(--panel)" stroke="var(--accent)" stroke-width="1.8"/><path d="M4 20h10l2 3h18v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/></svg></span>
      <span><strong>Batch a folder</strong><span>Pick a folder; every image in it is traced together</span></span></button>
    <div id="recentBox" hidden><div class="eyebrow" style="margin-bottom:6px">Recent images</div><div class="recent" id="recentList"></div></div>`;
  foot.innerHTML = `<span class="note">Tip: you can paste a screenshot straight in with Ctrl+V.</span><div class="spacer"></div><button class="btn ghost" data-act="dlg:update">Check for updates</button>`;
  showRecent();
  peekClipboard();
}

let recentThumbs = [];

async function showRecent() {
  const items = await recent.list();
  if (S.screen !== "start" || !$("recentList")) return;
  recentThumbs.forEach(URL.revokeObjectURL);
  recentThumbs = items.map((r) => URL.createObjectURL(r.blob));
  $("recentList").innerHTML = items
    .map((r, i) => `<button data-act="recent:${i}" title="${esc(r.name)}"><img class="th" src="${recentThumbs[i]}" alt=""><span>${esc(r.name)}</span><em>${recent.when(r.at)}</em></button>`)
    .join("");
  $("recentBox").hidden = !items.length;
  showRecent.items = items;
}

export function recentItem(i) {
  return showRecent.items?.[i];
}

/// If the clipboard may already be read without asking, say what's on it.
export async function peekClipboard() {
  try {
    const p = await navigator.permissions.query({ name: "clipboard-read" });
    if (p.state !== "granted") return;
    const items = await navigator.clipboard.read();
    const item = items.find((it) => it.types.some((t) => t.startsWith("image/")));
    let note = "Copy an image, then click here or press <kbd>Ctrl+V</kbd>";
    if (item) {
      const blob = await item.getType(item.types.find((t) => t.startsWith("image/")));
      const bmp = await createImageBitmap(blob);
      note = `An image is on your clipboard (${bmp.width} × ${bmp.height}) · <kbd>Ctrl+V</kbd>`;
      bmp.close();
    }
    clipboardNote = note;
    if ($("clipNote")) $("clipNote").innerHTML = note;
  } catch {
    // Not allowed to look without asking: keep the general hint.
  }
}

// ---- How would you like to trace it? ----------------------------------------------

function findings() {
  const im = S.image;
  const an = S.analysis;
  const chips = [];
  const chip = (html) => chips.push(`<span class="chip">${html}</span>`);
  if (an) {
    const glow = an.softShare >= 0.02;
    chip({
      logo: "<b>Logo</b> with crisp edges",
      illustration: glow ? "<b>Illustration</b> with soft glows" : "<b>Illustration</b>",
      detailed: "<b>Photo</b> or detailed art",
      bw: "<b>Black &amp; white</b> drawing",
    }[an.kind]);
    if (an.kind !== "detailed") {
      const bg = an.removeBackground ? an.background?.color : null;
      const n = an.palette.filter((p) => p.color !== bg).length;
      chip(`<b>${n}</b> colour${n === 1 ? "" : "s"}`);
    }
    if (an.transparentShare > 0.01) chip("Already transparent");
    else if (an.background) chip(`${wizard.colourName(an.background.color).replace(/^./, (c) => c.toUpperCase())} background${an.removeBackground ? "" : " (part of the picture?)"}`);
  }
  const m = S.first && viewer.margins(S.first.bounds);
  // Only worth a mention when trimming would make a visible difference.
  const big = m && Math.max(m.top, m.right, m.bottom, m.left) >= Math.max(4, 0.03 * Math.min(im.width, im.height));
  if (big) {
    const sides = m.left === m.right && m.top === m.bottom ? `${m.left} / ${m.top} px` : `${Math.max(m.top, m.right, m.bottom, m.left)} px`;
    chip(`<b>${sides}</b> empty space`);
  }
  const sc = im.scale ?? 1;
  if (sc > 1) chip(`Large image (${im.original[0]} × ${im.original[1]}), traced at ${im.width} × ${im.height}`);
  else if (Math.max(im.width, im.height) < 400) chip(`Small image (${im.width} × ${im.height}), traced at higher detail`);
  else chip(`${im.width} × ${im.height} px`);
  return chips.join("");
}

function mode() {
  stepper.hidden = true;
  viewer.mount(stage, { trace: false });
  viewer.setBusy(S.analysing);
  const last = prefs.get("mode");
  const card = (k, text, rec) => `<button class="mode${last === k ? " picked" : ""}" data-act="mode:${k}" ${S.analysing ? "disabled" : ""}><strong>${MODES[k]}</strong>${rec ? `<span class="rec">Recommended</span>` : last === k ? `<span class="last">Last used</span>` : "<span></span>"}
      <p>${text}</p></button>`;
  panel.innerHTML = `<h2>How would you like to trace it?</h2>
    <div>
      <div class="eyebrow" style="margin-bottom:8px">What PixPath noticed</div>
      <div class="findings">${S.analysing ? `<span class="chip">Looking…</span>` : findings()}</div>
    </div>
    ${card("auto", "PixPath picks the settings and shows you the result. You can still change anything.", true)}
    ${card("guided", "A few quick questions, each with PixPath's recommendation already picked and a live preview.")}
    ${card("advanced", "Every setting, each explained. For when you know exactly what you want.")}`;
  foot.innerHTML = `${S.batchCtx ? `<button class="btn" data-act="batchBack">← Back to batch</button>` : backButton()}<div class="spacer"></div><span class="note">PixPath remembers your choice for next time.</span>`;
}

// ---- Fully automatic: what PixPath did -------------------------------------------------

/// Each decision Automatic made, with whether it can be undone.
function autoRows() {
  const an = S.analysis ?? {};
  const f = S.first;
  const rows = [];
  const kindWhy = {
    logo: "Flat colours with crisp edges",
    illustration: an.softShare >= 0.02 ? "Flat colours with soft glows" : "Lots of flat colours",
    detailed: "Shading and gradients, like a photo",
    bw: "Dark ink on a light page",
  }[an.kind ?? "logo"];
  const kindLabel = { logo: "a logo", illustration: "an illustration", detailed: "a photo or detailed art", bw: "a black & white drawing" }[an.kind ?? "logo"];
  rows.push({ k: "type", label: `Traced as ${kindLabel}`, why: kindWhy, fixed: true, change: 1 });
  if (an.removeBackground && an.background) {
    rows.push({ k: "bg", label: `Removed the ${wizard.colourName(an.background.color)} background`, why: "It ran all the way round the border" });
  }
  if (f?.bounds && trimWouldChange(f.bounds)) rows.push({ k: "trim", label: "Trimmed the empty space", why: viewer.spaceText(f.bounds) });
  if (TYPES[S.settings.type].engine === "snap") {
    const L = wizard.ladder();
    rows.push({ k: "colours", label: `Kept ${L.current} colour${L.current === 1 ? "" : "s"}`, why: an.nearDuplicates?.length ? "Two look almost alike: change it if they should be one" : "Each is clearly distinct", swatches: L.visible.slice(0, L.current).map((p) => S.recolor[p.color] ?? p.color), fixed: true, change: 3 });
  }
  if (TYPES[S.settings.type].engine === "color") {
    const c = wizard.photoChoices();
    rows.push({ k: "detail", label: `${c.detail} detail`, why: "Keeps what you can see, without thousands of specks", fixed: true, change: 2 });
    rows.push({ k: "pcolours", label: `Used ${c.colours.toLowerCase()}`, why: "Close to the photo, with a palette you can edit", fixed: true, change: 3 });
  }
  if (TYPES[an.kind ?? "logo"].lines) rows.push({ k: "lines", label: "Straightened lines & sharpened corners", why: "Straight edges come out perfectly straight" });
  if (S.settings.type === "illustration" && an.softShare >= 0.02) rows.push({ k: "glow", label: "Kept the soft glows soft", why: "Instead of cutting them out with a hard edge" });
  const strays = straysOf(f).length;
  if (strays) rows.push({ k: "strays", label: `Removed ${strays} tiny stray shape${strays === 1 ? "" : "s"}`, why: "Specks on their own, not part of the design" });
  return rows;
}

function auto() {
  stepper.hidden = true;
  viewer.mount(stage, { tools: true, hint: "Drag the divider to compare" });
  panel.innerHTML = `<h2>Done. Here's what PixPath did</h2>
    <p class="sub">Undo anything that isn't right; the picture updates straight away.</p>
    <div class="did">${autoRows().map((r) => {
      const off = S.autoUndo[r.k];
      return `<div class="row${off ? " off" : ""}">
        <span class="ok">${off ? "–" : "✓"}</span>
        <span><b>${esc(r.label)}</b><small>${esc(r.why)}</small>${r.swatches ? `<span class="swatches" style="margin-top:6px">${r.swatches.map((c) => `<i style="background:${c};width:20px;height:20px;border-radius:5px"></i>`).join("")}</span>` : ""}</span>
        ${r.fixed ? `<button class="btn ghost" data-act="step:${r.change}">Change</button>` : `<button class="btn ghost" data-act="autoUndo:${r.k}">${off ? "Redo" : "Undo"}</button>`}
      </div>`;
    }).join("")}</div>
    <div class="tip">${icon.bulb}<span>Want a say in each step? <button class="link" data-act="mode:guided">Walk through it guided</button> or <button class="link" data-act="advanced">open Advanced</button>.</span></div>`;
  foot.innerHTML = `${backButton("mode")}${boundsButton()}<div class="spacer"></div>${finishButtons()}`;
}

/// The buttons that end an image's settings screens. In a batch they move
/// through the batch (Review stays one click away); otherwise, on to Review.
export function finishButtons() {
  const ctx = S.batchCtx;
  const review = (label) => `<button class="btn" data-act="review">${label}</button>`;
  if (!ctx) return `<button class="btn primary" data-act="review">Review →</button>`;
  const n = S.batch.items.length;
  if (ctx.mode === "each") {
    const last = ctx.index + 1 >= n;
    return `${review("Review this image")}<button class="btn primary" data-act="batchNext">${last ? "Finish · review the batch →" : `Next image (${ctx.index + 2} of ${n}) →`}</button>`;
  }
  if (ctx.mode === "same") return `${review("Review first")}<button class="btn primary" data-act="batchApplyAll">Apply to all ${n} →</button>`;
  return `${review("Review this image")}<button class="btn primary" data-act="batchDone">Done · back to batch review →</button>`;
}

// ---- Advanced ------------------------------------------------------------------------

const SLIDERS = {
  maxColors: { label: "Number of colours", min: 0, max: 16, step: 1, fmt: (v) => (+v === 0 ? `All found${S.result ? ` (${S.result.colors.length})` : ""}` : v), help: "How many colours the SVG may use. Lower merges similar ones." },
  smooth: { label: "Soft-edge smoothing", min: 0, max: 3, step: 0.1, fmt: (v) => (+v === 0 ? "Off" : (+v).toFixed(1)), help: "Tidies blurry or glowing edges so they don't come out jagged. Crisp edges are never touched." },
  precision: { label: "Colour precision", min: 1, max: 8, step: 1, fmt: (v) => v, help: "Higher keeps subtler colour differences apart. Lower merges near-identical colours." },
  gradient: { label: "Gradient step", min: 1, max: 64, step: 1, fmt: (v) => v, help: "How finely shading is split into bands. Smaller steps look smoother but make many more shapes." },
  threshold: { label: "Ink threshold", min: 1, max: 254, step: 1, fmt: (v) => v, help: "How dark a pixel must be to count as ink. Higher catches fainter lines." },
  simplify: { label: "Simplify", min: 0, max: 1.5, step: 0.05, fmt: (v) => (+v === 0 ? "Off" : `${(+v).toFixed(2)} px`), help: "How far curves may drift from the image to use fewer points. Higher means smoother and smaller." },
  speckle: { label: "Speckle filter", min: 0, max: 32, step: 1, fmt: (v) => `${v} px`, help: "Removes dots and specks smaller than this. Raise it if the trace is full of tiny bits." },
  pad: { label: "Space around the drawing", min: 0, max: 64, step: 1, fmt: (v) => `${v} px`, help: "Padding kept when trimming." },
};

const TOGGLES = {
  glow: ["Soft edges & glows", "Where the picture fades softly (a moon, a light), the SVG gets a matching soft halo instead of a hard edge."],
  adaptive: ["Adaptive (uneven lighting)", "For photos of paper or scans with shadows: judges ink against its surroundings."],
  removeBg: ["Remove background", "The colour around the image's border."],
  trim: ["Trim empty space", "Fit the SVG to the drawing."],
  lines: ["Straight lines & sharp corners", "Off for hand-drawn, organic shapes."],
  evenLighting: ["Even out the lighting", "Lifts shadows and uneven light before tracing, so they don't become shapes of their own."],
  noOverlap: ["Shapes don't overlap", "For cutting machines (vinyl, laser): each colour becomes its own piece. Glows need this off."],
};

function slider(k, cls = "", over = {}) {
  const d = { ...SLIDERS[k], ...over };
  const v = S.settings[k];
  return `<section class="${cls}"><label class="r" for="a-${k}">${d.label} <output id="o-${k}">${d.fmt(v)}</output></label>
    <input id="a-${k}" type="range" min="${d.min}" max="${d.max}" step="${d.step}" value="${v}" data-setting="${k}">
    <p>${d.help}</p></section>`;
}

function toggle(k) {
  const [title, text] = TOGGLES[k];
  const on = S.settings[k];
  return `<button class="toggle${on ? " on" : ""}" data-toggle="${k}" aria-pressed="${on}"><span class="t"><strong>${title}</strong><span>${text}</span></span><span class="sw"></span></button>`;
}

function advanced() {
  stepper.hidden = true;
  viewer.mount(stage, { tools: true, hint: "Changes show straight away" });
  const s = S.settings;
  const engine = TYPES[s.type].engine;
  panel.innerHTML = `<h2>Advanced</h2>
    <p class="sub">Every setting, each explained. Changes show on the picture straight away.</p>
    <div class="adv">
      <section><span class="r" style="font-size:14px;font-weight:500">Image type</span>
        <div class="seg" role="group" aria-label="Image type">${Object.entries({ logo: "Logo", illustration: "Illustration", detailed: "Photo", bw: "B&W" })
          .map(([k, l]) => `<button class="${s.type === k ? "on" : ""}" data-type="${k}" aria-pressed="${s.type === k}" title="${TYPES[k].label}">${l}</button>`).join("")}</div>
        <p>${{ snap: "Flat colours: finds the real colours in the image and ignores blur and compression noise.", color: "Keeps shading and gradients as many small shapes.", bw: "Everything becomes black ink or transparent." }[engine]}</p></section>
      ${engine === "snap" ? `${slider("maxColors")}<div class="swatches" id="advSwatches"></div>${slider("smooth")}${toggle("glow")}` : ""}
      ${engine === "color" ? slider("maxColors", "", { max: 64 }) + slider("precision") + slider("gradient") + toggle("evenLighting") : ""}
      ${engine === "bw" ? slider("threshold") + toggle("adaptive") : ""}
      ${slider("simplify")}
      ${slider("speckle")}
      ${toggle("removeBg")}
      ${toggle("trim")}
      ${s.trim ? slider("pad", "sub-of") : ""}
      ${toggle("lines")}
      ${toggle("noOverlap")}
    </div>`;
  foot.innerHTML = `${backButton("mode")}${boundsButton()}<div class="spacer"></div>${finishButtons()}`;
  advancedTraced();
}

function advancedTraced() {
  const sw = $("advSwatches");
  if (sw && S.result) {
    sw.innerHTML = S.result.colors.slice(0, 24).map((c) => `<i style="background:${c};width:22px;height:22px;border-radius:5px" title="${c}"></i>`).join("");
  }
  const o = $("o-maxColors");
  if (o) o.textContent = SLIDERS.maxColors.fmt(S.settings.maxColors);
}

panel.addEventListener("input", (e) => {
  const k = e.target.dataset?.setting;
  if (!k) return;
  S.settings[k] = +e.target.value;
  $(`o-${k}`).textContent = SLIDERS[k].fmt(e.target.value);
  hooks.settingsChanged();
});

panel.addEventListener("click", (e) => {
  const t = e.target.closest("[data-toggle]");
  if (t) {
    const k = t.dataset.toggle;
    S.settings[k] = !S.settings[k];
    if (k === "trim" && !S.settings.trim) S.trimBounds = null;
    if (k === "trim") render(); // shows or hides the padding slider
    else {
      t.classList.toggle("on", S.settings[k]);
      t.setAttribute("aria-pressed", S.settings[k]);
    }
    hooks.settingsChanged();
    return;
  }
  const ty = e.target.closest("[data-type]");
  if (ty) {
    S.settings = withType(S.settings, ty.dataset.type);
    render();
    hooks.settingsChanged();
  }
});

// ---- Review -------------------------------------------------------------------------

/// Review's choices for a photo: its own four questions.
function photoRows(row) {
  const c = wizard.photoChoices();
  return [row(`${c.detail} detail`, "Detail", 2), row(c.colours, "Colours", 3), row(c.light, "Shadows & lighting", 4), row(c.smooth, "Smoothness", 5)].join("");
}

function trimRow() {
  const s = S.settings;
  // A trim that leaves the whole canvas isn't one.
  const trimmed = s.trim && S.trimBounds && trimWouldChange(S.trimBounds);
  const stale = trimmed && trimIsStale();
  const c = savedCanvas();
  const b = S.result.bounds;
  const fresh = b && trimWouldChange(b) ? trimCanvas(b) : null;
  let title, text;
  if (stale) {
    title = "The drawing changed since you trimmed";
    text = fresh ? `Trim again to fit what's left (${fresh.w} × ${fresh.h} px).` : "Trim again: the drawing now fills the canvas.";
  } else if (trimmed) {
    title = `Trimmed to ${c.w} × ${c.h} px`;
    text = "The dashed frame is the SVG's edge.";
  } else {
    title = "Not trimmed";
    text = fresh ? `Trim fits the SVG to the drawing (${fresh.w} × ${fresh.h} px).` : "Trim fits the SVG to the drawing.";
  }
  return `<div class="trimrow${stale ? " stale" : ""}">
      <span class="t"><strong>${title}</strong><span>${text}</span></span>
      <span class="acts">${trimmed ? `<button class="btn ghost" data-act="untrim">Undo trim</button>` : ""}
        <button class="btn${trimmed && !stale ? "" : " primary"}" data-act="trim">${stale ? "Trim again" : "Trim"}</button></span>
    </div>`;
}

function review() {
  if (S.from === "guided") wizard.drawStepper(wizard.reviewStep());
  else stepper.hidden = true;
  viewer.mount(stage, { tools: true, removable: true, hint: "Choose Remove on the toolbar to click away anything that shouldn't be there" });
  const r = S.result;
  const s = S.settings;
  if (!r) {
    panel.innerHTML = `<h2>Review</h2><p class="sub">Tracing…</p>`;
    foot.innerHTML = backButton("reviewBack");
    return;
  }
  const c = savedCanvas();
  const kb = formatBytes(new Blob([savedSvg()]).size);
  const removed = removalCount();
  const byHand = S.removals.some((r) => r.kind === "click");
  const strays = straysOf(r).length;
  const an = S.analysis;
  const row = (title, what, step) => `<div class="row"><span class="ok">✓</span><span><b>${title}</b><small>${what}</small></span><button class="btn ghost" data-act="step:${step}">Change</button></div>`;
  const engine = TYPES[s.type].engine;
  const bgName = an?.background ? wizard.colourName(an.background.color) : "";
  panel.innerHTML = `<h2>Review</h2>
    <p class="sub">Check the result before saving. Drag the divider to compare with your original.</p>
    <div class="facts">
      <div class="fact"><b>${c.w} × ${c.h}</b><small>px canvas</small></div>
      <div class="fact"><b>${r.colors.length}</b><small>colours</small></div>
      <div class="fact"><b>${r.shapes.toLocaleString()}</b><small>shapes</small></div>
      <div class="fact"><b>${kb.replace(/ \w+$/, "")}</b><small>${kb.split(" ")[1]} file</small></div>
    </div>
    <div class="eyebrow">Clean up</div>
    ${strays ? `<div class="why">${icon.spark}<span>Found <b>${strays} tiny stray shape${strays === 1 ? "" : "s"}</b>, specks on their own that aren't part of the design. <button class="link" data-act="removeStrays">Remove ${strays === 1 ? "it" : "them"}</button></span></div>` : ""}
    ${!s.removeBg && an?.background && !byHand ? `<div class="why">${icon.spark}<span>The <b>${bgName}</b> around the edge can go: <button class="link" data-act="removeBg">remove it</button>, or click it with <b>Remove</b> on the toolbar.</span></div>` : ""}
    ${trimRow()}
    <div class="tip">${icon.bulb}<span>To remove anything, choose <b>Remove</b> on the picture's toolbar and click it, background included. Shift-click removes every shape of that colour.</span></div>
    ${removed ? `<div class="tally">${removed} removed <button class="btn" data-act="undoRemove">Undo</button><button class="btn" data-act="clearRemove">Clear</button></div>` : ""}
    <div class="eyebrow">Your choices</div>
    <div class="did">
      ${row(TYPES[s.type].label, "Image type", 1)}
      ${engine === "color" ? photoRows(row) : `
      ${row(s.removeBg ? "Background removed" : byHand ? "Parts removed by hand" : "Background kept", "Background", 2)}
      ${engine === "snap" ? row(`${wizard.ladder().current} colour${wizard.ladder().current === 1 ? "" : "s"}${Object.keys(S.recolor).length ? ", recoloured" : ""}`, "Colours", 3) : ""}
      ${row(s.lines ? "Straight lines & sharp corners" : "Curves left as traced", s.glow && engine === "snap" ? "Details · glows kept soft" : "Details", 4)}`}
    </div>
    <div class="tip">${icon.bulb}<span>Made with ${MODES[S.from] ?? "Advanced"}. <b>Change</b> opens that question, then comes back here. Need every setting? <button class="link" data-act="advanced">Open Advanced</button>.</span></div>`;
  const ctx = S.batchCtx;
  const finish = !ctx
    ? `<button class="btn" data-act="copy">Copy SVG</button><button class="btn primary" data-act="save">Save SVG</button>`
    : ctx.mode === "each"
      ? `<button class="btn primary" data-act="batchNext">${ctx.index + 1 >= S.batch.items.length ? "Finish · review the batch →" : `Next image (${ctx.index + 2} of ${S.batch.items.length}) →`}</button>`
      : ctx.mode === "same"
        ? `<button class="btn primary" data-act="batchApplyAll">Apply to all ${S.batch.items.length} →</button>`
        : `<button class="btn primary" data-act="batchDone">Done · back to batch review →</button>`;
  foot.innerHTML = `${backButton("reviewBack")}${boundsButton("empty space")}<div class="spacer"></div>${finish}`;
}

// ---- routing ---------------------------------------------------------------------------

const screens = { start, mode, auto, guided: wizard.guided, advanced, review, batch: batchUI.batchScreen, breview: batchUI.reviewScreen };

export function render() {
  screens[S.screen]();
  batchUI.drawBar();
}

/// A new trace arrived: refresh whatever on screen depends on it.
export function traced() {
  if (S.screen === "mode") mode();
  else if (S.screen === "review") review();
  else if (S.screen === "advanced") advancedTraced();
  else if (S.screen === "guided") wizard.traced();
  else if (S.screen === "auto") auto();
}
