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
//        With `strays: true`, tiny stray shapes are removed too (logos and
//        line art only; pass `kind` with explicit options).
//   out: { type: "traced", id, result, cropped, width, height, scale, analysis,
//          first, strays, ms }: `first` = { bounds, strays } before strays
//          were removed, `strays` = the removal points used.
//        or { type: "error", id, message }
async function traceOnce(msg) {
  const t0 = performance.now();
  let t = null;
  try {
    // Very large images are traced smaller (see MAX_PIXELS in js/engine.js).
    const probe = await createImageBitmap(msg.blob);
    const [pw, ph] = [probe.width, probe.height];
    const k = Math.min(1, Math.sqrt(4_000_000 / (pw * ph)));
    let bitmap = probe;
    if (k < 1) {
      probe.close();
      bitmap = await createImageBitmap(msg.blob, { resizeWidth: Math.max(1, Math.round(pw * k)), resizeHeight: Math.max(1, Math.round(ph * k)), resizeQuality: "high" });
    }
    const { width, height } = bitmap;
    const ctx = new OffscreenCanvas(width, height).getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    t = new Tracer(new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer), width, height);
    const analysis = t.analyse();
    const { options, cropped: croppedOptions } = msg.auto
      ? msg.auto[analysis.kind][analysis.removeBackground ? "remove" : "keep"]
      : msg;
    let result = t.render(options);
    const first = { bounds: result.bounds, strays: result.strays };
    let strays = [];
    // Strays only for logos and line art (see straysOf in js/state.js).
    const kind = msg.auto ? analysis.kind : msg.kind;
    if (msg.strays && ["logo", "bw"].includes(kind) && result.strays.length) {
      strays = result.strays.map(([x, y]) => ({ x, y, wholeColor: false }));
      const remove = [...(options.remove ?? []), ...strays];
      result = t.render({ ...options, remove });
    }
    const cropped = croppedOptions ? t.render(croppedOptions) : null;
    postMessage({ type: "traced", id: msg.id, result, cropped, width, height, scale: 1 / k, original: [pw, ph], analysis, first, strays, ms: performance.now() - t0 });
  } catch (e) {
    postMessage({ type: "error", id: msg.id, message: String(e) });
  } finally {
    t?.free();
  }
}
