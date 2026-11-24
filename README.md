# Excalisave

A Chrome extension that keeps named drawings for https://excalidraw.com, no
Excalidraw+ account needed. A **Drawings** button next to undo/redo opens a panel
where you can save the canvas under a title, open a saved drawing, save over the
one you have open, rename, delete, or start a blank canvas. It asks before
discarding unsaved work.

## Install

1. Download [`excalisave.zip`](https://github.com/aj-arts/excalisave/releases/latest/download/excalisave.zip) and unzip it somewhere permanent.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the unzipped `excalisave` folder.
4. Reload any open excalidraw.com tab.

**Update:** unzip the new release over the same folder, click the reload icon on
the extension card, and reload excalidraw.com.

## Your data

Drawings are stored in this extension's `chrome.storage.local`, in this Chrome
profile only. Nothing is synced or backed up.

**Removing the extension, or loading it from a different folder, deletes them.**
Use Excalidraw's *Save to disk* for anything you can't lose.

## For maintainers

Two source files, no build step: `manifest.json` and `content.js`. Every push to
`main` publishes a release (`.github/workflows/release.yml`), versioned as the
manifest `version` plus the run number.

Excalidraw keeps the open scene in page storage, which the content script reads
and writes:

| Where | What |
|---|---|
| `localStorage["excalidraw"]` | elements |
| `localStorage["excalidraw-state"]` | appState |
| IndexedDB `files-db` / `files-store` | image data, keyed by `fileId` |
| `localStorage["version-dataState"]`, `["version-files"]` | timestamps that make other tabs resync |

Ours, in `chrome.storage.local`: `meta:<id>` (title, save time), `data:<id>`
(elements, appState, images) and `current` (the drawing on the canvas, plus a hash
of its saved elements).

- **Save.** Excalidraw debounces its localStorage writes, so we fire a synthetic
  `blur` on `window` to flush them, then read. Images reach IndexedDB slightly
  later; the save waits up to 5 s for them.
- **Load.** Images go to IndexedDB, the scene goes to sessionStorage, and the page
  reloads. The new page copies the scene into localStorage at `document_start`,
  before Excalidraw reads it. Writing from the old page fails: Excalidraw flushes
  its own pending save during unload and overwrites it. `current` changes only
  after the new page confirms the scene is in place.
- **Unsaved-changes check.** Compares a hash of the canvas elements with the hash
  in `current`. Excalidraw normalises a scene when it restores it, so the hash
  ignores `version`, `versionNonce` and `updated`, sorts object keys, and treats
  `null` and `[]` as missing.
- **Several tabs.** All tabs share one canvas and one `current`. A tab's in-memory
  canvas is stale until Excalidraw resyncs it, about 50 ms after focus, so we never
  flush an unfocused tab and wait 300 ms after focus before flushing. Save looks up
  `current` at click time.

**If Excalidraw changes, recheck:** the storage keys above, that `blur` still
flushes, that the scene is still read from localStorage at page start, and that
the cross-tab sync still finishes within 300 ms of focus. If an untouched drawing
shows "Unsaved changes", diff `data:<id>` against `localStorage["excalidraw"]` to
find the new normalisation.
