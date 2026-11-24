// Excalisave: keep named drawings for excalidraw.com in chrome.storage.local.
//
// Excalidraw keeps the open scene in the page's own storage:
//   localStorage "excalidraw"        -> elements (JSON array)
//   localStorage "excalidraw-state"  -> appState (JSON object)
//   IndexedDB "files-db"/"files-store", key = fileId -> image data
// Saving copies those into our storage; loading writes them back across a reload.
// This script runs at document_start so a load can finish before Excalidraw starts.
//
// Our storage (chrome.storage.local):
//   "meta:<id>" -> { title, savedAt }            small, read to list drawings
//   "data:<id>" -> { elements, appState, files }  the drawing itself
//   "current"   -> { id, hash }  drawing on the canvas + hash of its saved
//                  elements, used to tell whether the canvas has unsaved changes

const store = chrome.storage.local;
const PENDING_LOAD = 'excalisave:pending-load'; // sessionStorage, survives our reload

/* ---------- Excalidraw's storage ---------- */

function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

// Excalidraw debounces its localStorage writes and flushes them on window
// "blur". A synthetic blur makes localStorage match what is on screen now.
function flushExcalidraw() {
  window.dispatchEvent(new Event('blur'));
}

// A flush makes this tab write its in-memory scene, which is stale if another
// tab changed the canvas since. Excalidraw syncs from other tabs ~50 ms after
// this tab gains focus or becomes visible, so we wait until 300 ms after that
// before flushing. A tab without focus is never flushed: it already flushed on
// its real blur.
let focusedAt = 0;
window.addEventListener('focus', () => (focusedAt = Date.now()));
document.addEventListener('visibilitychange', () => document.hidden || (focusedAt = Date.now()));

async function currentElements() {
  const wait = focusedAt + 300 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  if (document.hasFocus()) flushExcalidraw();
  return readLocal('excalidraw', []).filter((e) => !e.isDeleted);
}

