// Small helpers shared by every part of the app.

export const $ = (id) => document.getElementById(id);

/// Escape text for use inside HTML built from template strings.
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function plural(n, one, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function formatBytes(n) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
}

export function svgURL(svg) {
  return URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
}

/// "logo.png" → "logo.svg".
export function svgName(name) {
  return `${name.replace(/\.[^.]+$/, "") || "trace"}.svg`;
}

export function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
}

/// The quiet status line in the title bar ("Tracing…", "Traced in 80 ms").
export function setStatus(text, kind = "") {
  const s = $("status");
  s.textContent = text;
  s.className = `status ${kind}`;
  s.title = text;
}

/// localStorage that never throws (private windows, blocked storage).
export const prefs = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(`pixpath.${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`pixpath.${key}`, JSON.stringify(value));
    } catch {}
  },
};

export const icon = {
  check: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10.5l3.2 3L15 6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  bulb: `<svg viewBox="0 0 20 20" aria-hidden="true" style="flex:0 0 18px;width:18px;height:18px"><path d="M10 2.5a5.5 5.5 0 0 0-3.2 10v2h6.4v-2A5.5 5.5 0 0 0 10 2.5zM7.8 17h4.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  spark: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2l1.8 5.2L17 9l-5.2 1.8L10 16l-1.8-5.2L3 9l5.2-1.8z" fill="currentColor"/></svg>`,
  mark: `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="var(--accent)"/><path d="M8 23 L16 9 L24 23" fill="none" stroke="var(--accent-ink)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><circle cx="16" cy="9" r="2.6" fill="var(--accent-ink)"/></svg>`,
};
