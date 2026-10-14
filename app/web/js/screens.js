// The screens. Each one fills the stage (picture), the panel (decisions) and
// the footer (Back / Next). Buttons carry data-act, handled in main.js.

import { $, esc, formatBytes, icon, plural, prefs } from "./util.js";
import { S, TYPES, withType } from "./state.js";
import * as viewer from "./viewer.js";
import * as recent from "./recent.js";

const stage = $("stage"), panel = $("panel"), foot = $("foot"), stepper = $("stepper");

/// Set by main.js: re-trace after a setting changed in a panel.
export const hooks = { settingsChanged: () => {} };

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
  const f = S.first;
  const chips = [];
  if (f) chips.push(`<span class="chip"><b>${f.colors.length}</b> colour${f.colors.length === 1 ? "" : "s"}</span>`);
  if (im.transparent) chips.push(`<span class="chip">Already transparent</span>`);
  else if (im.whiteBorder) chips.push(`<span class="chip">White background</span>`);
  const m = f && viewer.margins(f.bounds);
  // Only worth a mention when trimming would make a visible difference.
  const big = m && Math.max(m.top, m.right, m.bottom, m.left) >= Math.max(4, 0.03 * Math.min(im.width, im.height));
  if (big) {
    const sides = m.left === m.right && m.top === m.bottom ? `${m.left} / ${m.top} px` : `${Math.max(m.top, m.right, m.bottom, m.left)} px`;
    chips.push(`<span class="chip"><b>${sides}</b> empty space</span>`);
  }
  if (Math.max(im.width, im.height) < 400) chips.push(`<span class="chip">Small image (${im.width} × ${im.height}), traced at higher detail</span>`);
  else chips.push(`<span class="chip">${im.width} × ${im.height} px</span>`);
  return chips.join("");
}

function mode() {
  stepper.hidden = true;
  viewer.mount(stage, { trace: false });
  viewer.setBusy(S.analysing);
  const last = prefs.get("mode");
  const card = (k, text, rec) => `<button class="mode${last === k ? " picked" : ""}" data-act="mode:${k}"><strong>${MODES[k]}</strong>${rec ? `<span class="rec">Recommended</span>` : last === k ? `<span class="last">Last used</span>` : "<span></span>"}
      <p>${text}</p></button>`;
  panel.innerHTML = `<h2>How would you like to trace it?</h2>
    <div>
      <div class="eyebrow" style="margin-bottom:8px">What PixPath noticed</div>
      <div class="findings">${S.analysing ? `<span class="chip">Looking…</span>` : findings()}</div>
    </div>
    ${card("auto", "PixPath picks the settings and shows you the result. You can still change anything.", true)}
    ${card("guided", "A few quick questions, each with PixPath's recommendation already picked and a live preview.")}
    ${card("advanced", "Every setting, each explained. For when you know exactly what you want.")}`;
  foot.innerHTML = `${backButton()}<div class="spacer"></div><span class="note">PixPath remembers your choice for next time.</span>`;
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
  noOverlap: ["Shapes don't overlap", "For cutting machines (vinyl, laser): each colour becomes its own piece. Glows need this off."],
};