// Runs fn(objectStore) in one transaction; resolves with fn's return value once
// the transaction completes. Creates the store like idb-keyval would, so we
// never leave Excalidraw a database without it.
function filesDb(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('files-db');
    req.onupgradeneeded = () => req.result.createObjectStore('files-store');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('files-store', mode);
      const result = fn(tx.objectStore('files-store'));
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

async function getFiles(ids) {
  const reqs = await filesDb('readonly', (s) => ids.map((id) => s.get(id)));
  return reqs.map((r) => r.result).filter(Boolean);
}

async function readScene() {
  const elements = await currentElements();
  const appState = readLocal('excalidraw-state', {});
  const ids = [...new Set(elements.filter((e) => e.type === 'image' && e.fileId).map((e) => e.fileId))];
  // Excalidraw writes image data to IndexedDB asynchronously after the flush.
  for (let i = 0; ; i++) {
    const files = await getFiles(ids);
    if (files.length === ids.length) return { elements, appState, files };
    if (i === 25) throw new Error('some images are not stored by Excalidraw yet. Try again in a moment.');
    await new Promise((r) => setTimeout(r, 200));
  }
}

// Load a scene: images go to IndexedDB now; the scene itself is stashed in
// sessionStorage and written to localStorage by the next page at document_start,
// before Excalidraw's code reads it. Writing it from this page does not work:
// the old page flushes its own pending save while unloading (on
// "beforeunload", and again on "visibilitychange" after "pagehide"), which can
// land after any write of ours.
async function loadScene({ elements, appState, files }, afterLoad) {
  const now = Date.now();
  await filesDb('readwrite', (s) => files.forEach((f) => s.put({ ...f, lastRetrieved: now }, f.id)));
  const theme = readLocal('excalidraw-state', {}).theme; // keep the user's theme
  sessionStorage.setItem(PENDING_LOAD, JSON.stringify({ at: now, elements, appState: { ...appState, theme }, afterLoad }));
  location.replace(location.origin + '/'); // also drops any #json=/#room= hash
}

// The second half of loadScene, on the new page. The age check stops a stash
// from a navigation that never happened (e.g. a cancelled "Leave site?") from
// being applied to some later reload.
const pendingLoad = JSON.parse(sessionStorage.getItem(PENDING_LOAD));
sessionStorage.removeItem(PENDING_LOAD);
if (pendingLoad && Date.now() - pendingLoad.at < 60000) {
  localStorage.setItem('excalidraw', JSON.stringify(pendingLoad.elements));
  localStorage.setItem('excalidraw-state', JSON.stringify(pendingLoad.appState));
  // Bumping these makes other open excalidraw.com tabs pick up the new scene.
  localStorage.setItem('version-dataState', String(Date.now()));
  localStorage.setItem('version-files', String(Date.now()));
}

// Hash of the visible content, robust to how Excalidraw normalises a scene when
// it restores one: ignores the fields it bumps on its own, sorts object keys, and
// treats null and [] like a missing key.
async function hashOf(elements) {
  const json = JSON.stringify(
    elements.filter((e) => !e.isDeleted).map(({ version, versionNonce, updated, ...e }) => e),
    (k, v) => v === null || (Array.isArray(v) && !v.length) ? undefined
      : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v
  );
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

/* ---------- Our drawings ---------- */

async function listDrawings() {
  const keys = (await store.getKeys()).filter((k) => k.startsWith('meta:'));
  const metas = await store.get(keys);
  return keys.map((k) => ({ id: k.slice(5), ...metas[k] })).sort((a, b) => b.savedAt - a.savedAt);
}

async function getOne(key) {
  return (await store.get(key))[key];
}

async function saveDrawing(id, title) {
  if (location.hash.includes('room=')) throw new Error('not available during live collaboration.');
  const scene = await readScene();
  if (!scene.elements.length) throw new Error('the canvas is empty, so there is nothing to save. To remove a saved drawing, delete it from the list.');
  await store.set({
    [`meta:${id}`]: { title, savedAt: Date.now() },
    [`data:${id}`]: scene,
    current: { id, hash: await hashOf(scene.elements) },
  });
}

// What is on the canvas: the attached drawing (if any) and whether it differs.
async function canvasState() {
  const elements = await currentElements();
  const current = await getOne('current');
  const meta = current && (await getOne(`meta:${current.id}`));
  const clean = meta && current.hash === (await hashOf(elements));
  // An empty canvas is only "nothing to lose" when it isn't a drawing we opened.
  return { id: meta ? current.id : null, meta, dirty: !clean && (elements.length > 0 || !!meta) };
}

async function okToReplaceCanvas() {
  const { meta, dirty } = await canvasState();
  if (!dirty) return true;
  return confirm(
    meta
      ? `“${meta.title}” has unsaved changes on the canvas. Discard them?`
      : 'The current canvas is not saved in Excalisave. Discard it?'
  );
}

// Reads "current" at click time: another tab may have opened a different
// drawing since the panel was drawn, and we must never save into the old one.
async function saveCurrent() {
  const current = await getOne('current');
  const meta = current && (await getOne(`meta:${current.id}`));
  if (!meta) throw new Error('no saved drawing is open on the canvas. Use “Save as new”.');
  await saveDrawing(current.id, meta.title);
  toast(`Saved “${meta.title}”`);
}

async function openDrawing(id) {
  if (!(await okToReplaceCanvas())) return;
  const [meta, data] = [await getOne(`meta:${id}`), await getOne(`data:${id}`)];
  if (!meta || !data) throw new Error('that drawing no longer exists.');
  const hash = await hashOf(data.elements);
  await loadScene(data, { msg: `Opened “${meta.title}”`, hash, current: { id, hash } });
}

async function newBlank() {
  if (!(await okToReplaceCanvas())) return;
  const appState = { ...readLocal('excalidraw-state', {}), scrollX: 0, scrollY: 0, zoom: { value: 1 } };
  await loadScene({ elements: [], appState, files: [] }, { msg: 'New blank canvas', hash: await hashOf([]), current: null });
}

/* ---------- UI ---------- */

const host = Object.assign(document.createElement('div'), { id: 'excalisave' });
const root = host.attachShadow({ mode: 'open' });
const PENCIL = '<svg viewBox="0 0 24 24"><path d="M4 20h4L18.5 9.5a2.8 2.8 0 0 0-4-4L4 16v4M13.5 6.5l4 4"/></svg>';
const TRASH = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
root.innerHTML = `<style>
  :host { --bg: #fff; --fg: #1b1b1f; --muted: #6b6b7b; --btn: #ececf4; --hover: #e0dfff;
    --accent: #6965db; --accent-fg: #fff; --line: #e8e8ef; --tint: #f1f0ff; --danger: #c92a2a;
    all: initial; font: 14px/1.4 Assistant, system-ui, sans-serif; color: var(--fg); }
  :host(.dark) { --bg: #232329; --fg: #e3e3e8; --muted: #a0a0b0; --btn: #2e2d39; --hover: #3d3a5c;
    --accent: #a8a5ff; --accent-fg: #1b1b1f; --line: #34343f; --tint: #2e2d39; --danger: #ff8787; }
  * { box-sizing: border-box; font: inherit; color: inherit; }
  [hidden] { display: none !important; }
  button { border: 0; border-radius: 8px; background: var(--btn); padding: 0 10px; height: 32px; cursor: pointer; }
  button:hover { background: var(--hover); }
  button.primary, button.primary:hover { background: var(--accent); color: var(--accent-fg); }
  button.primary:hover { filter: brightness(1.1); }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0; }
  .bar { position: fixed; left: 206px; bottom: 16px; z-index: 6; display: flex; align-items: center; gap: 8px; pointer-events: none; }
  .bar > * { pointer-events: auto; }
  .launcher { height: 36px; max-width: 240px; display: flex; align-items: center; gap: 6px; white-space: nowrap; }
  .launcher span { overflow: hidden; text-overflow: ellipsis; }
  .panel { position: fixed; left: 206px; bottom: 60px; z-index: 5; width: 320px; max-height: calc(100vh - 170px);
    display: flex; flex-direction: column; gap: 10px; padding: 12px; background: var(--bg); border-radius: 12px;
    box-shadow: 0 0 0 1px var(--line), 0 8px 24px rgba(0,0,0,.15); }
  .panel > :not(ul) { flex-shrink: 0; }
  .current { display: flex; align-items: center; gap: 8px; }
  .current .label { flex: 1; min-width: 0; }
  .current b, .title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  b { font-weight: 600; }
  .muted { color: var(--muted); font-size: 12px; }
  .dirty { color: var(--danger); }
  form { display: flex; gap: 6px; }
  input { flex: 1; min-width: 0; height: 32px; padding: 0 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; border-top: 1px solid var(--line); }
  li { display: flex; align-items: center; gap: 2px; padding: 2px 0; }
  li .open { flex: 1; min-width: 0; height: auto; padding: 6px 8px; text-align: left; background: none; }
  li .open:hover, li .icon:hover { background: var(--btn); }
  li.is-current .open { background: var(--tint); }
  li .icon { background: none; width: 32px; padding: 0; display: grid; place-items: center; color: var(--muted); }
  .empty { padding: 12px 4px; color: var(--muted); }
  .toast { max-width: 360px; min-width: 0; padding: 7px 12px; border-radius: 8px; background: var(--fg); color: var(--bg); cursor: pointer;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Excalidraw's compact layout (same breakpoints) puts its toolbar at the bottom; use the free top strip. */
  @media (max-width: 599px), (max-height: 499px) and (max-width: 999px) {
    .bar { left: 56px; right: 56px; top: 12px; bottom: auto; }
    .panel { left: 8px; right: 8px; top: 60px; bottom: auto; width: auto; max-height: calc(100vh - 170px); }
  }
  .toast.error { background: var(--danger); color: #fff; white-space: normal; }
</style>
<div class="bar">
  <button class="launcher" title="Excalisave: saved drawings"><svg viewBox="0 0 24 24"><path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6"/></svg><span>Drawings</span></button>
  <div class="toast" role="status" hidden></div>
</div>
<div class="panel" hidden>
  <div class="current"></div>
  <form><input placeholder="Title for a new drawing" maxlength="200"><button>Save as new</button></form>
  <button class="new">New blank canvas</button>
  <ul></ul>
</div>`;

const $ = (sel) => root.querySelector(sel);
const launcher = $('.launcher'), panel = $('.panel'), list = $('ul'), input = $('input'), toastEl = $('.toast');

function closePanel() {
  panel.hidden = true;
  root.activeElement?.blur(); // hand the keyboard back to Excalidraw
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

let toastTimer;
function toast(msg, isError = false) {
  toastEl.textContent = toastEl.title = msg;
  toastEl.classList.toggle('error', isError);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), isError ? 10000 : 3000);
}

// Run a UI action; any failure (including chrome.storage errors) becomes a toast.
async function run(action) {
  try {
    await action();
  } catch (e) {
    console.error('Excalisave:', e);
    const msg = /context invalidated/i.test(e.message)
      ? 'Excalisave was reloaded or updated. Refresh this page.'
      : `Excalisave error: ${e.message}`;
    toast(msg, true);
  }
}

function formatTime(t) {
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

async function render() {
  const [{ id: currentId, meta, dirty }, drawings] = await Promise.all([canvasState(), listDrawings()]);
  $('.launcher span').textContent = meta ? meta.title : 'Drawings';

  const status = meta
    ? el('span', { className: dirty ? 'muted dirty' : 'muted', textContent: dirty ? 'Unsaved changes' : 'All changes saved' })
    : el('span', { className: 'muted', textContent: dirty ? 'Not saved yet. Give it a title below.' : 'Empty canvas' });
  const label = el('div', { className: 'label' }, el('b', { textContent: meta ? meta.title : 'Untitled canvas' }), status);
  const children = [label];
  if (meta) {
    const save = el('button', { className: dirty ? 'primary' : '', textContent: 'Save', title: `Update “${meta.title}”` });
    save.onclick = () => run(async () => {
      await saveCurrent();
      await render();
    });
    children.push(save);
  }
  $('.current').replaceChildren(...children);
  $('form button').className = meta ? '' : 'primary';

  list.replaceChildren(...drawings.map((d) => {
    const open = el('button', { className: 'open', title: `Open “${d.title}”` },
      el('span', { className: 'title', textContent: d.title }),
      el('span', { className: 'muted', textContent: (d.id === currentId ? 'On canvas · ' : '') + formatTime(d.savedAt) }));
    open.onclick = () => run(() => openDrawing(d.id));
    const rename = el('button', { className: 'icon', title: 'Rename', innerHTML: PENCIL });
    rename.onclick = () => run(async () => {
      const title = prompt('Rename drawing', d.title)?.trim();
      if (!title || title === d.title) return;
      await store.set({ [`meta:${d.id}`]: { title, savedAt: d.savedAt } });
      toast(`Renamed to “${title}”`);
      await render();
    });
    const del = el('button', { className: 'icon', title: 'Delete', innerHTML: TRASH });
    del.onclick = () => run(async () => {
      if (!confirm(`Delete “${d.title}”? This cannot be undone.\n(The canvas itself is not changed.)`)) return;
      await store.remove([`meta:${d.id}`, `data:${d.id}`]);
      if (d.id === currentId) await store.remove('current');
      toast(`Deleted “${d.title}”`);
      await render();
    });
    return el('li', { className: d.id === currentId ? 'is-current' : '' }, open, rename, del);
  }));
  if (!drawings.length) list.append(el('li', { className: 'empty', textContent: 'No saved drawings yet. Type a title above and press “Save as new”.' }));
}

launcher.onclick = () => run(async () => {
  if (!panel.hidden) return closePanel();
  panel.hidden = false;
  await render();
  input.focus();
});

$('form').onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    const title = input.value.trim() || `Untitled ${formatTime(Date.now())}`;
    await saveDrawing(crypto.randomUUID(), title);
    input.value = '';
    toast(`Saved “${title}”`);
    await render();
  });
};

