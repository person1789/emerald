# Restructure App Hierarchy (Binder > Folders > Pages > Canvas Notes)

The current app loads a single global canvas inside a monolithic namespace. The goal is to restructure this to mirror a Binder layout:
1. **Binder** (the entire Emerald App / vault directory)
2. **Folders** (dividers in the binder that separate pages)
3. **Notebook Pages** (tabs/documents you can open, currently represented as `.md` files)
4. **Canvas Notes** ("sticky notes" placed locally inside a specific Notebook Page)

## Proposed Changes

### 1. State Refactoring (Tabs & Pages)
We will introduce new state specifically tracking the open "tabs" (Notebook Pages) and which one is active.

- Define a `PageData` type holding `notes`, `connections`, and `camera` context.
- Define a `Tab` type wrapping `path`, `title`, `data`, and potentially `isDirty`.
- Replace the monolithic `setNotes`/`setConns` with logic that correctly targets the `activeTab`. If no tab is active, the Canvas will be hidden (showing a placeholder like "Open a page from the sidebar").

### 2. Sidebar Updates (Binder & Folders)
The sidebar will map strictly to your Rust backend directory structure:
- Render nested structures based on the `get_directory_tree` payload.
- Enhance clicking on a file to check if it's already an open tab. If it is, switch to it. If it isn't, open a new tab containing its canvas nodes.
- Add "New Page" actions to the sidebar to add a new Notebook Page properly sorted into the selected Folder.

### 3. Top Tab Bar (Notebook Tab Navigation)
Add a Google Chrome / File Explorer-style tab bar directly above the Canvas window.
- The tab bar will show open workspace pages.
- Tabs denote the `title` of the page.
- They will feature a small "x" button to close the tab.
- Clicking a tab makes it active and swaps the Canvas context (camera, notes, and arrows/connections) to match that page.

### 4. Reading/Saving Persistence
Currently, the Emerald backend provides Rust `save_note` and `read_note` methods. We will use these utilities to build out serialization so pages store their canvas note positions:
- **Load**: On tab open, read the `.md` payload from the path. If it contains parsable Canvas JSON data, initialize the tab `PageData` with it.
- **Save**: When changing the canvas inside the active tab, synchronize those changes into the backend `.md` file (either autosave, or hook into a hotkey system, but autosave/debounced save is best).

## Open Questions

> [!IMPORTANT]
> **Saving Architecture**  
> We currently have Rust functions `save_note` and `read_note` anticipating `.md` files. Is it acceptable to save the Notebook Page internal data (the positions, colors, content of the Sticky Notes) inside the `.md` file as structured JSON data for each page? 
> Alternatively, do you have a specific file extension or custom format in mind for these Notebook Pages?

> [!WARNING]  
> If an older `.md` file in the directory has generic markdown right now, the JSON parser might fail. We will fallback to creating a single sticky note displaying that markdown inside the canvas. Is this fallback behavior acceptable?

## Verification Plan

### Automated Tests
_None available on frontend currently_

### Manual Verification
1. Click the sidebar "New Page" button to see a new page pop up in the file list.
2. Clicking the file should open a new active tab in the central screen.
3. Placing new Canvas Notes and moving the Camera must be isolated per tab.
4. Switching between `test 1` and `test 2` tabs should successfully cache and restore the correct sets of Canvas notes.
5. Restart the UI (via Tauri backend stop/start) entirely to assert that the `.md` JSON save process was persisted to the OS recursively.