function slider(k, cls = "") {
  const d = SLIDERS[k];
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
      ${engine === "color" ? slider("precision") + slider("gradient") : ""}
      ${engine === "bw" ? slider("threshold") + toggle("adaptive") : ""}
      ${slider("simplify")}
      ${slider("speckle")}
      ${toggle("removeBg")}
      ${toggle("trim")}
      ${s.trim ? slider("pad", "sub-of") : ""}
      ${toggle("lines")}
      ${toggle("noOverlap")}
    </div>`;
  foot.innerHTML = `${backButton("mode")}${boundsButton()}<div class="spacer"></div><button class="btn primary" data-act="review">Review →</button>`;
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

function review() {
  stepper.hidden = true;
  viewer.mount(stage, { tools: true, removable: true, hint: "Choose Remove on the toolbar to click away anything that shouldn't be there" });
  const r = S.result;
  const s = S.settings;
  if (!r) {
    panel.innerHTML = `<h2>Review</h2><p class="sub">Tracing…</p>`;
    foot.innerHTML = backButton("reviewBack");
    return;
  }
  const saved = S.cropped ?? r;
  const c = viewer.savedCanvas();
  const kb = formatBytes(new Blob([saved.svg]).size);
  const removed = S.removals.length;
  const fit = r.bounds ? `${Math.ceil(r.bounds[2] - r.bounds[0] + 2 * s.pad)} × ${Math.ceil(r.bounds[3] - r.bounds[1] + 2 * s.pad)}` : "";
  const noSpace = viewer.spaceText() === "No empty space around the drawing";
  const row = (title, what) => `<div class="row"><span class="ok">✓</span><span><b>${title}</b><small>${what}</small></span><button class="btn ghost" data-act="advanced">Change</button></div>`;
  const engine = TYPES[s.type].engine;
  panel.innerHTML = `<h2>Review</h2>
    <p class="sub">Check the result before saving. Drag the divider to compare with your original.</p>
    <div class="facts">
      <div class="fact"><b>${c.w} × ${c.h}</b><small>px canvas</small></div>
      <div class="fact"><b>${r.colors.length}</b><small>colours</small></div>
      <div class="fact"><b>${r.shapes.toLocaleString()}</b><small>shapes</small></div>
      <div class="fact"><b>${kb.replace(/ \w+$/, "")}</b><small>${kb.split(" ")[1]} file</small></div>
    </div>
    <div class="eyebrow">Clean up</div>
    ${!s.removeBg && !S.image.transparent && !removed ? `<div class="why">${icon.spark}<span>Is the colour around the edge a background? <button class="link" data-act="removeBg">Remove it</button>, or click it with <b>Remove</b> on the toolbar.</span></div>` : ""}
    <div class="trimrow">
      <span class="t"><strong>${s.trim ? `Trimmed to ${c.w} × ${c.h} px` : noSpace ? "No empty space to trim" : "Not trimmed"}</strong>
        <span>${s.trim ? "The dashed frame is the SVG's edge." : noSpace ? "The drawing already fills the canvas." : `Trim fits the SVG to the drawing (${fit} px). ${viewer.spaceText()}.`}</span></span>
      <span class="acts">${s.trim ? `<button class="btn ghost" data-act="untrim">Undo trim</button>` : `<button class="btn primary" data-act="trim" ${noSpace ? "disabled" : ""}>Trim</button>`}</span>
    </div>
    <div class="tip">${icon.bulb}<span>To remove anything, choose <b>Remove</b> on the picture's toolbar and click it, background included. Shift-click removes every shape of that colour.</span></div>
    ${removed ? `<div class="tally">${removed} removed <button class="btn" data-act="undoRemove">Undo</button><button class="btn" data-act="clearRemove">Clear</button></div>` : ""}
    <div class="eyebrow">Your choices</div>
    <div class="did">
      ${row(TYPES[s.type].label, "Image type")}
      ${row(s.removeBg ? "Background removed" : removed ? "Parts removed by hand" : "Background kept", s.trim ? "Background · empty space trimmed" : "Background · not trimmed")}
      ${engine === "snap" ? row(s.maxColors ? `Up to ${plural(s.maxColors, "colour")}` : `All ${plural(r.colors.length, "colour")} found`, "Colours") : ""}
      ${row(s.lines ? "Straight lines & sharp corners" : "Curves left as traced", "Details")}
    </div>
    <div class="tip">${icon.bulb}<span>Made with ${MODES[S.from] ?? "Advanced"}. <b>Change</b> opens Advanced, with everything you chose filled in.</span></div>`;
  foot.innerHTML = `${backButton("reviewBack")}${boundsButton("empty space")}<div class="spacer"></div>
    <button class="btn" data-act="copy">Copy SVG</button><button class="btn primary" data-act="save">Save SVG</button>`;
}

// ---- Batch -----------------------------------------------------------------------------

function batch() {
  stepper.hidden = true;
  const b = S.batch;
  const n = b.items.length;
  const done = b.items.filter((it) => it.status === "done").length;
  const failed = b.items.filter((it) => it.status === "error").length;
  stage.className = "stage list";
  stage.innerHTML = `<div class="batchlist">
      <div style="display:flex;justify-content:space-between;align-items:baseline"><b style="font-family:var(--display);font-size:20px">${plural(n, "image")}</b><span style="color:var(--ink-2);font-size:14px">${done} of ${n} traced${failed ? ` · ${failed} failed` : ""}</span></div>
      <div class="progress"><div style="width:${(100 * (done + failed)) / n}%"></div></div>
      ${b.items.map((it, i) => {
        const st = { done: ["done", "Done"], tracing: ["run", "Tracing…"], error: ["", "Couldn't trace"], waiting: ["", "Waiting"] }[it.status];
        const what = it.status === "done" ? `${plural(it.result.colors.length, "colour")} · ${it.cropped ? `trimmed to ${it.cropped.width} × ${it.cropped.height}` : "not trimmed"}` : it.status === "error" ? esc(it.error) : "Automatic";
        return `<div class="bfile${it.status === "error" ? " err" : ""}"><span class="th checker"><img src="${it.traceURL ?? it.thumb}" alt=""></span>
          <span><b>${esc(it.name)}</b><small>${what}</small></span>
          <span class="state ${st[0]}">${st[1]}</span><button class="btn ghost small" data-act="batchRemove:${i}" title="Leave this image out" aria-label="Leave ${esc(it.name)} out">×</button></div>`;
      }).join("")}
    </div>`;
  panel.innerHTML = `<h2>Batch: ${plural(n, "image")}</h2>
    <p class="sub">${b.fromFolder ? "Every image in the folder" : "You opened several images, so PixPath made a batch. Each one"} is traced automatically, the same way <b>Fully automatic</b> would trace it on its own.</p>
    <div class="tip">${icon.bulb}<span>Files are named after the originals (logo.png → logo.svg) and never overwrite anything in the folder you pick.</span></div>
    <button class="btn" data-act="open">Add more images…</button>`;
  foot.innerHTML = `<button class="btn" data-act="closeBatch">← Back</button><div class="spacer"></div>
    <button class="btn primary" data-act="saveAll" ${done ? "" : "disabled"}>${done === n ? `Save ${n} to a folder…` : `Save ${done} traced…`}</button>`;
}

// ---- routing ---------------------------------------------------------------------------

const screens = { start, mode, advanced, review, batch };

export function render() {
  $("batchbar").hidden = true;
  screens[S.screen]();
}

/// A new trace arrived: refresh whatever on screen depends on it.
export function traced() {
  if (S.screen === "mode") mode();
  else if (S.screen === "review") review();
  else if (S.screen === "advanced") advancedTraced();
}
