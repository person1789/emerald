# Power-User Features Implementation Plan

This plan details the implementation of the 5 remaining core features requested for Emerald to transition it from an MVP into a fully-featured, downloadable application. Because `App.tsx` is already ~1,500 lines long, we will carefully integrate these without dramatically breaking the existing canvas math.

## User Review Required

> [!WARNING]  
> Transitioning to **Markdown Render Mode** will require a slight change to how text is stored. Currently, Emerald uses `contenteditable` rich text HTML. We will add a dependency (`marked` and `turndown`) to convert your existing HTML notes into Markdown and parse them.
> 
> **Are you okay with adding the following NPM dependencies?**
> - `marked` (for rendering Markdown)
> - `turndown` (for converting existing HTML notes to Markdown)
> - `html-to-image` (for downloading the canvas as a PNG)

## Proposed Changes

---

### Phase 1: Undo / Redo

We will introduce a history stack to track changes to the `PageData` (notes and connections) for the currently active tab.
- **History Hook**: Implement a custom `useHistory` or local state array holding `[past, present, future]` states.
- **Actions**: Push to the history stack on major actions (drag end, note create, text blur, connection create/delete).
- **Shortcuts**: Bind `Ctrl+Z` to Undo and `Ctrl+Shift+Z` / `Ctrl+Y` to Redo.
- **UI**: Add small Undo/Redo arrows in the top toolbar.

---

### Phase 2: Image Export

- Add `html-to-image` via `npm install html-to-image`.
- Add an "Export Canvas (.png)" button to the sidebar toolbar.
- When clicked, we temporarily reset the camera's zoom and coordinates, measure the bounding box of all notes to get the maximum width/height, capture the `.canvas-content` layer via `html-to-image`, and trigger a download of the `canvas.png`.

---

### Phase 3: Global Search

- **Backend**: Add a new Rust command `search_notes(query)` that recursively reads `.md`/JSON note files in the Tauri vault directory and searches for the text query in titles and contents.
- **Frontend Panel**: Add a floating Search modal (Cmd/Ctrl+F or Cmd/Ctrl+P).
- **Functionality**: Clicking a search result will open that file in a new Tab (if not already open) and fly the camera to the specific matching note.

---

### Phase 4: Tags and WikiLinking

- **WikiLinking (`[[Note Title]]`)**:
  - We will watch keystrokes or `onBlur` for text matching `[[Target Note]]`.
  - When detected, the app will instantly create a visually dashed `Connection` line from the current note pointing dynamically to the "Target Note" (creating the target note automatically if it doesn't exist).
- **Tags**:
  - Detect `#tag` syntax via Regex in the note contents.
  - Render a small Tags list in the sidebar below the file tree, allowing you to click a tag to filter the Global Search to just nodes matching that tag.

---

### Phase 5: Markdown Render Mode

- Store raw markdown inside the note's `.content` field moving forward (using `turndown` to convert any legacy rich text on the first load).
- **Edit Mode vs Render Mode**:
  - Double-clicking a note enters **Edit Mode** (a raw `textarea` to edit markdown).
  - Clicking away enters **Render Mode** (passing the text to `marked` and rendering read-only HTML).
  - Provide a global toggle in the toolbar to lock the canvas in Render Mode vs Edit Mode universally.

## Open Questions

1. Do you want the canvas to automatically generate a brand new Sticky Note when you type `[[New Note]]` if "New Note" doesn't exist yet, or should it only link to existing notes?
2. Do you have any preference for the shortcut keys? (Standard is Ctrl+Z and Ctrl+Shift+F for global search, etc.)
3. Are you ready for me to install the required NPM dependencies (`marked`, `turndown`, `html-to-image`) and begin Phase 1?
