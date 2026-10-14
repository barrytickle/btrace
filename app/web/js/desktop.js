// What differs between the desktop app (Tauri) and a browser tab: saving
// files, opening links, the version, and updates.

import { $, setStatus, toast } from "./util.js";
import { zipStore } from "./zip.js";

/// The Tauri API in the desktop app; undefined in a browser.
export const desktop = window.__TAURI__;

export async function version() {
  try {
    return desktop?.app ? await desktop.app.getVersion() : null;
  } catch {
    return null;
  }
}

/// Save one SVG: a native "Save as" on desktop, a download in a browser.
export async function saveSvg(name, svg) {
  if (desktop) {
    try {
      const path = await desktop.core.invoke("save_svg", { name, contents: svg });
      if (path) toast(`Saved ${path.split(/[\\/]/).pop()}`);
    } catch (e) {
      setStatus(String(e), "error");
    }
    return;
  }
  download(new Blob([svg], { type: "image/svg+xml" }), name);
}

/// Save several SVGs ({ name, contents }): into a folder the user picks on
/// desktop (never overwriting), or as one .zip in a browser.
export async function saveAll(files) {
  if (!files.length) return;
  if (desktop) {
    try {
      const saved = await desktop.core.invoke("save_all", { files });
      if (saved) toast(`Saved ${saved.count} SVGs to ${saved.folder.split(/[\\/]/).pop()}`);
    } catch (e) {
      setStatus(String(e), "error");
    }
    return;
  }
  download(zipStore(files), "pixpath-svgs.zip");
  toast(`Downloaded ${files.length} SVGs as a zip`);
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/// Open a web page in the user's browser.
export function openUrl(url) {
  if (desktop?.opener) desktop.opener.openUrl(url);
  else window.open(url, "_blank", "noopener");
}

// ---- updates ----------------------------------------------------------------
//
// On start-up the desktop app quietly asks GitHub Releases whether a newer,
// signed build exists, and a banner offers it. Help › Check for updates asks
// on demand. Nothing installs without a click, and offline is not an error.

/// Ask for an update. Resolves to the update (or null); throws if the check
/// itself failed. Browser: always null.
export async function findUpdate() {
  if (!desktop?.updater) return null;
  return (await desktop.updater.check()) ?? null;
}

/// Download and install `update`, reporting progress through `progress(text)`,
/// then restart into the new version.
export async function installUpdate(update, progress) {
  let total = 0;
  let done = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") total = event.data.contentLength || 0;
    if (event.event === "Progress") {
      done += event.data.chunkLength;
      const pct = total ? ` ${Math.round((done / total) * 100)}%` : "";
      progress(`Downloading PixPath ${update.version}…${pct}`);
    }
    if (event.event === "Finished") progress("Installing…");
  });
  await desktop.process.relaunch();
}

/// Show the title-bar banner for `update`.
export function offerUpdate(update) {
  const bar = $("update");
  $("updateText").textContent = `PixPath ${update.version} is available`;
  bar.classList.add("show");
  $("updateInstall").disabled = $("updateLater").disabled = false;
  $("updateLater").onclick = () => bar.classList.remove("show");
  $("updateInstall").onclick = async () => {
    $("updateInstall").disabled = $("updateLater").disabled = true;
    try {
      await installUpdate(update, (t) => ($("updateText").textContent = t));
    } catch (e) {
      $("updateText").textContent = `Update failed: ${e}`;
      $("updateLater").disabled = false;
    }
  };
}

export async function quietUpdateCheck() {
  try {
    const update = await findUpdate();
    if (update) offerUpdate(update);
  } catch {
    // offline, or no release published yet
  }
}
