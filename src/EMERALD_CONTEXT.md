# Emerald – Project Context for Google Antigravity

> Drop this file into your Emerald project root and reference it in your first Antigravity agent task.
> It summarises all design decisions, architecture, and feature work from the Claude session that produced the current codebase.

---

## What is Emerald?

Emerald is a desktop note-taking app built with **Tauri + React + TypeScript**.
It is a stripped-down, canvas-first alternative to Obsidian with:
- A freeform sticky-note canvas (pan, zoom, drag, resize)
- Arrows/connections between notes
- A force-directed graph view
- A sidebar file tree backed by the Tauri filesystem API
- A rich-text toolbar

The app is styled entirely in dark-mode with a signature **emerald green (`#2ecc71`)** accent.
Font: **JetBrains Mono** throughout.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Desktop shell | Tauri (Rust backend) |
| UI framework | React 18 + TypeScript |
| Styling | Plain CSS with CSS custom properties |
| State | `useState` / `useRef` (no external state lib) |
| Graph layout | Custom force-directed sim (no D3) |
| File I/O | Tauri `invoke("get_directory_tree")` |
| Build | Vite |

---

## File Structure

```
src/
  App.tsx        ← entire UI (single component file, ~600 lines)
  App.css        ← all styles
src-tauri/
  src/main.rs    ← Tauri commands including get_directory_tree
```

---

## Core Data Structures

```typescript
interface StickyNote {
  id: string;
  title: string;
  content: string;       // innerHTML (rich text)
  x: number;             // world-space position (not screen)
  y: number;
  width: number;
  height: number;
  color: string;         // accent colour e.g. "#2ecc71"
  collapsed: boolean;    // collapse to header-only (40px)
  imageUrl?: string;     // base64 embedded image
}

interface Connection {
  id: string;
  fromId: string;
  fromSide: "top" | "bottom" | "left" | "right";
  toId: string;
  toSide: "top" | "bottom" | "left" | "right";
  type: "straight" | "bezier";
  style: "solid" | "dashed";
  isDoubleHeaded: boolean;
  color: string;
  label?: string;
}
```

---

## Camera / Coordinate System

**All note positions are stored in world-space coordinates.**
The camera transform (`translate + scale`) is applied only at render time via a CSS `transform` on two sibling elements:

```tsx
const tf = `translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})`;

<svg   className="snap-layer"    style={{ transform: tf, transformOrigin: "0 0" }} />
<div   className="canvas-content" style={{ transform: tf, transformOrigin: "0 0" }} />
```

Converting screen → world:
```typescript
const { wx, wy } = {
  wx: (screenX - rect.left - camera.x) / camera.zoom,
  wy: (screenY - rect.top  - camera.y) / camera.zoom,
};
```

**Never use `getBoundingClientRect()` on note elements for arrow math** — always use the stored `note.x / note.y` world coordinates.

---

## Arrow / Snap-Point Architecture

### The snap-point CSS fix (critical — do not revert)

Snap points are centered on note edges using:
```css
.snap-point { transform: translate(-50%, -50%); }
.snap-point.top    { top: 0;    left: 50%; }
.snap-point.bottom { top: 100%; left: 50%; }
.snap-point.left   { top: 50%;  left: 0;   }
.snap-point.right  { top: 50%;  left: 100%;}
```
`margin: -6px` must NOT be used — it breaks when the parent has padding.
`box-sizing: border-box` is set globally so `left: 100%` = right border edge.

### SVG layer
The SVG snap-layer uses `width: 1px; height: 1px; overflow: visible` so it is a zero-size origin point and all paths overflow freely into world-space without clipping.

### getSnapPoint
```typescript
function getSnapPoint(note: StickyNote, side: string) {
  const h = note.collapsed ? COLLAPSED_H : note.height;
  switch (side) {
    case "top":    return { x: note.x + note.width / 2, y: note.y };
    case "bottom": return { x: note.x + note.width / 2, y: note.y + h };
    case "left":   return { x: note.x,                  y: note.y + h / 2 };
    case "right":  return { x: note.x + note.width,     y: note.y + h / 2 };
  }
}
```
Collapsed notes use `COLLAPSED_H = 40` instead of `note.height`.

### Bezier paths
Control points offset perpendicular to the exit side:
```typescript
function ctrlOff(side: string, mag = 90) {
  // right → dx=+mag, left → dx=-mag, bottom → dy=+mag, top → dy=-mag
}
// Path: M s C s+sc, e+ec, e
```

---

## Graph View

Pure TypeScript force-directed simulation — **no D3 dependency**.

Algorithm:
1. **Repulsion**: O(n²) inverse-square between all node pairs
2. **Attraction**: Spring force along edges toward target distance 110px
3. **Gravity**: Weak pull toward SVG centre
4. **Integration**: Semi-implicit Euler, 140 iterations, alpha decay

