// Recent images, kept in this app's own storage (IndexedDB) so they can be
// reopened with one click. Only images, never traces; the newest few, each
// under a size limit. If storage is unavailable the list is simply empty.

const DB = "pixpath";
const STORE = "recent";
const KEEP = 6;
const MAX_BYTES = 8 * 1024 * 1024;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "name" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

/// Recent images, newest first: [{ name, blob, width, height, at }].
export async function list() {
  try {
    const db = await open();
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    const all = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return all.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/// Remember an opened image (replacing one of the same name).
export async function add({ name, blob, width, height }) {
  if (!blob || blob.size > MAX_BYTES) return;
  try {
    const old = await list();
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.put({ name, blob, width, height, at: Date.now() });
    old.filter((r) => r.name !== name).slice(KEEP - 1).forEach((r) => store.delete(r.name));
    await done(tx);
  } catch {}
}

/// "today", "yesterday", "3 days ago"…
export function when(at) {
  const day = 86400000;
  const start = new Date().setHours(0, 0, 0, 0);
  if (at >= start) return "today";
  if (at >= start - day) return "yesterday";
  const days = Math.ceil((start - at) / day);
  return days < 14 ? `${days} days ago` : new Date(at).toLocaleDateString();
}
