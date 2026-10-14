// Guided: a few questions, each with PixPath's recommendation already picked
// (from the engine's analysis) and a live preview. Steps with nothing to
// decide are skipped. Every answer edits the same settings as Advanced.
//
// Steps for logos, illustrations and line art: Image type · Background ·
// Colours · Details · Review. For photos: Image type · Detail · Colours ·
// Shadows & lighting · Smoothness · Review.

import { $, esc, icon } from "./util.js";
import { S, TYPES, withType, options, removalPoints } from "./state.js";
import * as viewer from "./viewer.js";
import * as engine from "./engine.js";
import { hooks, render, finishButtons } from "./screens.js";

const panel = $("panel"), foot = $("foot"), stepper = $("stepper"), stage = $("stage");

const GLOW_SHARE = 0.02;

// ---- what the analysis says ---------------------------------------------------------

/// The analysis, or (if it never arrived) a stand-in built from the first
/// trace, which has every colour (later ones may have fewer, once a colour
/// count is picked), so the colour questions still work.
const a = () => S.analysis ?? fallbackAnalysis(S.first?.colors ? S.first : S.result);

function fallbackAnalysis(result) {
  const palette = (result?.colors ?? []).map((color) => ({ color, share: 1 }));
  return { kind: "logo", palette, nearDuplicates: [], softShare: 0, transparentShare: 0, background: null, removeBackground: false };
}

const isTransparent = () => a().transparentShare > 0.01;
const hasGlow = () => a().softShare >= GLOW_SHARE;

/// A plain name for a colour: "white", "black", or "coloured".
export function colourName(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  if (chroma < 24 && l > 0.9) return "white";
  if (chroma < 24 && l < 0.12) return "black";
  if (chroma < 24) return "grey";
  return l < 0.25 ? "dark" : "coloured";
}

/// The palette as the colour ladder uses it: every detected colour, most
/// common first, minus the background when it's being removed.
export function ladder(st = S) {
  const an = st.analysis ?? fallbackAnalysis(st.first?.colors ? st.first : st.result);
  const pal = an.palette;
  const bg = an.background?.color;
  const bgIndex = st.settings.removeBg && bg ? pal.findIndex((p) => p.color === bg) : -1;
  const visible = pal.map((p, i) => ({ ...p, i })).filter((p) => p.i !== bgIndex);
  // Every colour the engine keeps is a real one (it already drops specks).
  const recommended = Math.max(1, visible.length);
  // The engine keeps the top `maxColors` of the whole palette, background
  // included, so "n visible colours" may need one more.
  const maxColorsFor = (n) => (n >= visible.length ? 0 : visible[n - 1].i + 1);
  const current = st.settings.maxColors ? visible.filter((p) => p.i < st.settings.maxColors).length : visible.length;
  return { visible, recommended, maxColorsFor, current };
}

/// The questions for the image type chosen (see the top of this file).
function steps() {
  return S.settings.type === "detailed" ? PHOTO_STEPS : FLAT_STEPS;
}

/// Review comes after the last question.
export const reviewStep = () => steps().length + 1;

function stepSkipped(n) {
  return steps()[n - 1]?.skip?.() ?? false;
}

function why(text) {
  return `<div class="why">${icon.spark}<span>${text}</span></div>`;
}

function opt({ on, set, value, title, text, preview, checker = false, rec = false }) {
  return `<button class="opt${on ? " on" : ""}" data-gset="${set}" data-val="${value}" aria-pressed="${on}">
      <span class="tick">${icon.check}</span>
      ${rec ? `<span class="rec">Recommended</span>` : ""}
      <span class="pv${checker ? " checker" : ""}">${preview}</span>
      <strong>${title}</strong><span>${text}</span>
    </button>`;
}

function toggle(key, title, text, rec) {
  const on = !!S.settings[key];
  return `<button class="toggle${on ? " on" : ""}" data-gtoggle="${key}" aria-pressed="${on}"><span class="t"><strong>${title}${rec ? ` <span class="rec">Recommended</span>` : ""}</strong><span>${text}</span></span><span class="sw"></span></button>`;
}

/// Image-type pictures: an edge seen up close, the way each kind looks. The
/// photo card uses img/photo.jpg (from Pexels, free licence).
function edgeArt(kind) {
  const cells = [];
  const n = 8;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = x - (n - 1 - y) * 0.9; // signed distance to a diagonal edge
      const a = kind === "soft" ? Math.min(1, Math.max(0, (d + 1.2) / 2.4)) : d > 0 ? 1 : 0;
      if (a > 0.02) cells.push(`<rect x="${x * 10}" y="${y * 10}" width="10" height="10" fill="${kind === "bw" ? "#111" : "#1d2b53"}" fill-opacity="${a.toFixed(2)}"/>`);
    }
  }
  return `<svg viewBox="0 0 80 80" aria-hidden="true" style="width:72%;height:72%">${cells.join("")}</svg>`;
}