The graph has its own independent camera (pan + scroll-zoom).
Clicking a node calls `focusNote(id)` which flies the main canvas camera to centre that note:
```typescript
setCamera({ zoom: 1, x: rect.width/2 - (note.x + note.width/2), y: rect.height/2 - (note.y + note.height/2) });
```

---

## Features Implemented

### Phase 1 – Core
- [x] Freeform canvas: drag notes, pan (left-click drag on empty space or middle mouse), scroll-to-zoom anchored on cursor
- [x] Create note: right-click → context menu
- [x] Delete note: context menu (also removes connected arrows)
- [x] Rename note: double-click header or context menu
- [x] Resize: edge handles + bottom-right corner drag
- [x] Sidebar file tree from Tauri with expand/collapse
- [x] Canvas notes listed in sidebar with click-to-focus
- [x] Reset view button (⌂)

### Phase 2 – Canvas Polish
- [x] Collapse/expand note to header bar (40px)
- [x] Per-note accent colour (6 colours, picker in header)
- [x] CSS variable `--nc` propagates colour to corner, border, snap points, graph node
- [x] Embedded image (file picker → base64 → stored in note.imageUrl)
- [x] Edge labels (click T in arrow submenu → inline foreignObject input)
- [x] Fat 14px invisible hit target on arrows for easy clicking

### Phase 3 – Graph View
- [x] Force-directed layout (pure TS, no deps)
- [x] Independent zoom/pan camera inside graph panel
- [x] Hover reveals node name in accent colour + outer ring
- [x] Click node → main canvas flies to that note
- [x] Graph edges coloured by connection colour

### Phase 4 – Editor
- [x] Bold, Italic, Underline (execCommand)
- [x] Strikethrough
- [x] Inline code (`<code class="ic">`) styled with emerald palette
- [x] Font size A− / A+ (renders as inline `font-size` px via font[size=7] trick)
- [x] Bullet list / Numbered list
- [x] 6-colour text colour swatches (shared with arrow colour)
- [x] Link insert (prompt for URL → execCommand createLink)
- [x] Image embed (toolbar button → file input)
- [x] Delete key removes selected arrow when no note is active
- [x] ESC cancels arrow drawing / closes pickers everywhere

---

## Known Gaps / Next Steps

- [ ] **Persistence** — notes and connections live only in React state; need Tauri commands to save/load a vault JSON or per-note markdown files
- [ ] **Markdown render mode** — toggle between edit (contenteditable) and rendered markdown view
- [ ] **Search** — full-text search across note titles and content
- [ ] **Tags** — frontmatter-style tags shown in sidebar and graph
- [ ] **Note linking** — `[[WikiLink]]` syntax that creates a connection automatically
- [ ] **Multiple vaults** — vault switcher in sidebar header
- [ ] **Keyboard shortcuts** — `N` = new note, `A` = arrow tool, `Esc` = deselect, `Ctrl+Z` = undo
- [ ] **Undo/redo** — `useReducer`-based history stack
- [ ] **Export** — save canvas as PNG / export notes as markdown files

---

## CSS Variables Reference

```css
--bg-sidebar:   #080808
--bg-canvas:    #0c0c0c
--bg-sticky:    #111111
--bg-toolbar:   #0e0e0e
--emerald:      #2ecc71
--emerald-dim:  rgba(46,204,113,0.10)
--emerald-glow: rgba(46,204,113,0.30)
--text:         #c8c9ca
--text-muted:   #3e3e3e
--border:       #1a1a1a
--border-hi:    #252525
--nc:           (per-note, set via inline style on .sticky-note)
```

---

## Tauri Backend

One command is currently used:
```rust
// src-tauri/src/main.rs
#[tauri::command]
fn get_directory_tree(/* vault path */) -> Vec<FileNode> { ... }
```

`FileNode` matches the TypeScript interface:
```typescript
interface FileNode { name: string; is_dir: boolean; children?: FileNode[]; }
```

---

## Suggested First Antigravity Task

```
Add persistence to Emerald.

Currently all notes and connections exist only in React state and are lost on reload.

Implement:
1. A Tauri command `save_canvas(data: CanvasData)` that writes a JSON file
   (`.emerald/canvas.json`) inside the vault directory.
2. A Tauri command `load_canvas()` that reads and returns that file on startup.
3. Auto-save: debounce 1 second after any note or connection change.
4. Show a small "saved" indicator in the toolbar that fades out after 1.5s.

CanvasData shape:
{
  notes: StickyNote[],
  connections: Connection[]
}

Keep all existing types exactly as defined in App.tsx.
```
