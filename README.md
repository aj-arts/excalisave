# Excalisave

A personal Chrome extension that keeps many named drawings for
https://excalidraw.com, without an Excalidraw+ account. A **Drawings** button sits
next to Excalidraw's undo/redo (bottom left). In narrow windows, where Excalidraw
moves its toolbar to the bottom, the button moves to the top bar instead. It opens
a panel where you can:

- save the canvas as a new named drawing, or **Save** over the drawing you opened,
- open a saved drawing (newest first),
- start a new blank canvas,
- rename or delete drawings.

If the canvas has changes that are not saved in Excalisave, opening another drawing
or starting a blank canvas asks before discarding them. Emptying a drawing you
opened counts as a change. An empty canvas can't be saved; to get rid of a drawing,
delete it from the list.

## Install

1. Download [`excalisave.zip`](https://github.com/aj-arts/excalisave/releases/latest/download/excalisave.zip)
   from the latest release and unzip it somewhere you will keep it. (Or clone this
   repo.)
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the unzipped `excalisave` folder (the one with
   `manifest.json`).
4. Reload any open excalidraw.com tab.

To update, unzip the new release over the same folder, click the reload icon on
the extension card, then reload the excalidraw.com tab. Keep the folder in the
same place: loading it from a different path gives the extension a new ID and an
empty storage.

There is no build step. After editing the code, click the reload icon on the
extension card, then reload the excalidraw.com tab.

Every push to `main` publishes a new release (see `.github/workflows/release.yml`).
The release version is the `version` in `manifest.json` plus the workflow run
number.

## Files

- `manifest.json`: Manifest V3, the `storage` and `unlimitedStorage` permissions, and one content script on `https://excalidraw.com/*`.
- `content.js`: everything else. It reads and writes Excalidraw's storage, keeps our drawings, and draws the UI in a shadow root. It runs at `document_start` so that a load can finish before Excalidraw's own code starts; the UI is added once the page's body exists.

## Where your drawings live

They are in `chrome.storage.local` for this extension, in this Chrome profile only.
Each drawing is two keys: `meta:<id>` (title and save time) and `data:<id>`
(elements, appState and image files). `current` records which drawing is on the
canvas.

**They are lost if you remove the extension** (or remove and re-add it unpacked
from a different folder, which gives it a new ID). Clearing excalidraw.com site
data does not touch them. Nothing is synced or backed up. To keep a drawing
safe, use Excalidraw's own *Save to disk* as well.

## How save and load work (check this if Excalidraw changes)

Excalidraw keeps the open scene in the page's own storage, which a content script
can reach:

- `localStorage["excalidraw"]`: the elements, as a JSON array.
- `localStorage["excalidraw-state"]`: the appState.
- IndexedDB database `files-db`, store `files-store` (idb-keyval), keyed by `fileId`: image data.
- `localStorage["version-dataState"]` and `["version-files"]`: timestamps that tell other tabs to reload the scene.

**Save.** Excalidraw writes to localStorage about 300 ms after a change, and
writes at once when the window loses focus. Before reading, we fire a synthetic
`blur` on `window` so localStorage matches the screen. Image data reaches
IndexedDB a moment later, so the save waits up to about 5 seconds for every image
it needs.

**Load.** We write the image files to IndexedDB and put the scene in
sessionStorage, then reload the page. On the new page the content script copies
the scene into localStorage at `document_start`, before Excalidraw's code reads
it. Writing it from the old page does not work. While the old page unloads,
Excalidraw flushes its pending save, first on `beforeunload` and again on
`visibilitychange` (which fires after `pagehide`). An edit made shortly before the
navigation finishes is still pending at that point, so the flush lands after any
write of ours. We reproduced exactly that. A stash older than 60 seconds is
ignored, so a cancelled navigation can't apply it later. The user's light/dark
theme is kept. After the reload, the extension checks that the scene it wrote is
still there, and only then changes `current`. If the check fails, it shows an
error and `current` keeps naming what is really on the canvas. If loads start
failing, look here first.

**Unsaved-changes check.** We hash the elements, leaving out fields that Excalidraw
changes on its own (`version`, `versionNonce` and `updated`). The check compares
that hash for the canvas against the hash stored when the drawing was saved or
opened. When Excalidraw restores a scene it normalises it. The changes seen so far
are reordered keys (arrow bindings, freehand `strokeOptions`) and
`boundElements: null` turning into `[]`. So the hash sorts object keys and treats
`null` and `[]` as missing. If opening an untouched drawing ever shows "Unsaved
changes", Excalidraw has started a new normalisation. To find it, compare
`data:<id>` with `localStorage["excalidraw"]`.

**Several tabs.** All excalidraw.com tabs share one localStorage, so they share one
canvas, and Excalisave tracks one current drawing for all of them. When a tab
regains focus, Excalidraw copies the canvas over from the other tab. The launcher
and any open panel follow `chrome.storage` changes from other tabs. **Save** looks
up the current drawing when you click it, never when the panel was drawn. Each
flush makes the tab write its in-memory canvas, which is out of date until
Excalidraw has synced it from the other tab. Excalidraw does that about 50 ms after
the tab gains focus or becomes visible. So every flush, for Save and for the
unsaved-changes check, first waits until 300 ms after that moment, and a tab
without focus never flushes. Without the wait, clicking Save within a few
milliseconds of switching tabs saved the old canvas into the newer drawing.

Things to recheck after an Excalidraw update: the storage key names above, that a
`blur` still flushes the save, that Excalidraw still reads the scene from
localStorage when the page starts (not earlier than `document_start`), and that
its cross-tab sync still finishes well within 300 ms of focus.
