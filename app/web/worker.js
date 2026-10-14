// Runs the PixPath engine off the UI thread.
//
// Messages in:
//   { type: "load", rgba, width, height }       start a session on an image
//   { type: "render", id, options, cropped }    trace; `cropped` (optional)
//                                               is a second options object
//                                               for the download
// Messages out:
//   { type: "ready" }                           wasm initialised
//   { type: "loaded", analysis }              what PixPath noticed (see
//                                               Tracer.analyse)
//   { type: "rendered", id, result, cropped, ms }
//   { type: "error", id, message }
//
// Renders are coalesced: a trace blocks this thread, so requests that arrive
// meanwhile queue up; each one only replaces `pending`, and a single drain
// runs the newest. Dragging a slider never replays stale positions.

import init, { Tracer } from "./pkg/pixpath_wasm.js";

let tracer = null;
let pending = null;
let scheduled = false;

function drain() {
  scheduled = false;
  const msg = pending;
  pending = null;
  if (!msg || !tracer) return;
  const t0 = performance.now();
  try {
    const result = tracer.render(msg.options);
    const cropped = msg.cropped ? tracer.render(msg.cropped) : null;
    postMessage({ type: "rendered", id: msg.id, result, cropped, ms: performance.now() - t0 });
  } catch (e) {
    postMessage({ type: "error", id: msg.id, message: String(e) });
  }
}

const ready = init().then(() => postMessage({ type: "ready" }));

onmessage = async (e) => {
  const msg = e.data;
  await ready;
  if (msg.type === "load") {
    pending = null;
    tracer?.free();
    tracer = null;
    try {
      tracer = new Tracer(new Uint8Array(msg.rgba), msg.width, msg.height);
      postMessage({ type: "loaded", analysis: tracer.analyse() });
    } catch (err) {
      postMessage({ type: "error", id: -1, message: String(err) });
    }
  } else if (msg.type === "render") {
    pending = msg;
    if (!scheduled) {
      scheduled = true;
      setTimeout(drain, 0);
    }
  } else if (msg.type === "trace-once") {
    traceOnce(msg);
  }
};

// Batch jobs: decode an image and trace it with a throwaway session, leaving
// any interactive session in this worker untouched.
//   in:  { type: "trace-once", id, blob, options, cropped }
//        or { ..., auto } instead of options/cropped: a table
//        auto[kind][removeBg ? "remove" : "keep"] = { options, cropped },
//        picked by this image's own analysis (Fully automatic per image).
//   out: { type: "traced", id, result, cropped, width, height, analysis, ms }
//        or { type: "error", id, message }
async function traceOnce(msg) {
  const t0 = performance.now();
  let t = null;
  try {
    const bitmap = await createImageBitmap(msg.blob);
    const { width, height } = bitmap;
    const ctx = new OffscreenCanvas(width, height).getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    t = new Tracer(new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer), width, height);
    const analysis = t.analyse();
    const { options, cropped: croppedOptions } = msg.auto
      ? msg.auto[analysis.kind][analysis.removeBackground ? "remove" : "keep"]
      : msg;
    const result = t.render(options);
    const cropped = croppedOptions ? t.render(croppedOptions) : null;
    postMessage({ type: "traced", id: msg.id, result, cropped, width, height, analysis, ms: performance.now() - t0 });
  } catch (e) {
    postMessage({ type: "error", id: msg.id, message: String(e) });
  } finally {
    t?.free();
  }
}
