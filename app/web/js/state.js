// App state: the open image, its settings, and how they become engine options.
//
// Every mode (Automatic, Guided, Advanced) edits the same `S.settings`, so
// switching between them never loses a choice.

/// What each image type sets; the rest of the settings refine it.
export const TYPES = {
  logo: { label: "Logo or icon", engine: "snap", smooth: 1.2, lines: true, simplify: 0.25, speckle: 4, glow: false },
  illustration: { label: "Illustration", engine: "snap", smooth: 1.2, lines: true, simplify: 0.35, speckle: 4, glow: true },
  detailed: { label: "Photo or detailed art", engine: "color", lines: false, simplify: 0.5, speckle: 6, precision: 6, gradient: 16, glow: false },
  bw: { label: "Black & white drawing", engine: "bw", lines: true, simplify: 0.3, speckle: 4, threshold: 128, adaptive: false, glow: false },
};

export function defaultSettings() {
  return {
    type: "logo",
    maxColors: 0, // 0 = as many as the image really has
    smooth: 1.2,
    glow: false,
    precision: 6,
    gradient: 16,
    threshold: 128,
    adaptive: false,
    simplify: 0.25,
    speckle: 4,
    lines: true,
    noOverlap: false,
    removeBg: false,
    trim: false,
    pad: 0,
  };
}

/// The settings for image type `type`, keeping choices that don't depend on it.
export function withType(settings, type) {
  const t = TYPES[type];
  const s = { ...settings, type, maxColors: 0 };
  for (const k of ["smooth", "lines", "simplify", "speckle", "glow", "precision", "gradient", "threshold", "adaptive"]) {
    if (t[k] !== undefined) s[k] = t[k];
  }
  return s;
}

/// What PixPath recommends for an image, from its analysis (see
/// Tracer.analyse): the type it looks like, its background, and trimming.
export function recommendedSettings(analysis = S.analysis) {
  const kind = analysis?.kind ?? "logo";
  return { ...withType(defaultSettings(), kind), removeBg: !!analysis?.removeBackground, trim: true };
}

export const S = {
  screen: "start",
  image: null, // { name, blob, url, width, height }
  analysis: null, // what the engine noticed about the image
  settings: defaultSettings(),
  removals: [], // clicked points: { x, y, wholeColor } in image px
  recolor: {}, // palette edits: { "#rrggbb" (traced): "#rrggbb" (shown) }
  trimBounds: null, // the drawing's extent when last trimmed (image px)
  trimPending: false, // take a new trim snapshot from the next trace
  result: null, // the latest trace (full canvas)
  ms: 0,
  from: null, // the mode that led to Review: auto | guided | advanced
  step: 1, // Guided: the question on screen
  pickByHand: false, // Guided: "I'll pick" the background in Review
  analysing: false,
  first: null, // the first trace of the image, for "What PixPath noticed"
  view: { tool: "compare", split: 0.5, outlines: false, bounds: false },
  batch: null, // { items: [...] } while a batch is open
};

/// Engine options for `settings` (+ removals). `crop` traces the saved file.
export function options(settings = S.settings, removals = S.removals, crop = false) {
  const s = settings;
  const o = {
    hierarchical: s.noOverlap ? "cutout" : "stacked",
    mode: "spline",
    filterSpeckle: s.speckle,
    simplify: s.simplify,
    lines: s.lines,
    removeBackground: s.removeBg,
    remove: removals,
    crop: crop ? s.pad : null,
    pathPrecision: 2,
  };
  const engine = TYPES[s.type].engine;
  if (engine === "snap") {
    Object.assign(o, { clustering: "snap", maxColors: s.maxColors, snapSmooth: s.smooth, snapGlow: s.glow });
  } else if (engine === "color") {
    Object.assign(o, { clustering: "color-cluster", colorPrecision: s.precision, layerDifference: s.gradient });
  } else {
    Object.assign(o, { clustering: "bw", binaryThreshold: s.threshold, adaptive: s.adaptive });
  }
  return o;
}

/// The options for a batch image's saved file, or null when it isn't trimmed.
/// (The open image is trimmed from a snapshot instead; see savedSvg.)
export function croppedOptions(settings = S.settings, removals = S.removals) {
  return settings.trim ? options(settings, removals, true) : null;
}

// ---- trimming ----------------------------------------------------------------
//
// Trimming fits the SVG's canvas to the drawing. In Review it's a snapshot:
// clicking Trim records the drawing's extent then, and later removals don't
// move it until Trim is clicked again. On the settings screens it follows the
// drawing as settings change.

/// The saved canvas for drawing extent `b` ([x0, y0, x1, y1]) with padding:
/// whole pixels, the drawing centred in the rounding slack (as the engine's
/// own crop does).
export function trimCanvas(b, pad = S.settings.pad) {
  const bw = b[2] - b[0] + 2 * pad;
  const bh = b[3] - b[1] + 2 * pad;
  const w = Math.max(1, Math.ceil(bw));
  const h = Math.max(1, Math.ceil(bh));
  return { x: b[0] - pad - (w - bw) / 2, y: b[1] - pad - (h - bh) / 2, w, h };
}

/// The saved SVG's canvas in image px: the whole image, or the trim.
export function savedCanvas() {
  const w = S.image?.width || 1;
  const h = S.image?.height || 1;
  if (!S.settings.trim || !S.trimBounds) return { x: 0, y: 0, w, h };
  return trimCanvas(S.trimBounds);
}

/// Whether trimming the current drawing would change the canvas at all.
export function trimWouldChange(b = S.result?.bounds) {
  if (!b || !S.image) return false;
  const c = trimCanvas(b);
  return c.w < S.image.width || c.h < S.image.height || Math.abs(c.x) > 0.5 || Math.abs(c.y) > 0.5;
}

/// Whether the drawing has changed since the trim snapshot.
export function trimIsStale() {
  const b = S.result?.bounds;
  if (!S.settings.trim || !S.trimBounds || !b) return false;
  return b.some((v, i) => Math.abs(v - S.trimBounds[i]) > 0.5);
}

/// `svg` with its canvas set to `c` (image px): the engine's own crop works
/// the same way, through the viewBox.
function cropSvg(svg, c) {
  const r = (v) => Math.round(v * 100) / 100;
  return svg.replace(/<svg[^>]*>/, (tag) =>
    tag
      .replace(/\swidth="[^"]*"/, ` width="${c.w}"`)
      .replace(/\sheight="[^"]*"/, ` height="${c.h}"`)
      .replace(/\sviewBox="[^"]*"/, ` viewBox="${r(c.x)} ${r(c.y)} ${c.w} ${c.h}"`),
  );
}

/// `svg` with palette edits applied.
export function recolored(svg) {
  const edits = Object.entries(S.recolor).filter(([a, b]) => a.toLowerCase() !== b.toLowerCase());
  if (!edits.length) return svg;
  const map = new Map(edits.map(([a, b]) => [a.toLowerCase(), b]));
  return svg.replace(/#[0-9a-fA-F]{6}\b/g, (hex) => map.get(hex.toLowerCase()) ?? hex);
}

/// The trace as shown: full canvas, palette edits applied.
export function shownSvg() {
  return S.result ? recolored(S.result.svg) : "";
}

/// The SVG as it will be saved: trimmed (if on) and recoloured.
export function savedSvg() {
  if (!S.result) return "";
  const svg = recolored(S.result.svg);
  return S.settings.trim && S.trimBounds ? cropSvg(svg, savedCanvas()) : svg;
}
