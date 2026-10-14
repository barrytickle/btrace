// App state: the open image, its settings, and how they become engine options.
//
// Every mode (Automatic, Guided, Advanced) edits the same `S.settings`, so
// switching between them never loses a choice.

/// What each image type sets; the rest of the settings refine it.
export const TYPES = {
  logo: { label: "Logo or icon", engine: "snap", smooth: 1.2, lines: true, simplify: 0.25, speckle: 4, glow: false },
  illustration: { label: "Illustration", engine: "snap", smooth: 1.2, lines: true, simplify: 0.35, speckle: 4, glow: true },
  detailed: { label: "Photo or detailed art", engine: "color", lines: false, simplify: 0.5, speckle: 6, precision: 6, gradient: 16 },
  bw: { label: "Black & white drawing", engine: "bw", lines: true, simplify: 0.3, speckle: 4, threshold: 128, adaptive: false },
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

/// What "Fully automatic" applies. Stage 3 replaces this with the image's
/// own analysis; for now it's PixPath's best general choice. Only a plain
/// white border is taken as a background to remove (a dark or coloured edge
/// is often part of the picture).
export function recommendedSettings(image = S.image) {
  return { ...withType(defaultSettings(), "logo"), removeBg: !!image?.whiteBorder && !image.transparent, trim: true };
}

export const S = {
  screen: "start",
  image: null, // { name, blob, url, width, height, transparent, whiteBorder }
  settings: defaultSettings(),
  removals: [], // clicked points: { x, y, wholeColor } in image px
  result: null, // the trace as shown (full canvas)
  cropped: null, // the trace as saved, when trimmed
  ms: 0,
  from: null, // the screen that led to Review
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

/// The options for the saved file, or null when it isn't trimmed.
export function croppedOptions(settings = S.settings, removals = S.removals) {
  return settings.trim ? options(settings, removals, true) : null;
}
