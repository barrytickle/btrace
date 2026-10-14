// The in-app menu bar: File / Edit / View / Help. Items are data-act buttons
// (handled in main.js); `enabled(act)` greys out what doesn't apply right now.

import { $ } from "./util.js";

const MENUS = [
  ["File", [
    ["open", "Open image…", "Ctrl+O"],
    ["folder", "Open folder as batch…", "Ctrl+Shift+O"],
    ["paste", "Paste image", "Ctrl+V"],
    "-",
    ["save", "Save SVG…", "Ctrl+S"],
    ["saveAll", "Save all…", "Ctrl+Shift+S"],
    "-",
    ["startOver", "Start over"],
  ]],
  ["Edit", [
    ["undoRemove", "Undo removal", "Ctrl+Z"],
    ["clearRemove", "Put back everything removed"],
    "-",
    ["copy", "Copy SVG code", "Ctrl+Shift+C"],
  ]],
  ["View", [
    ["tool:compare", "Compare with original", "V"],
    ["tool:preview", "Preview the SVG", "P"],
    ["tool:original", "Original only"],
    ["outlines", "Outlines", "O"],
    ["bounds", "Bounds and empty space", "B"],
    "-",
    ["fit", "Centre and fit", "0"],
    ["zoomIn", "Zoom in", "+"],
    ["zoomOut", "Zoom out", "−"],
    "-",
    ["theme", "Switch light / dark"],
  ]],
  ["Help", [
    ["dlg:update", "Check for updates…"],
    ["dlg:whatsnew", "What's new"],
    ["dlg:shortcuts", "Keyboard shortcuts", "?"],
    "-",
    ["dlg:report", "Report a problem…"],
    ["dlg:about", "About PixPath"],
  ]],
];

const nav = $("menus");
nav.innerHTML = MENUS.map(([name, items]) => `<div><button aria-haspopup="true" aria-expanded="false">${name}</button><div class="drop" role="menu">${items
  .map((it) => (it === "-" ? "<hr>" : `<button role="menuitem" data-act="${it[0]}">${it[1]}${it[2] ? ` <kbd>${it[2]}</kbd>` : ""}</button>`))
  .join("")}</div></div>`).join("");

let enabled = () => true;

/// `fn(act)` says whether a menu item can be used now.
export function setEnabled(fn) {
  enabled = fn;
}

export function closeMenus() {
  nav.querySelectorAll(":scope > div").forEach((d) => {
    d.classList.remove("open");
    d.firstElementChild.setAttribute("aria-expanded", "false");
  });
}

function openMenu(div) {
  closeMenus();
  div.classList.add("open");
  div.firstElementChild.setAttribute("aria-expanded", "true");
  div.querySelectorAll("[data-act]").forEach((b) => (b.disabled = !enabled(b.dataset.act)));
}

document.addEventListener("click", (e) => {
  const top = e.target.closest(".menus > div > button");
  if (top) {
    const div = top.parentElement;
    if (div.classList.contains("open")) closeMenus();
    else openMenu(div);
    return;
  }
  // Any other click (including choosing an item) closes the menus.
  closeMenus();
}, true);

// Moving across the bar while a menu is open opens the one under the mouse.
nav.addEventListener("pointerover", (e) => {
  const top = e.target.closest(".menus > div > button");
  if (top && nav.querySelector(".open") && !top.parentElement.classList.contains("open")) openMenu(top.parentElement);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && nav.querySelector(".open")) {
    closeMenus();
    e.stopPropagation();
  }
}, true);
