// Help dialogs: About, Check for updates, What's new, Keyboard shortcuts,
// Report a problem. Buttons use data-act (handled in main.js) or data-close.

import { $, esc, icon } from "./util.js";
import { desktop, findUpdate, installUpdate, offerUpdate, openUrl, version } from "./desktop.js";
import { S, TYPES } from "./state.js";

const REPO = "https://github.com/barrytickle/btrace";

let appVersion = null;
version().then((v) => (appVersion = v));

const WHATS_NEW = [
  ["A new look", "a light theme (dark is in View), and a menu bar"],
  ["Start screen", "browse, paste or batch a folder; recent images reopen in one click"],
  ["Fully automatic", "one click and PixPath picks the settings"],
  ["Review before saving", "compare with the original, click away shapes, trim the empty space, see the file size"],
  ["Centre", "the picture can't get lost off-screen"],
];

const dialogs = {
  about: () => ({
    title: "About PixPath",
    body: `<div class="about-mark">${icon.mark}<span><b>PixPath</b>${appVersion ? `Version ${esc(appVersion)}` : "Web version"}</span></div>
      <p>Turns images into clean SVG vectors: logos, icons, illustrations and line art. Everything runs on your computer; images are never uploaded.</p>
      <p>Built on <b>visioncortex VTracer</b> (MIT / Apache-2.0), with PixPath's own palette snapping, glows, straight lines and background removal.</p>
      <p><button class="link" data-act="openRepo">github.com/barrytickle/btrace</button></p>`,
    buttons: `${desktop ? `<button class="btn" data-act="dlg:update">Check for updates</button>` : ""}<button class="btn primary" data-close>Close</button>`,
  }),

  update: () => {
    if (!desktop?.updater) {
      return {
        title: "Check for updates",
        body: `<p>Updates come with the desktop app, which installs new versions for you. Get it from the releases page.</p>`,
        buttons: `<button class="btn" data-close>Close</button><button class="btn primary" data-act="openReleases" data-close>Open releases</button>`,
      };
    }
    return {
      title: "Check for updates",
      body: `<div style="display:flex;align-items:center;gap:10px"><span class="spinner"></span><span>Checking for a newer version…</span></div>`,
      buttons: `<button class="btn" data-close>Cancel</button>`,
      after: checkNow,
    };
  },

  whatsnew: () => ({
    title: `What's new${appVersion ? ` in ${esc(appVersion)}` : ""}`,
    body: `<ul>${WHATS_NEW.map(([b, t]) => `<li><b>${b}</b>: ${t}</li>`).join("")}</ul>
      <p><button class="link" data-act="openReleases">Every release's notes</button></p>`,
    buttons: `<button class="btn primary" data-close>Close</button>`,
  }),

  shortcuts: () => ({
    title: "Keyboard shortcuts",
    body: `<table>
        <tr><td>Open an image</td><td><kbd>Ctrl</kbd> <kbd>O</kbd></td></tr>
        <tr><td>Open a folder as a batch</td><td><kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>O</kbd></td></tr>
        <tr><td>Paste an image</td><td><kbd>Ctrl</kbd> <kbd>V</kbd></td></tr>
        <tr><td>Save SVG</td><td><kbd>Ctrl</kbd> <kbd>S</kbd></td></tr>
        <tr><td>Copy SVG code</td><td><kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>C</kbd></td></tr>
        <tr><td>Undo a removal</td><td><kbd>Ctrl</kbd> <kbd>Z</kbd></td></tr>
        <tr><td>Compare · Preview · Remove</td><td><kbd>V</kbd> · <kbd>P</kbd> · <kbd>R</kbd></td></tr>
        <tr><td>Outlines · Bounds</td><td><kbd>O</kbd> · <kbd>B</kbd></td></tr>
        <tr><td>Centre · Zoom</td><td><kbd>0</kbd> · <kbd>+</kbd> <kbd>−</kbd></td></tr>
        <tr><td>Pan while removing</td><td><kbd>Space</kbd> + drag</td></tr>
      </table>`,
    buttons: `<button class="btn primary" data-close>Close</button>`,
  }),

  report: () => ({
    title: "Report a problem",
    body: `<p>Tell us what happened. PixPath opens a GitHub issue with your version and settings filled in; your image is not uploaded.</p>
      <label for="rp" class="eyebrow">What went wrong?</label>
      <textarea id="rp" placeholder="e.g. The background wasn't removed from my logo"></textarea>`,
    buttons: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-act="sendReport" data-close>Open GitHub issue</button>`,
  }),
};

export function showDialog({ title, body, buttons }) {
  $("dlg").innerHTML = `<header><h3 id="dlgTitle">${title}</h3><button class="x" data-close aria-label="Close">×</button></header>
    <div class="body">${body}</div><footer>${buttons}</footer>`;
  $("modal").hidden = false;
  ($("dlg").querySelector("textarea") ?? $("dlg").querySelector("footer .primary") ?? $("dlg").querySelector("[data-close]"))?.focus();
}

export function openDialog(kind) {
  const d = dialogs[kind]();
  showDialog(d);
  d.after?.();
}

export function closeDialog() {
  $("modal").hidden = true;
}

export function dialogOpen() {
  return !$("modal").hidden;
}

$("modal").addEventListener("click", (e) => {
  // Let a button's own action run before the dialog closes.
  if (e.target.id === "modal" || e.target.closest("[data-close]")) setTimeout(closeDialog, 0);
});

async function checkNow() {
  const stillOpen = () => dialogOpen() && $("dlgTitle")?.textContent === "Check for updates";
  let update;
  try {
    update = await findUpdate();
  } catch {
    if (stillOpen()) {
      showDialog({
        title: "Check for updates",
        body: `<p>PixPath couldn't reach GitHub to check. Are you online? You can try again later.</p>`,
        buttons: `<button class="btn primary" data-close>Close</button>`,
      });
    }
    return;
  }
  if (!stillOpen()) return;
  if (!update) {
    showDialog({
      title: "You're up to date",
      body: `<p>PixPath ${esc(appVersion ?? "")} is the latest version.</p>`,
      buttons: `<button class="btn primary" data-close>Close</button>`,
    });
    return;
  }
  const notes = (update.body || "").trim();
  showDialog({
    title: `PixPath ${esc(update.version)} is available`,
    body: `<p>You have ${esc(appVersion ?? "an older version")}. Installing takes a few seconds, then PixPath restarts.</p>
      ${notes ? `<div><div class="eyebrow" style="margin-bottom:6px">What's new</div><p style="white-space:pre-line">${esc(notes)}</p></div>` : ""}
      <p id="updProgress" hidden></p>`,
    buttons: `<button class="btn" data-close>Later</button><button class="btn primary" id="updGo">Install &amp; restart</button>`,
  });
  offerUpdate(update);
  $("updGo").onclick = async () => {
    $("updGo").disabled = true;
    const p = $("updProgress");
    p.hidden = false;
    try {
      await installUpdate(update, (t) => (p.textContent = t));
    } catch (e) {
      p.textContent = `Update failed: ${e}`;
      $("updGo").disabled = false;
    }
  };
}

export function sendReport() {
  const what = ($("rp")?.value || "").trim();
  const s = S.settings;
  const lines = [
    what || "(describe what happened)",
    "",
    "---",
    `PixPath ${appVersion ?? "web"} · ${navigator.userAgent.match(/Windows NT [\d.]+|Mac OS X [\d_]+|Linux/)?.[0] ?? ""}`,
    S.image ? `Image: ${S.image.width} × ${S.image.height}${S.image.transparent ? ", transparent" : ""}` : "No image open",
    `Settings: ${TYPES[s.type].label}; ${JSON.stringify(s)}`,
  ];
  const title = what ? what.split("\n")[0].slice(0, 80) : "Problem report";
  openUrl(`${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(lines.join("\n"))}`);
}

export const links = {
  openRepo: () => openUrl(REPO),
  openReleases: () => openUrl(`${REPO}/releases`),
};
