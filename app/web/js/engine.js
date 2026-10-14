// The tracing engine, running in Web Workers (see worker.js).
//
// One worker holds the open image: `load()` it once, then `render()` as often
// as settings change; renders are coalesced in the worker and an older render
// that finishes late is dropped here, so only the newest result is shown.
// Batch images use a second worker (`traceOnce`), so tracing a batch never
// disturbs the open image.

import { setStatus } from "./util.js";

const WORKER_URL = new URL("../worker.js", import.meta.url);

const main = new Worker(WORKER_URL, { type: "module" });
let renderId = 0;
let shownId = 0;
let onResult = () => {};
let onFailed = () => {};
let onLoaded = null;

setStatus("Starting engine…", "busy");
main.onmessage = ({ data }) => {
  if (data.type === "ready") {
    setStatus("");
  } else if (data.type === "loaded") {
    onLoaded?.resolve(data.analysis);
    onLoaded = null;
  } else if (data.type === "rendered") {
    if (data.id < shownId) return; // an older render finished late
    shownId = data.id;
    onResult(data.result, data.cropped, data.ms);
  } else if (data.type === "error") {
    if (data.id === -1 && onLoaded) {
      onLoaded.reject(new Error(data.message));
      onLoaded = null;
    } else {
      setStatus(data.message, "error");
      onFailed(data.message);
    }
  }
};
main.onerror = (e) => {
  setStatus(`The engine stopped: ${e.message || e}`, "error");
  onFailed(String(e.message || e));
};

/// Images are traced at no more than this many pixels. A phone photo is
/// 12 MP; traced at full size it takes minutes and makes a huge SVG with no
/// more visible detail. Saved SVGs keep the original size (see `scale`).
export const MAX_PIXELS = 4_000_000;

/// The traced size for an image of `w` × `h`: { width, height, scale }, where
/// `scale` (≥ 1) is original px per traced px.
export function tracedSize(w, h) {
  const k = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)), scale: 1 / k };
}

/// Decode `blob` into pixels, scaled down if it's very large. Returns
/// { rgba, width, height, scale }: the traced size, and original px per
/// traced px.
export async function decode(blob) {
  const probe = await createImageBitmap(blob);
  const original = [probe.width, probe.height];
  const size = tracedSize(...original);
  let bitmap = probe;
  if (size.scale > 1) {
    probe.close();
    bitmap = await createImageBitmap(blob, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" });
  }
  const { width, height } = bitmap;
  const ctx = new OffscreenCanvas(width, height).getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { rgba: ctx.getImageData(0, 0, width, height).data.buffer, width, height, scale: size.scale, original };
}

/// Start a session on decoded pixels. Resolves with the engine's analysis
/// of the image (kind, palette, background…) once it has them.
export function load({ rgba, width, height }) {
  shownId = renderId; // results for the previous image are stale now
  return new Promise((resolve, reject) => {
    onLoaded = { resolve, reject };
    main.postMessage({ type: "load", rgba, width, height }, [rgba]);
  });
}

/// Trace the open image. `cropped` (optional) are options for the saved file.
export function render(options, cropped = null) {
  setStatus("Tracing…", "busy");
  main.postMessage({ type: "render", id: ++renderId, options, cropped });
}

/// Called with the message when a trace fails (or the engine stops).
export function setFailHandler(fn) {
  onFailed = fn;
}

/// Called with (result, cropped, ms) for each new result of `render()`.
export function setResultHandler(fn) {
  onResult = fn;
}

// ---- batch ----------------------------------------------------------------

let batchWorker = null;
const waiting = new Map();

function batch() {
  if (batchWorker) return batchWorker;
  batchWorker = new Worker(WORKER_URL, { type: "module" });
  batchWorker.onmessage = ({ data }) => {
    const job = waiting.get(data.id);
    if (!job) return;
    waiting.delete(data.id);
    if (data.type === "traced") job.resolve(data);
    else if (data.type === "error") job.reject(new Error(data.message));
  };
  return batchWorker;
}

let jobId = 0;

/// Trace `blob` with a throwaway session. `job` is { options, cropped }, or
/// { auto } to pick settings from the image's own analysis (see worker.js).
/// Resolves to { result, cropped, width, height, analysis, ms }.
export function traceOnce(blob, job) {
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    batch().postMessage({ type: "trace-once", id, blob, ...job });
  });
}

/// Whether the newest render has come back.
export function idle() {
  return shownId === renderId;
}

/// Abandon every batch job in flight (their promises reject).
export function cancelBatch() {
  batchWorker?.terminate();
  batchWorker = null;
  for (const job of waiting.values()) job.reject(new Error("cancelled"));
  waiting.clear();
}