// ---- previews ----------------------------------------------------------------------
//
// Option cards show the real trace with that option, traced in the
// background worker from a small copy of the image (so a photo's previews
// take a second, not ten). Cached per image and settings.

const previews = new Map();
const PREVIEW_PIXELS = 300_000;

/// A small copy of the open image for previews: { blob, factor }, where
/// factor = small px per traced px. Made once per image.
async function smallCopy(image) {
  if (image.small) return image.small;
  const [ow, oh] = image.original ?? [image.width, image.height];
  const k = Math.min(1, Math.sqrt(PREVIEW_PIXELS / (ow * oh)));
  if (k === 1) return (image.small = { blob: image.blob, factor: ow / image.width });
  const [w, h] = [Math.max(1, Math.round(ow * k)), Math.max(1, Math.round(oh * k))];
  const bmp = await createImageBitmap(image.blob, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close();
  return (image.small = { blob: await canvas.convertToBlob({ type: "image/png" }), factor: w / image.width });
}

/// The preview card picture for the current settings with `over` applied.
/// `zoom` shows a close-up of the middle, where a photo's detail shows.
function preview(over, zoom = S.settings.type === "detailed") {
  const settings = { ...S.settings, trim: false, ...over };
  const image = S.image;
  const key = `${image.url}|${JSON.stringify(settings)}|${JSON.stringify(S.removals)}`;
  if (!previews.has(key)) {
    previews.set(key, null);
    smallCopy(image)
      .then(({ blob, factor }) => {
        const points = removalPoints().map((p) => ({ ...p, x: p.x * factor, y: p.y * factor }));
        return engine.traceOnce(blob, { options: options(settings, points) });
      })
      .then((out) => {
        previews.set(key, URL.createObjectURL(new Blob([out.result.svg], { type: "image/svg+xml" })));
        if (S.screen === "guided" && S.image === image) render();
      })
      .catch(() => previews.delete(key));
  }
  const url = previews.get(key);
  return url ? `<img src="${url}" alt=""${zoom ? ' class="zoom"' : ""}>` : `<span class="spinner"></span>`;
}

// ---- the steps ------------------------------------------------------------------------------

function stepType() {
  const k = a().kind;
  const bg = a().removeBackground ? a().background?.color : null;
  const n = a().palette.filter((p) => p.color !== bg).length;
  const reason = {
    logo: `Looks like a <b>logo</b>: ${n} flat colour${n === 1 ? "" : "s"} with crisp edges.`,
    illustration: hasGlow() ? "Looks like an <b>illustration</b>: flat colours with soft glows." : `Looks like an <b>illustration</b>: ${n} flat colours.`,
    detailed: "Lots of <b>shading and gradients</b>, like a photo or painted art.",
    bw: "Only <b>dark ink on a light page</b>: a black &amp; white drawing.",
  }[k];
  const card = (value, title, text, preview) =>
    opt({ on: S.settings.type === value, set: "type", value, title, text, preview, rec: k === value });
  return `<h2>What kind of image is this?</h2>
    ${why(reason)}
    <div class="opts">
      ${card("logo", "Logo or icon", "Solid colours, crisp edges, maybe text", edgeArt("sharp"))}
      ${card("illustration", "Illustration", "Flat colours, may have soft glows", edgeArt("soft"))}
      ${card("detailed", "Photo or detailed art", "Shading, gradients, lots of colours", `<img src="img/photo.jpg" alt="" style="object-fit:cover">`)}
      ${card("bw", "Black & white drawing", "Line art, sketches, scans", edgeArt("bw"))}
    </div>
    <div class="tip">${icon.bulb}<span>Not sure? Zoom into an edge of your picture: crisp steps mean a logo; a wide, soft fade means glows.</span></div>`;
}

function stepBackground() {
  const bg = a().background;
  const trimText = viewer.spaceText() || "Fit the SVG to the drawing";
  const trimToggle = toggle("trim", "Trim the empty space", `${trimText} (shaded on the picture)`, true);
  if (isTransparent() && !bg) {
    return `<h2>What about the background?</h2>
      ${why("Your image is <b>already transparent</b>, so there's no background to remove.")}
      ${trimToggle}`;
  }
  if (!bg) {
    return `<h2>What about the background?</h2>
      ${why("No single colour runs round the edge, so PixPath keeps everything. You can still click parts away in Review.")}
      ${trimToggle}`;
  }
  const name = colourName(bg.color);
  const rec = a().removeBackground ? "remove" : "keep";
  const reason = a().removeBackground
    ? `The border is <b>plain ${name}</b>, so it's probably a background, not part of the design.`
    : `The edge is <b>${name}</b> all round, but it looks like part of the picture, so PixPath would keep it.`;
  const choice = S.pickByHand ? "click" : S.settings.removeBg ? "remove" : "keep";
  const card = (value, title, text, preview, checker) =>
    opt({ on: choice === value, set: "bg", value, title, text, preview, checker, rec: rec === value });
  return `<h2>What about the background?</h2>
    ${why(reason)}
    <div class="opts three">
      ${card("keep", "Keep it", `The ${name} stays in the SVG`, preview({ removeBg: false }), false)}
      ${card("remove", "Remove it", "Transparent behind", preview({ removeBg: true }), true)}
      ${card("click", "I'll pick", "Click parts away in Review", preview({ removeBg: false }), true)}
    </div>
    ${S.settings.removeBg || !bg ? trimToggle : toggle("trim", "Trim the empty space", "Remove the background first; it fills the whole canvas.", false)}`;
}

function stepColours() {
  const L = ladder();
  const clear = S.settings.removeBg || isTransparent();
  const chip = (hex, big) => {
    const shown = S.recolor[hex] ?? hex;
    return big
      ? `<label class="chip-c big" style="background:${shown}" title="Change this colour"><input type="color" value="${shown}" data-recolor="${hex}" aria-label="Change colour ${hex}"></label>`
      : `<i class="chip-c" style="background:${shown}"></i>`;
  };
  const shownNow = L.visible.slice(0, L.current);
  const top = Math.min(L.visible.length, Math.max(8, L.recommended));
  const rows = [];
  for (let n = Math.min(2, L.visible.length); n <= top; n++) rows.push(n);
  const dupes = a().nearDuplicates.filter(([i, j]) => L.visible.some((p) => p.i === i) && L.visible.some((p) => p.i === j) && Math.max(i, j) < L.recommended + 1);
  const label = (n) =>
    n === L.recommended ? "recommended" : n > L.recommended ? "extra shades" : n === 2 ? "simplest" : "merges similar colours";
  return `<h2>Colours</h2>
    ${why(`Found <b>${L.recommended} colour${L.recommended === 1 ? "" : "s"}</b>${S.settings.removeBg ? " once the background is gone" : ""}${dupes.length ? ". Two of them look almost alike: if they should be one colour, pick a row with one fewer" : ", all clearly different"}.`)}
    <div>
      <div class="eyebrow" style="margin-bottom:6px">Your palette · click a colour to change it</div>
      <div class="pal">${clear ? `<span class="chip-c t big" title="Transparent"></span>` : ""}${shownNow.map((p) => chip(p.color, true)).join("")}
        ${Object.keys(S.recolor).length ? `<button class="btn ghost" data-act="resetColours">Reset colours</button>` : ""}</div>
    </div>
    <div>
      <div class="eyebrow" style="margin-bottom:6px">How many colours</div>
      <div class="ladder" role="radiogroup" aria-label="Number of colours">
        ${rows.map((n) => `<button class="lrow${L.current === n ? " on" : ""}" data-gset="colours" data-val="${n}" role="radio" aria-checked="${L.current === n}">
            <span class="mk">${n === L.recommended ? "★" : ""}</span>
            <span class="chips">${clear ? `<i class="chip-c t"></i>` : ""}${L.visible.slice(0, n).map((p) => chip(p.color, false)).join("")}</span>
            <span class="lab">${n} colour${n === 1 ? "" : "s"} · ${label(n)}</span>
          </button>`).join("")}
      </div>
    </div>
    <div class="tip">${icon.bulb}<span>Rows past the recommended one only add shades the image barely uses, which makes the file bigger without looking different.</span></div>`;
}

function stepDetails() {
  const kind = a().kind;
  const snap = TYPES[S.settings.type].engine === "snap";
  const glowAsk = snap && hasGlow();
  const linesRec = TYPES[kind].lines;
  return `<h2>A couple of details</h2>
    ${why(glowAsk ? "Found <b>soft glows</b>: PixPath can keep them soft instead of cutting them out." : "No soft glows, so that question is skipped.")}
    ${toggle("lines", "Straight lines &amp; sharp corners", "Straight edges come out perfectly straight, corners get a sharp point. Off for hand-drawn, organic shapes.", linesRec)}
    ${glowAsk ? toggle("glow", "Soft edges &amp; glows", "Where the picture fades softly (a moon, a light), the SVG gets a matching soft halo.", true) : ""}
    <div class="tip">${icon.bulb}<span>Questions only appear when they matter: a picture with a glowing moon asks about glows here.</span></div>`;
}

// ---- photo questions ------------------------------------------------------------------------

const DETAIL = [
  ["low", 16, "Low", "Fewer, bigger shapes · smallest file"],
  ["medium", 6, "Medium", "Keeps what you can see, without the specks"],
  ["high", 2, "High", "Keeps the small details · bigger file"],
];

function stepPhotoDetail() {
  const card = ([key, speckle, title, text]) =>
    opt({ on: S.settings.speckle === speckle, set: "speckle", value: speckle, title, text, preview: preview({ speckle }), rec: key === "medium" });
  return `<h2>How much detail?</h2>
    ${why("A photo is full of tiny specks of detail. <b>Medium</b> keeps everything you can see, without thousands of extra shapes.")}
    <div class="opts three">${DETAIL.map(card).join("")}</div>
    <div class="tip">${icon.bulb}<span>Detail sets the smallest shape PixPath keeps. Low reads like a painting; High like the photo.</span></div>`;
}

const PHOTO_COLOURS = [
  [8, "8 colours", "A bold, poster look"],
  [16, "16 colours", "Flat, but still lifelike"],
  [32, "32 colours", "Close to the photo, with a tidy palette"],
  [64, "64 colours", "Very close to the photo"],
  [0, "Every shade", "As many colours as the photo has"],
];

function stepPhotoColours() {
  const card = ([n, title, text]) =>
    opt({ on: S.settings.maxColors === n, set: "maxColors", value: n, title, text, preview: preview({ maxColors: n }), rec: n === 32 });
  return `<h2>How many colours?</h2>
    ${why("<b>32 colours</b> look almost like the photo, and give the SVG a palette you can edit. Fewer look more like a poster.")}
    <div class="opts three">${PHOTO_COLOURS.map(card).join("")}</div>
    <div class="tip">${icon.bulb}<span>For photos the colour count changes the look more than the file size.</span></div>`;
}

const LIGHT = [
  ["keep", { evenLighting: false, gradient: 16 }, "Keep shadows", "As they are in the photo"],
  ["soften", { evenLighting: false, gradient: 40 }, "Soften shadows", "Broader, flatter shading"],
  ["even", { evenLighting: true, gradient: 16 }, "Even out the lighting", "Shadows mostly disappear"],
];

function lightChoice() {
  return S.settings.evenLighting ? "even" : S.settings.gradient >= 32 ? "soften" : "keep";
}

function stepLight() {
  const now = lightChoice();
  const card = ([key, over, title, text]) => opt({ on: now === key, set: "light", value: key, title, text, preview: preview(over), rec: key === "keep" });
  return `<h2>Shadows and lighting</h2>
    ${why("Shadows are traced as darker shapes. <b>Keep</b> them for a true-to-life result, <b>soften</b> them for a flatter look, or <b>even out</b> the lighting so they mostly disappear.")}
    <div class="opts three">${LIGHT.map(card).join("")}</div>
    <div class="tip">${icon.bulb}<span>Evening out works best on buildings, products and documents. On faces and rounded things it can look flat, so check the preview.</span></div>`;
}

const SMOOTH = [
  ["smooth", 1.2, "Smooth", "Simplified, flowing shapes · smaller file"],
  ["balanced", 0.5, "Balanced", "Smooth edges that still follow the photo"],
  ["exact", 0.15, "Exact", "Follows every edge closely · bigger file"],
];

function stepSmooth() {
  const card = ([key, simplify, title, text]) =>
    opt({ on: S.settings.simplify === simplify, set: "simplify", value: simplify, title, text, preview: preview({ simplify }), rec: key === "balanced" });
  return `<h2>How smooth?</h2>
    ${why("<b>Balanced</b> gives clean, smooth edges that still follow the photo.")}
    <div class="opts three">${SMOOTH.map(card).join("")}</div>`;
}

/// Labels for Review's "Your choices" with a photo.
export function photoChoices() {
  const s = S.settings;
  return {
    detail: DETAIL.find((d) => d[1] === s.speckle)?.[2] ?? "Custom",
    colours: s.maxColors ? `${s.maxColors} colours` : "Every shade",
    light: LIGHT.find((l) => l[0] === lightChoice())[2],
    smooth: SMOOTH.find((m) => m[1] === s.simplify)?.[2] ?? "Custom",
  };
}

const FLAT_STEPS = [
  { name: "Image type", body: stepType },
  { name: "Background", body: stepBackground, live: true },
  { name: "Colours", body: stepColours, live: true, skip: () => TYPES[S.settings.type].engine !== "snap" || ladder().visible.length < 2 },
  { name: "Details", body: stepDetails },
];
const PHOTO_STEPS = [
  { name: "Image type", body: stepType },
  { name: "Detail", body: stepPhotoDetail },
  { name: "Colours", body: stepPhotoColours },
  { name: "Shadows & lighting", body: stepLight },
  { name: "Smoothness", body: stepSmooth },
];

// ---- navigation --------------------------------------------------------------------------------

export function drawStepper(active) {
  stepper.hidden = false;
  stepper.innerHTML = [...steps().map((st) => st.name), "Review"].map((name, i) => {
    const n = i + 1;
    const skip = stepSkipped(n);
    const cls = skip ? "skip" : n === active ? "on" : n < active ? "done" : "";
    return `${i ? `<span class="sep"></span>` : ""}<button class="st ${cls}" ${skip ? "disabled" : `data-act="step:${n}"`}><span class="n">${n < active && !skip ? "✓" : n}</span>${name}</button>`;
  }).join("");
}

function next(n, dir) {
  let k = n + dir;
  while (k >= 1 && k < reviewStep() && stepSkipped(k)) k += dir;
  return k;
}

/// The last question before Review.
export function lastStep() {
  return next(reviewStep(), -1);
}

/// Open question `n` (past the last question = Review).
export function openStep(n) {
  S.from = "guided";
  if (n >= reviewStep()) {
    S.screen = "review";
    if (S.pickByHand) S.view.tool = "remove";
    render();
    return;
  }
  if (stepSkipped(n)) n = next(n, 1);
  S.step = n;
  S.screen = n >= reviewStep() ? "review" : "guided";
  render();
}

export function nextStep() {
  openStep(next(S.step, 1));
}

export function prevStep() {
  const k = next(S.step, -1);
  if (k < 1) {
    S.screen = "mode";
    render();
  } else openStep(k);
}

export function guided() {
  // Changing the image type can change the questions.
  if (S.step >= reviewStep()) S.step = lastStep();
  drawStepper(S.step);
  viewer.mount(stage, { tools: true, hint: "Live preview of your choices" });
  panel.innerHTML = steps()[S.step - 1].body();
  const k = next(S.step, 1);
  foot.innerHTML = `<button class="btn" data-act="guidedPrev">← Back</button>
    <button class="btn ghost" data-act="bounds">${S.view.bounds ? "Hide" : "Show"} bounds</button>
    <div class="spacer"></div>
    ${k >= reviewStep() ? finishButtons() : `<button class="btn primary" data-act="guidedNext">Continue to ${esc(steps()[k - 1].name.toLowerCase())} →</button>`}`;
}

/// A new trace: refresh what depends on it (the trim text, the palette).
export function traced() {
  if (steps()[S.step - 1]?.live) panel.innerHTML = steps()[S.step - 1].body();
}

// ---- answers -----------------------------------------------------------------------------------

panel.addEventListener("click", (e) => {
  if (S.screen !== "guided") return;
  const set = e.target.closest("[data-gset]");
  if (set) {
    const v = set.dataset.val;
    const k = set.dataset.gset;
    if (k === "type") S.settings = withType(S.settings, v);
    else if (k === "bg") {
      S.pickByHand = v === "click";
      S.settings.removeBg = v === "remove";
      if (v === "remove") S.settings.trim = true;
    } else if (k === "colours") {
      S.settings.maxColors = ladder().maxColorsFor(+v);
    } else if (k === "light") {
      Object.assign(S.settings, LIGHT.find((l) => l[0] === v)[1]);
    } else if (["speckle", "maxColors", "simplify"].includes(k)) {
      S.settings[k] = +v;
    }
    hooks.settingsChanged();
    render();
    return;
  }
  const t = e.target.closest("[data-gtoggle]");
  if (t) {
    const k = t.dataset.gtoggle;
    S.settings[k] = !S.settings[k];
    if (k === "trim" && !S.settings.trim) S.trimBounds = null;
    hooks.settingsChanged();
    render();
  }
});

// Live recolouring: the picture updates without tracing again.
panel.addEventListener("input", (e) => {
  const rc = e.target.closest("[data-recolor]");
  if (!rc) return;
  S.recolor[rc.dataset.recolor] = rc.value;
  rc.parentElement.style.background = rc.value;
  hooks.recolored();
});
// When the picker closes, redraw the ladder in the new colours too.
panel.addEventListener("change", (e) => {
  if (S.screen === "guided" && e.target.closest("[data-recolor]")) render();
});