$('.new').onclick = () => run(newBlank);
toastEl.onclick = () => (toastEl.hidden = true);

// Keep Excalidraw's shortcuts and paste handling away from our inputs, close on Escape.
for (const type of ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut']) {
  host.addEventListener(type, (e) => {
    e.stopPropagation();
    if (type === 'keydown' && e.key === 'Escape') closePanel();
  });
}
document.addEventListener('pointerdown', (e) => {
  if (!panel.hidden && !e.composedPath().includes(host)) closePanel();
}, true);

// Follow Excalidraw's light/dark theme.
const syncTheme = () => host.classList.toggle('dark', !!document.querySelector('.excalidraw.theme--dark'));

// Show the title of the drawing on the canvas, and report the outcome of a load.
async function refreshLauncher() {
  const current = await getOne('current');
  const meta = current && (await getOne(`meta:${current.id}`));
  $('.launcher span').textContent = meta ? meta.title : 'Drawings';
}

// Never show a stale drawing: follow changes made in other tabs, and redraw an
// open panel when this tab gets focus back (currentElements waits for
// Excalidraw's own tab sync before reading).
store.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((k) => k === 'current' || k.startsWith('meta:'))) run(panel.hidden ? refreshLauncher : render);
});
window.addEventListener('focus', () => panel.hidden || run(render));

document.addEventListener('DOMContentLoaded', () => run(async () => {
  new MutationObserver(syncTheme).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  syncTheme();
  document.body.append(host);
  // If a load just ran and its scene is what Excalidraw has, only now does
  // "current" change. On failure "current" keeps naming what is on the canvas.
  const after = pendingLoad?.afterLoad;
  if (after && (await hashOf(readLocal('excalidraw', []))) === after.hash) {
    await (after.current ? store.set({ current: after.current }) : store.remove('current'));
    toast(after.msg);
  } else if (after) {
    toast('The load did not stick: Excalidraw overwrote it. Please try again.', true);
  }
  await refreshLauncher();
}));
