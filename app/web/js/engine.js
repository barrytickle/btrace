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
let onLoaded = null;

setStatus("Starting engine…", "busy");
main.onmessage = ({ data }) => {
  if (data.type === "ready") {
    setStatus("");
  } else if (data.type === "loaded") {
    onLoaded?.resolve();
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
    }
  }
};
main.onerror = (e) => setStatus(`The engine failed to start: ${e.message || e}`, "error");

/// Decode `blob` into pixels. Returns { rgba, width, height, transparent,
/// whiteBorder }: whether any pixel is see-through, and whether the border is
/// (almost) all plain white, the usual sign of a logo on a white background.
export async function decode(blob) {
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const ctx = new OffscreenCanvas(width, height).getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = ctx.getImageData(0, 0, width, height).data;
  let transparent = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) {
      transparent = true;
      break;
    }
  }
  let white = 0;
  let border = 0;
  const visit = (x, y) => {
    const i = (y * width + x) * 4;
    border++;
    if (data[i + 3] > 250 && data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235) white++;
  };
  for (let x = 0; x < width; x++) visit(x, 0), visit(x, height - 1);
  for (let y = 1; y < height - 1; y++) visit(0, y), visit(width - 1, y);
  return { rgba: data.buffer, width, height, transparent, whiteBorder: white >= 0.9 * border };
}

/// Start a session on decoded pixels. Resolves once the engine has them.
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

/// Trace `blob` with a throwaway session. Resolves to
/// { result, cropped, width, height, ms }.
export function traceOnce(blob, options, cropped = null) {
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    batch().postMessage({ type: "trace-once", id, blob, options, cropped });
  });
}

/// Abandon every batch job in flight (their promises reject).
export function cancelBatch() {
  batchWorker?.terminate();
  batchWorker = null;
  for (const job of waiting.values()) job.reject(new Error("cancelled"));
  waiting.clear();
}
