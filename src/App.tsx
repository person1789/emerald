import React, {
  useState, useEffect, useRef, useCallback,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { MediaMiniPlayer } from "./MediaMiniPlayer";
import "./App.css";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StickyNote {
  id: string;
  title: string;
  content: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  collapsed: boolean;
  imageUrl?: string;
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

interface FileNode {
  name: string;
  is_dir: boolean;
  children?: FileNode[];
}

// ─── Stage 1: PageData & Tab types ───────────────────────────────────────────

interface PageData {
  notes: StickyNote[];
  connections: Connection[];
  camera: { x: number; y: number; zoom: number };
}

interface Tab {
  id: string;          // unique tab id (matches file path)
  path: string;        // relative path like "folder/page.md"
  title: string;       // display name (filename without .md)
  data: PageData;
  isDirty: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const NOTE_COLORS = [
  "#2ecc71", "#e74c3c", "#3498db", "#f39c12", "#9b59b6", "#ffffff",
];

const COLLAPSED_H = 40;

const defaultPageData = (): PageData => ({
  notes: [],
  connections: [],
  camera: { x: 0, y: 0, zoom: 1 },
});

// ─── Utilities ────────────────────────────────────────────────────────────────

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function getNextName(nodes: FileNode[], prefix: string, extension: string): string {
  let max = 0;
  const scan = (children: FileNode[]) => {
    for (const node of children) {
      if (node.name.startsWith(prefix)) {
        const nameWithoutExt = node.is_dir ? node.name : node.name.replace(/\.md$/, "");
        const numPart = nameWithoutExt.substring(prefix.length).trim();
        const num = parseInt(numPart, 10);
        if (!isNaN(num) && num > max) max = num;
      }
      if (node.is_dir && node.children) scan(node.children);
    }
  };
  scan(nodes);
  return `${prefix} ${max + 1}${extension}`;
}

function getSnapPoint(note: StickyNote, side: string) {
  const h = note.collapsed ? COLLAPSED_H : note.height;
  switch (side) {
    case "top": return { x: note.x + note.width / 2, y: note.y };
    case "bottom": return { x: note.x + note.width / 2, y: note.y + h };
    case "left": return { x: note.x, y: note.y + h / 2 };
    case "right": return { x: note.x + note.width, y: note.y + h / 2 };
    default: return { x: note.x, y: note.y };
  }
}

function ctrlOff(side: string, mag = 90) {
  switch (side) {
    case "right": return { dx: mag, dy: 0 };
    case "left": return { dx: -mag, dy: 0 };
    case "bottom": return { dx: 0, dy: mag };
    case "top": return { dx: 0, dy: -mag };
    default: return { dx: 0, dy: 0 };
  }
}

// ─── Types & Definitions for Hierarchical Graph ──────────────────────────────
export interface GraphNode {
  id: string;      // Unique path or ID
  title: string;   // Label text
  color: string;   // Node color
  type: "root" | "folder" | "page" | "note";
  isCenter?: boolean;
}

export interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  color: string;
  isTransparentGray?: boolean;
}

interface FNode { id: string; x: number; y: number; vx: number; vy: number; isCenter?: boolean; }

// ─── GraphView (Live Animated Organic Layout) ─────────────────────────────────

function GraphView({
  nodes, edges, onNodeClick,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick: (id: string, type: "root" | "folder" | "page" | "note") => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const simNodes = useRef<Record<string, FNode>>({});
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const [gc, setGc] = useState({ x: 0, y: 0, zoom: 1 });
  const [panning, setPanning] = useState(false);
  const [hov, setHov] = useState<string | null>(null);

  // Sync nodes into simulation state
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const W = el.clientWidth || 500;
    const H = el.clientHeight || 180;

    nodes.forEach((n) => {
      if (!simNodes.current[n.id]) {
        // Spawn them clustered near the center
        const spawnCenter = Object.values(simNodes.current).find(node => node.isCenter);
        const startX = spawnCenter ? spawnCenter.x : W / 2;
        const startY = spawnCenter ? spawnCenter.y : H / 2;

        simNodes.current[n.id] = {
          id: n.id,
          x: startX + (Math.random() - 0.5) * 60,
          y: startY + (Math.random() - 0.5) * 60,
          vx: 0, vy: 0,
          isCenter: n.isCenter
        };
      } else {
        simNodes.current[n.id].isCenter = n.isCenter;
      }
    });

    const curIds = new Set(nodes.map(n => n.id));
    for (const key in simNodes.current) {
      if (!curIds.has(key)) delete simNodes.current[key];
    }
  }, [nodes]);

  // Physics animation loop
  useEffect(() => {
    let req: number;
    const tick = () => {
      const el = svgRef.current;
      if (!el) return;
      const W = el.clientWidth || 500;
      const H = el.clientHeight || 180;

      const m = simNodes.current;
      const ids = Object.keys(m);
      // Repulsion
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const A = m[ids[i]]; const B = m[ids[j]];
          const dx = B.x - A.x; const dy = B.y - A.y;
          const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
          const f = 4000 / (d * d);
          A.vx -= dx / d * f; A.vy -= dy / d * f;
          B.vx += dx / d * f; B.vy += dy / d * f;
        }
      }
      // Spring attraction (edges)
      edges.forEach(e => {
        const A = m[e.fromId]; const B = m[e.toId];
        if (!A || !B) return;
        const dx = B.x - A.x; const dy = B.y - A.y;
        const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const targetD = e.isTransparentGray ? 90 : 120;
        const f = (d - targetD) * 0.05;
        A.vx += dx / d * f; A.vy += dy / d * f;
        B.vx -= dx / d * f; B.vy -= dy / d * f;
      });

      Object.values(m).forEach(n => {
        // Organic jitter (subtle floating)
        n.vx += (Math.random() - 0.5) * 0.3;
        n.vy += (Math.random() - 0.5) * 0.3;

        // Slight global gravity
        n.vx += (W / 2 - n.x) * 0.003;
        n.vy += (H / 2 - n.y) * 0.003;

        // Stronger gravity for central nodes
        if (n.isCenter) {
          n.vx += (W / 2 - n.x) * 0.02;
          n.vy += (H / 2 - n.y) * 0.02;
        }

        // Limit physics explosion velocities
        n.x += n.vx; n.y += n.vy;
        n.vx = Math.max(-12, Math.min(12, n.vx * 0.82));
        n.vy = Math.max(-12, Math.min(12, n.vy * 0.82));
        n.x = Math.max(16, Math.min(W - 16, n.x));
        n.y = Math.max(16, Math.min(H - 16, n.y));
      });

      const out: Record<string, { x: number, y: number }> = {};
      ids.forEach(id => { out[id] = { x: m[id].x, y: m[id].y }; });
      setPos(out);

      req = requestAnimationFrame(tick);
    };
    req = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(req);
  }, [edges]);

  const gt = `translate(${gc.x}px,${gc.y}px) scale(${gc.zoom})`;

  return (
    <svg ref={svgRef} width="100%" height="100%" style={{ display: "block", cursor: panning ? "grabbing" : "grab" }}
      onMouseDown={() => setPanning(true)}
      onMouseUp={() => setPanning(false)}
      onMouseLeave={() => setPanning(false)}
      onMouseMove={(e) => { if (panning) setGc((p) => ({ ...p, x: p.x + e.movementX, y: p.y + e.movementY })); }}
      onWheel={(e) => {
        e.stopPropagation();
        const rect = svgRef.current!.getBoundingClientRect();
        const mx = e.clientX - rect.left; const my = e.clientY - rect.top;
        const factor = 1 - e.deltaY * 0.002;
        setGc((p) => {
          const nz = Math.min(Math.max(p.zoom * factor, 0.2), 8);
          return { zoom: nz, x: mx - (mx - p.x) * (nz / p.zoom), y: my - (my - p.y) * (nz / p.zoom) };
        });
      }}
    >
      <defs>
        <marker id="garrow" markerWidth="5" markerHeight="4" refX="4" refY="2" orient="auto" markerUnits="strokeWidth">
          <polygon points="0 0,5 2,0 4" fill="#666" opacity="0.6" />
        </marker>
      </defs>
      <g style={{ transform: gt, transformOrigin: "0 0" }}>
        {edges.map((c) => {
          const f = pos[c.fromId]; const t = pos[c.toId];
          if (!f || !t) return null;
          return <line key={c.id} x1={f.x} y1={f.y} x2={t.x} y2={t.y}
            stroke={c.color} strokeWidth={c.isTransparentGray ? "1.5" : "1.5"}
            strokeOpacity={c.isTransparentGray ? "0.2" : "0.5"}
            markerEnd={c.isTransparentGray ? undefined : "url(#garrow)"} />;
        })}
        {nodes.map((n) => {
          const p = pos[n.id]; if (!p) return null;
          const h = hov === n.id;

          let baseR = 10;
          if (n.isCenter) {
            baseR = 15;
          } else if (n.type === "note") {
            baseR = 7;
          } else {
            baseR = 10;
          }

          const r = h ? baseR * 1.4 : baseR;

          return (
            <g key={n.id} style={{ cursor: "pointer" }}
              onClick={() => onNodeClick(n.id, n.type)}
              onMouseEnter={() => setHov(n.id)}
              onMouseLeave={() => setHov(null)}
            >
              {h && <circle cx={p.x} cy={p.y} r={r * 1.8} fill="none"
                stroke={n.color} strokeWidth="0.5" strokeOpacity="0.35" />}
              <circle cx={p.x} cy={p.y} r={r}
                fill="#0d0d0d" stroke={n.color} strokeWidth={h ? 2.5 : 1.8}
                style={{ transition: "r 0.12s" }} />
              <text x={p.x} y={p.y + Math.max(r + 12, 16)} textAnchor="middle"
                fill={h ? n.color : "#999"} fontSize={n.type === "root" || n.type === "folder" ? "10" : "8"}
                fontFamily="'JetBrains Mono',monospace"
                style={{ transition: "fill 0.12s", pointerEvents: "none" }}>
                {n.title.slice(0, n.isCenter ? 30 : 20)}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

// ─── Stage 2: FileTree (folder-aware, opens tabs, highlights active path) ────

function FileTree({
  nodes,
  depth = 0,
  activeTabPath,
  openTabPaths,
  onOpenFile,
  onOpenFolder,
  parentPath = "",
  renamingFilePath,
  onRenameStart,
  onRenameCommit,
  onFileContextMenu,
  draggedPath,
  setDraggedPath,
  onItemDrop,
}: {
  nodes: FileNode[];
  depth?: number;
  activeTabPath: string | null;
  openTabPaths: Set<string>;
  onOpenFile: (path: string, name: string) => void;
  onOpenFolder?: (path: string) => void;
  parentPath?: string;
  renamingFilePath?: string | null;
  onRenameStart?: (path: string) => void;
  onRenameCommit?: (oldPath: string, newName: string) => void;
  onFileContextMenu?: (e: React.MouseEvent, path: string, name: string, is_dir: boolean) => void;
  draggedPath?: string | null;
  setDraggedPath?: (path: string | null) => void;
  onItemDrop?: (sourcePath: string, targetDirPath: string) => void;
}) {
  const [col, setCol] = useState<Record<string, boolean>>({});

  return (
    <div className={depth > 0 ? "indent" : ""}>
      {nodes.map((node) => {
        const fullPath = parentPath ? `${parentPath}/${node.name}` : node.name;
        const isActive = !node.is_dir && activeTabPath === fullPath;
        const isOpen = !node.is_dir && openTabPaths.has(fullPath);
        const isRenaming = fullPath === renamingFilePath;

        return (
          <div key={fullPath}>
            <div
              draggable={!isRenaming}
              onDragStart={(e) => {
                e.stopPropagation();
                if (setDraggedPath) setDraggedPath(fullPath);
                e.dataTransfer.setData("text/plain", fullPath);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (node.is_dir) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  e.currentTarget.classList.add("drag-over");
                }
              }}
              onDragLeave={(e) => {
                if (node.is_dir) {
                  e.currentTarget.classList.remove("drag-over");
                }
              }}
              onDrop={(e) => {
                if (node.is_dir) {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.classList.remove("drag-over");
                  if (draggedPath && draggedPath !== fullPath && !draggedPath.startsWith(fullPath + "/")) {
                    if (onItemDrop) onItemDrop(draggedPath, fullPath);
                  }
                  if (setDraggedPath) setDraggedPath(null);
                }
              }}
              className={`file-item${node.is_dir ? " folder-item" : ""}${isActive ? " active" : ""}${isOpen && !isActive ? " open-tab" : ""}`}
              style={{ paddingLeft: `${15 + depth * 12}px` }}
              onClick={() => {
                if (isRenaming) return;
                if (node.is_dir) {
                  setCol((p) => ({ ...p, [fullPath]: !p[fullPath] }));
                  if (onOpenFolder) onOpenFolder(fullPath);
                } else {
                  onOpenFile(fullPath, node.name);
                }
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (onRenameStart && !isRenaming) onRenameStart(fullPath);
              }}
              onContextMenu={(e) => {
                if (onFileContextMenu && !isRenaming) {
                  e.preventDefault();
                  e.stopPropagation();
                  onFileContextMenu(e, fullPath, node.name, node.is_dir);
                }
              }}
            >
              <span className="file-icon">
                {node.is_dir
                  ? (col[fullPath] ? "▶" : "▾")
                  : (isOpen ? "◉" : "◈")}
              </span>
              {isRenaming ? (
                <input
                  autoFocus
                  defaultValue={node.name.replace(/\.md$/, "")}
                  className="rename-input"
                  onBlur={(e) => {
                    let newName = e.target.value.trim();
                    if (newName && newName !== node.name.replace(/\.md$/, "")) {
                      if (!node.is_dir && !newName.endsWith(".md")) {
                        newName += ".md";
                      }
                      onRenameCommit?.(fullPath, newName);
                    } else {
                      onRenameCommit?.(fullPath, node.name);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    } else if (e.key === 'Escape') {
                      onRenameCommit?.(fullPath, node.name);
                    }
                  }}
                />
              ) : (
                <span className="file-name">{node.name.replace(/\.md$/, "")}</span>
              )}
              {isOpen && !isActive && <span className="tab-open-dot" />}
            </div>
            {node.is_dir && !col[fullPath] && node.children && (
              <FileTree
                nodes={node.children}
                depth={depth + 1}
                activeTabPath={activeTabPath}
                openTabPaths={openTabPaths}
                onOpenFile={onOpenFile}
                onOpenFolder={onOpenFolder}
                parentPath={fullPath}
                renamingFilePath={renamingFilePath}
                onRenameStart={onRenameStart}
                onRenameCommit={onRenameCommit}
                onFileContextMenu={onFileContextMenu}
                draggedPath={draggedPath}
                setDraggedPath={setDraggedPath}
                onItemDrop={onItemDrop}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Stage 3: TabBar ─────────────────────────────────────────────────────────

function TabBar({
  tabs,
  activeTabId,
  onSwitch,
  onClose,
}: {
  tabs: Tab[];
  activeTabId: string | null;
  onSwitch: (id: string) => void;
  onClose: (id: string, e: React.MouseEvent) => void;
}) {
  if (tabs.length === 0) return null;

  return (
    <div className="tab-bar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab-item${tab.id === activeTabId ? " active" : ""}${tab.isDirty ? " dirty" : ""}`}
          onClick={() => onSwitch(tab.id)}
        >
          <span className="tab-icon">◈</span>
          <span className="tab-title">{tab.title}</span>
          {tab.isDirty && <span className="tab-dirty-dot" />}
          <button
            className="tab-close"
            onClick={(e) => onClose(tab.id, e)}
            title="Close tab"
          >×</button>
        </div>
      ))}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [vaultName] = useState("EMERALD");

  // ── Stage 1: Tab state ────────────────────────────────────────────────────
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const notes = activeTab?.data.notes ?? [];
  const connections = activeTab?.data.connections ?? [];
  const camera = activeTab?.data.camera ?? { x: 0, y: 0, zoom: 1 };

  // ── Per-canvas UI state (reset when switching tabs) ───────────────────────
  const [activeId, setActiveId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [selConnId, setSelConnId] = useState<string | null>(null);
  const [arrowTool, setArrowTool] = useState(false);
  const [editLabel, setEditLabel] = useState<string | null>(null);
  const [showColorPicker, setShowCP] = useState(false);

  const [sidebarW, setSidebarW] = useState(220);
  const [graphH, setGraphH] = useState(220);
  const [panning, setPanning] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [resizing, setResizing] = useState<{ id: string; edge: string } | null>(null);

  const [drawFrom, setDrawFrom] = useState<{ id: string; side: string; wx: number; wy: number } | null>(null);
  const [tempEnd, setTempEnd] = useState<{ wx: number; wy: number } | null>(null);

  const [fmts, setFmts] = useState<string[]>([]);
  const [fontSize, setFontSize] = useState(14);
  const [activeColor, setActiveColor] = useState("#2ecc71");

  const [menu, setMenu] = useState({ x: 0, y: 0, visible: false, target: "", type: "space" as "space" | "sticky" });
  const [fileMenu, setFileMenu] = useState({ visible: false, x: 0, y: 0, path: "", name: "", isDir: false });
  const [renamingFilePath, setRenamingFilePath] = useState<string | null>(null);
  const [treeDraggedPath, setTreeDraggedPath] = useState<string | null>(null);

  // ── Graph Hierarchy State ──────────────────────────────────────────────────
  const [graphHistory, setGraphHistory] = useState<string[]>([""]);
  const [graphHistoryIdx, setGraphHistoryIdx] = useState<number>(0);
  const currentGraphContext = graphHistory[graphHistoryIdx] ?? "";

  const canvasRef = useRef<HTMLDivElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);

  const fetchTree = useCallback(async () => {
    try {
      const d = await invoke("get_directory_tree");
      setTree(d as FileNode[]);
    } catch (err) { console.error(err); }
  }, []);

  // ── Load directory tree ──────────────────────────────────────────────────
  useEffect(() => {
    fetchTree();
  }, [fetchTree]);

  // Sync graph history with active tool context
  const getChildrenOfPath = useCallback((tNodes: FileNode[], parts: string[]): FileNode[] | null => {
    if (parts.length === 0 || (parts.length === 1 && parts[0] === "")) return tNodes;
    const target = tNodes.find(n => n.name === parts[0]);
    if (!target || !target.is_dir || !target.children) return null;
    return getChildrenOfPath(target.children, parts.slice(1));
  }, []);

  const buildGraphData = useCallback(() => {
    let gNodes: GraphNode[] = [];
    let gEdges: GraphEdge[] = [];
    const cp = currentGraphContext;

    if (cp === "" || (!cp.endsWith(".md") && !getChildrenOfPath(tree, cp.split('/')))) {
      gNodes.push({ id: "ROOT", title: vaultName, color: "#2ecc71", isCenter: true, type: "root" }); // Emerald is Green
      tree.forEach(child => {
        gNodes.push({ id: child.name, title: child.name.replace(/\.md$/, ""), color: child.is_dir ? "#ffffff" : "#3498db", type: child.is_dir ? "folder" : "page" });
        gEdges.push({ id: `e-${child.name}`, fromId: "ROOT", toId: child.name, color: "#666", isTransparentGray: true });
      });
    } else if (cp.endsWith(".md")) {
      const safeNotes = cp === activeTabId ? notes : [];
      const safeConns = cp === activeTabId ? connections : [];

      gNodes.push({ id: cp, title: cp.split("/").pop()!.replace(/\.md$/, ""), color: "#3498db", isCenter: true, type: "page" });
      safeNotes.forEach(n => {
        gNodes.push({ id: n.id, title: n.title, color: n.color, type: "note" });
        gEdges.push({ id: `e-${n.id}`, fromId: cp, toId: n.id, color: "#666", isTransparentGray: true });
      });
      safeConns.forEach(c => {
        gEdges.push({ id: c.id, fromId: c.fromId, toId: c.toId, color: c.color, isTransparentGray: false });
      });
    } else {
      const children = getChildrenOfPath(tree, cp.split('/'));
      gNodes.push({ id: cp, title: cp.split("/").pop() || cp, color: "#ffffff", isCenter: true, type: "folder" });
      if (children) {
        children.forEach(child => {
          const full = `${cp}/${child.name}`;
          gNodes.push({ id: full, title: child.name.replace(/\.md$/, ""), color: child.is_dir ? "#ffffff" : "#3498db", type: child.is_dir ? "folder" : "page" });
          gEdges.push({ id: `e-${full}`, fromId: cp, toId: full, color: "#666", isTransparentGray: true });
        });
      }
    }
    return { gNodes, gEdges };
  }, [currentGraphContext, tree, activeTabId, notes, connections, vaultName, getChildrenOfPath]);

  const { gNodes, gEdges } = buildGraphData();

  const handleGraphNodeClick = (id: string, type: string) => {
    if (type === "note") {
      focusNote(id);
    } else if (type === "folder") {
      if (id !== "ROOT" && id !== currentGraphContext) {
        setGraphHistory(prev => { const n = prev.slice(0, graphHistoryIdx + 1); n.push(id); return n; });
        setGraphHistoryIdx(prev => prev + 1);
      } else if (id === "ROOT") {
        setGraphHistory(prev => { const n = prev.slice(0, graphHistoryIdx + 1); n.push(""); return n; });
        setGraphHistoryIdx(prev => prev + 1);
      }
    } else if (type === "page") {
      if (id !== currentGraphContext) {
        openOrSwitchTab(id, id.split('/').pop() || id);
        setGraphHistory(prev => { const n = prev.slice(0, graphHistoryIdx + 1); n.push(id); return n; });
        setGraphHistoryIdx(prev => prev + 1);
      }
    }
  };

  const handleItemDrop = async (sourcePath: string, targetDirPath: string) => {
    const sourceParts = sourcePath.split("/");
    const sourceName = sourceParts.pop() || "";
    const srcDir = sourceParts.length > 0 ? sourceParts.join("/") : "";
    if (srcDir === targetDirPath) return;

    const newPath = targetDirPath ? `${targetDirPath}/${sourceName}` : sourceName;
    try {
      await invoke("rename_item", { oldPath: sourcePath, newPath });
      await fetchTree();

      if (sourcePath.endsWith(".md")) {
        setTabs((prev) => prev.map(t => t.path === sourcePath ? { ...t, path: newPath, id: newPath } : t));
        if (activeTabId === sourcePath) setActiveTabId(newPath);
      } else {
        setTabs((prev) => prev.map(t => {
          if (t.path.startsWith(sourcePath + "/")) {
            const updatedPath = t.path.replace(sourcePath, newPath);
            return { ...t, path: updatedPath, id: updatedPath };
          }
          return t;
        }));
        if (activeTabId?.startsWith(sourcePath + "/")) {
          setActiveTabId(activeTabId.replace(sourcePath, newPath));
        }
      }
    } catch (err) {
      console.error("Move failed", err);
    }
  };

  const handleRenameCommit = async (oldPath: string, newName: string) => {
    setRenamingFilePath(null);
    const oldParts = oldPath.split("/");
    const oldName = oldParts.pop() || "";
    if (oldName === newName) return;

    const newPath = oldParts.length > 0 ? `${oldParts.join("/")}/${newName}` : newName;
    try {
      await invoke("rename_item", { oldPath, newPath });
      await fetchTree();

      if (oldPath.endsWith(".md")) {
        setTabs((prev) => prev.map(t => t.path === oldPath ? { ...t, path: newPath, id: newPath, title: newName.replace(/\.md$/, "") } : t));
        if (activeTabId === oldPath) setActiveTabId(newPath);
      } else {
        setTabs((prev) => prev.map(t => {
          if (t.path.startsWith(oldPath + "/")) {
            const updatedPath = t.path.replace(oldPath, newPath);
            return { ...t, path: updatedPath, id: updatedPath };
          }
          return t;
        }));
        if (activeTabId?.startsWith(oldPath + "/")) {
          setActiveTabId(activeTabId.replace(oldPath, newPath));
        }
      }
    } catch (err) {
      console.error("Rename failed", err);
    }
  };

  const handleDeleteItem = async (path: string) => {
    try {
      await invoke("delete_item", { path });
      await fetchTree();
      setTabs((prev) => {
        const next = prev.filter((t) => !t.path.startsWith(path) && t.path !== path);
        if (activeTabId === path || activeTabId?.startsWith(path + "/")) {
          setActiveTabId(next.length > 0 ? next[0].id : null);
        }
        return next;
      });
    } catch (err) {
      console.error("Delete failed", err);
    }
  };

  // ── Helpers to update the active tab's PageData ───────────────────────────
  const setNotes = useCallback((fn: (n: StickyNote[]) => StickyNote[]) => {
    setTabs((prev) => prev.map((t) =>
      t.id === activeTabId
        ? { ...t, isDirty: true, data: { ...t.data, notes: fn(t.data.notes) } }
        : t
    ));
  }, [activeTabId]);

  const setConns = useCallback((fn: (c: Connection[]) => Connection[]) => {
    setTabs((prev) => prev.map((t) =>
      t.id === activeTabId
        ? { ...t, isDirty: true, data: { ...t.data, connections: fn(t.data.connections) } }
        : t
    ));
  }, [activeTabId]);

  const setCamera = useCallback((fn: ((c: { x: number; y: number; zoom: number }) => { x: number; y: number; zoom: number }) | { x: number; y: number; zoom: number }) => {
    setTabs((prev) => prev.map((t) => {
      if (t.id !== activeTabId) return t;
      const next = typeof fn === "function" ? fn(t.data.camera) : fn;
      return { ...t, data: { ...t.data, camera: next } };
    }));
  }, [activeTabId]);

  // ── Stage 2: Open / switch tabs ──────────────────────────────────────────
  const openTabPaths = new Set(tabs.map((t) => t.path));

  const openOrSwitchTab = useCallback((path: string, name: string) => {
    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      setActiveTabId(existing.id);
    } else {
      const title = name.replace(/\.md$/, "");
      const newTab: Tab = {
        id: path,
        path,
        title,
        data: defaultPageData(),
        isDirty: false,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(path);
    }
    // Reset per-canvas UI on tab switch
    setActiveId(null);
    setRenamingId(null);
    setSelConnId(null);
    setDrawFrom(null);
    setTempEnd(null);
    setArrowTool(false);
    setShowCP(false);
    setEditLabel(null);
  }, [tabs]);

  const switchTab = useCallback((id: string) => {
    setActiveTabId(id);
    setActiveId(null);
    setRenamingId(null);
    setSelConnId(null);
    setDrawFrom(null);
    setTempEnd(null);
    setArrowTool(false);
    setShowCP(false);
    setEditLabel(null);
  }, []);

  const closeTab = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (activeTabId === id) {
        const sibling = next[Math.min(idx, next.length - 1)];
        setActiveTabId(sibling?.id ?? null);
      }
      return next;
    });
  }, [activeTabId]);

  // ── Create a new page file ────────────────────────────────────────────────
  const createNewPage = async (folderPath?: string) => {
    const title = getNextName(tree, "Page", "");
    const filename = `${title}.md`;
    const path = folderPath ? `${folderPath}/${filename}` : filename;
    try {
      await invoke("save_note", { path, content: "" });
      // Refresh tree
      const d = await invoke("get_directory_tree");
      setTree(d as FileNode[]);
      openOrSwitchTab(path, filename);
    } catch (err) {
      console.error(err);
    }
  };

  // ── Global keys ──────────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setDrawFrom(null); setTempEnd(null); setShowCP(false); setEditLabel(null); }
      if ((e.key === "Delete" || e.key === "Backspace") && selConnId && !activeId) {
        setConns((p) => p.filter((c) => c.id !== selConnId));
        setSelConnId(null);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [selConnId, activeId, setConns]);

  // ── Wheel zoom ────────────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e: WheelEvent) => {
      if (!activeTab) return;
      if (renamingId) return;
      e.preventDefault();
      const rect = canvasRef.current?.getBoundingClientRect(); if (!rect) return;
      const factor = 1 - e.deltaY * 0.0015;
      const nz = Math.min(Math.max(camera.zoom * factor, 0.08), 6);
      const mx = e.clientX - rect.left; const my = e.clientY - rect.top;
      setCamera((p) => ({ zoom: nz, x: mx - (mx - p.x) * (nz / p.zoom), y: my - (my - p.y) * (nz / p.zoom) }));
    };
    const el = canvasRef.current;
    el?.addEventListener("wheel", h, { passive: false });
    return () => el?.removeEventListener("wheel", h);
  }, [camera.zoom, renamingId, activeTab, setCamera]);

  // ── Coords ────────────────────────────────────────────────────────────────
  const s2w = useCallback((sx: number, sy: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { wx: 0, wy: 0 };
    return { wx: (sx - rect.left - camera.x) / camera.zoom, wy: (sy - rect.top - camera.y) / camera.zoom };
  }, [camera]);

  // ── Note ops ──────────────────────────────────────────────────────────────
  const createNote = (sx: number, sy: number) => {
    if (!activeTab) return;
    const { wx, wy } = s2w(sx, sy);
    const id = uid();
    setNotes((p) => [...p, {
      id, title: "New Note", content: "", x: wx, y: wy,
      width: 260, height: 170, color: "#2ecc71", collapsed: false
    }]);
    setActiveId(id);
    setMenu((m) => ({ ...m, visible: false }));
  };

  const deleteNote = (id: string) => {
    setNotes((p) => p.filter((n) => n.id !== id));
    setConns((p) => p.filter((c) => c.fromId !== id && c.toId !== id));
    if (activeId === id) setActiveId(null);
    setMenu((m) => ({ ...m, visible: false }));
  };

  const patchNote = (id: string, patch: Partial<StickyNote>) =>
    setNotes((p) => p.map((n) => n.id === id ? { ...n, ...patch } : n));

  const finalizeRename = (id: string, title: string) => { patchNote(id, { title }); setRenamingId(null); };

  const toggleCollapse = (id: string) =>
    setNotes((p) => p.map((n) => n.id === id ? { ...n, collapsed: !n.collapsed } : n));

  const embedImage = (id: string, file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => patchNote(id, { imageUrl: e.target?.result as string });
    reader.readAsDataURL(file);
  };

  // ── Arrow ops ─────────────────────────────────────────────────────────────
  const handleSnap = (noteId: string, side: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const note = notes.find((n) => n.id === noteId)!;
    const pt = getSnapPoint(note, side);
    if (!drawFrom) {
      setDrawFrom({ id: noteId, side, wx: pt.x, wy: pt.y });
    } else {
      if (drawFrom.id === noteId) { setDrawFrom(null); setTempEnd(null); return; }
      const conn: Connection = {
        id: uid(), fromId: drawFrom.id, fromSide: drawFrom.side as Connection["fromSide"],
        toId: noteId, toSide: side as Connection["toSide"],
        type: "bezier", style: "solid", isDoubleHeaded: false, color: activeColor,
      };
      setConns((p) => [...p, conn]);
      setSelConnId(conn.id);
      setDrawFrom(null); setTempEnd(null);
    }
  };

  const buildPath = (conn: Connection) => {
    const f = notes.find((n) => n.id === conn.fromId);
    const t = notes.find((n) => n.id === conn.toId);
    if (!f || !t) return null;
    const s = getSnapPoint(f, conn.fromSide);
    const e = getSnapPoint(t, conn.toSide);
    if (conn.type === "straight") return `M ${s.x} ${s.y} L ${e.x} ${e.y}`;
    const sc = ctrlOff(conn.fromSide); const ec = ctrlOff(conn.toSide);
    return `M ${s.x} ${s.y} C ${s.x + sc.dx} ${s.y + sc.dy}, ${e.x + ec.dx} ${e.y + ec.dy}, ${e.x} ${e.y}`;
  };

  const midpoint = (conn: Connection) => {
    const f = notes.find((n) => n.id === conn.fromId);
    const t = notes.find((n) => n.id === conn.toId);
    if (!f || !t) return null;
    const s = getSnapPoint(f, conn.fromSide);
    const e = getSnapPoint(t, conn.toSide);
    return { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 };
  };

  // ── Format ops ────────────────────────────────────────────────────────────
  const fmt = (e: React.MouseEvent, cmd: string, val?: string) => {
    e.preventDefault();
    if (cmd === "insertHTML") {
      const sel = window.getSelection(); if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0); range.deleteContents();
      range.insertNode(document.createRange().createContextualFragment(val!));
      return;
    }
    document.execCommand(cmd, false, val);
    if (cmd === "foreColor" && val) {
      setActiveColor(val);
      if (selConnId) setConns((p) => p.map((c) => c.id === selConnId ? { ...c, color: val } : c));
    } else if (!val) {
      setFmts((p) => p.includes(cmd) ? p.filter((f) => f !== cmd) : [...p, cmd]);
    }
  };

  const changeFontSize = (e: React.MouseEvent, delta: number) => {
    e.preventDefault();
    const next = Math.min(Math.max(fontSize + delta, 9), 30);
    setFontSize(next);
    document.execCommand("fontSize", false, "7");
    document.querySelectorAll("font[size='7']").forEach((el) => {
      (el as HTMLElement).removeAttribute("size");
      (el as HTMLElement).style.fontSize = `${next}px`;
    });
  };

  // ── Focus note ────────────────────────────────────────────────────────────
  const focusNote = (id: string) => {
    const note = notes.find((n) => n.id === id); if (!note) return;
    const rect = canvasRef.current?.getBoundingClientRect(); if (!rect) return;
    setCamera({ zoom: 1, x: rect.width / 2 - (note.x + note.width / 2), y: rect.height / 2 - (note.y + note.height / 2) });
    setActiveId(id);
  };

  // ── Mouse ─────────────────────────────────────────────────────────────────
  const onMouseMove = (e: React.MouseEvent) => {
    if (renamingId) return;
    if (drawFrom) { const { wx, wy } = s2w(e.clientX, e.clientY); setTempEnd({ wx, wy }); return; }
    if (resizing) {
      const { id, edge } = resizing;
      const dx = e.movementX / camera.zoom; const dy = e.movementY / camera.zoom;
      setNotes((p) => p.map((n) => {
        if (n.id !== id) return n;
        let { x, y, width, height } = n;
        if (edge.includes("right")) width += dx;
        if (edge.includes("bottom")) height += dy;
        if (edge.includes("left")) { x += dx; width -= dx; }
        if (edge.includes("top")) { y += dy; height -= dy; }
        return { ...n, x, y, width: Math.max(140, width), height: Math.max(80, height) };
      }));
      return;
    }
    if (dragging) {
      setNotes((p) => p.map((n) => n.id === dragging
        ? { ...n, x: n.x + e.movementX / camera.zoom, y: n.y + e.movementY / camera.zoom } : n));
      return;
    }
    if (panning) setCamera((p) => ({ ...p, x: p.x + e.movementX, y: p.y + e.movementY }));
  };

  const tf = `translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})`;

  return (
    <main className="container"
      onMouseMove={onMouseMove}
      onMouseUp={() => { setPanning(false); setDragging(null); setResizing(null); }}
      onClick={(e) => {
        setMenu((m) => ({ ...m, visible: false }));
        setFileMenu((m) => ({ ...m, visible: false }));
        setShowCP(false);
        const t = e.target as HTMLElement;
        if (!t.classList.contains("snap-point")) { setDrawFrom(null); setTempEnd(null); }
      }}
    >

      {/* ════ SIDEBAR (Stage 2 – Binder / Folders / Pages) ════ */}
      <div className="sidebar" style={{ width: sidebarW }}>
        <div className="sidebar-header">
          <span className="vault-title">{vaultName}</span>
          <span className="vault-subtitle">Binder</span>
        </div>

        <div className="sidebar-actions">
          <button className="sidebar-btn" onClick={() => createNewPage()} title="New page in root">
            + Page
          </button>
          <button className="sidebar-btn" onClick={async () => {
            const name = getNextName(tree, "Folder", "");
            try {
              await invoke("create_folder", { path: name });
              await fetchTree();
            } catch (err) { console.error(err); }
          }} title="New folder">
            + Folder
          </button>
        </div>

        <div className="file-list">
          {tree.length > 0 && (
            <FileTree
              nodes={tree}
              activeTabPath={activeTab?.path ?? null}
              openTabPaths={openTabPaths}
              onOpenFile={(path, name) => {
                openOrSwitchTab(path, name);
                if (path !== currentGraphContext) {
                  setGraphHistory(prev => { const n = prev.slice(0, graphHistoryIdx + 1); n.push(path); return n; });
                  setGraphHistoryIdx(prev => prev + 1);
                }
              }}
              onOpenFolder={(path) => {
                if (path !== currentGraphContext) {
                  setGraphHistory(prev => { const n = prev.slice(0, graphHistoryIdx + 1); n.push(path); return n; });
                  setGraphHistoryIdx(prev => prev + 1);
                }
              }}
              renamingFilePath={renamingFilePath}
              onRenameStart={(path) => setRenamingFilePath(path)}
              onRenameCommit={handleRenameCommit}
              onFileContextMenu={(e, path, name, isDir) => {
                setFileMenu({ visible: true, x: e.clientX, y: e.clientY, path, name, isDir });
              }}
              draggedPath={treeDraggedPath}
              setDraggedPath={setTreeDraggedPath}
              onItemDrop={handleItemDrop}
            />
          )}
          {tree.length === 0 && (
            <div className="empty-vault">
              <span>Empty binder</span>
              <small>Click "+ Page" to create your first notebook page</small>
            </div>
          )}
        </div>

        <MediaMiniPlayer />

        <div className="resizer-v" onMouseDown={() => {
          const mv = (e: MouseEvent) => setSidebarW(Math.max(50, e.clientX));
          const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); };
          document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
        }} />
      </div>

      {/* ════ WORKSPACE ════ */}
      <div className="workspace">

        {/* ── Stage 3: TAB BAR ── */}
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSwitch={switchTab}
          onClose={closeTab}
        />

        {/* ── No tab open placeholder ── */}
        {!activeTab ? (
          <div className="no-page-open">
            <div className="no-page-icon">◈</div>
            <div className="no-page-title">No page open</div>
            <div className="no-page-sub">Select a page from the sidebar or create a new one</div>
          </div>
        ) : (
          <>
            {/* ── CANVAS ── */}
            <div
              className={`canvas-container ${activeId && !arrowTool ? "panning-locked" : ""}`}
              ref={canvasRef}
              onMouseDown={(e) => {
                if (renamingId) return;
                if (e.button === 1) { setPanning(true); e.preventDefault(); return; }
                if (e.button === 0 && e.target === canvasRef.current) {
                  setActiveId(null); setSelConnId(null);
                  if (!drawFrom) setPanning(true);
                }
              }}
              onMouseUp={() => setPanning(false)}
              onDoubleClick={(e) => {
                if (e.target === canvasRef.current) {
                  setActiveId(null); setRenamingId(null); setSelConnId(null); setArrowTool(false);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (e.target === canvasRef.current)
                  setMenu({ x: e.clientX, y: e.clientY, visible: true, target: "", type: "space" });
              }}
            >

              {/* ══ TOOLBAR ══ */}
              <div className="canvas-toolbar">
                <div className="toolbar-group">
                  {(["bold", "italic", "underline"] as const).map((cmd, i) => (
                    <button key={cmd} className={`tool ${fmts.includes(cmd) ? "active-toggled" : ""}`}
                      onMouseDown={(e) => fmt(e, cmd)} title={["Bold", "Italic", "Underline"][i]}>
                      {["B", "I", "U"][i]}
                    </button>
                  ))}
                  <button className="tool" title="Strikethrough"
                    onMouseDown={(e) => fmt(e, "strikeThrough")}>
                    <s>S</s>
                  </button>
                  <button className="tool code-btn" title="Inline code"
                    onMouseDown={(e) => fmt(e, "insertHTML", "<code class='ic'>\u200B</code>")}>
                    {"<>"}
                  </button>
                </div>

                <div className="tool-divider" />

                <div className="toolbar-group">
                  <button className="tool" onMouseDown={(e) => changeFontSize(e, -1)} title="Smaller">A−</button>
                  <span className="font-sz-display">{fontSize}</span>
                  <button className="tool" onMouseDown={(e) => changeFontSize(e, +1)} title="Larger">A+</button>
                </div>

                <div className="tool-divider" />

                <div className="toolbar-group">
                  <button className="tool" title="Bullet list" onMouseDown={(e) => fmt(e, "insertUnorderedList")}>•≡</button>
                  <button className="tool" title="Numbered list" onMouseDown={(e) => fmt(e, "insertOrderedList")}>1≡</button>
                </div>

                <div className="tool-divider" />

                <div className="toolbar-group">
                  {NOTE_COLORS.map((c) => (
                    <div key={c} className={`swatch ${activeColor === c ? "selected" : ""}`}
                      style={{ backgroundColor: c }}
                      onMouseDown={(e) => fmt(e, "foreColor", c)} />
                  ))}
                </div>

                <div className="tool-divider" />

                <button className="tool" title="Insert link"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    const url = prompt("Enter URL:");
                    if (url) fmt(e, "createLink", url);
                  }}>🔗</button>

                <button className="tool" title="Embed image"
                  onMouseDown={(e) => { e.preventDefault(); imgInputRef.current?.click(); }}>🖼</button>

                <div className="tool-divider" />

                <button className="tool" title="Reset view"
                  onClick={() => setCamera({ x: 0, y: 0, zoom: 1 })}>⌂</button>

                <div className="tool-divider" />

                <button className={`tool ${arrowTool ? "active-toggled" : ""}`} title="Arrow tool"
                  onClick={() => { setArrowTool((v) => !v); setDrawFrom(null); setTempEnd(null); }}>↗</button>

                {arrowTool && (
                  <div className="arrow-submenu">
                    <div className="tool-divider" />
                    <div className="toolbar-group">
                      <button className="tool" title="Straight / Bezier"
                        onClick={() => selConnId && setConns((p) => p.map((c) => c.id === selConnId ? { ...c, type: c.type === "straight" ? "bezier" : "straight" } : c))}>⌇</button>
                      <button className="tool" title="Solid / Dashed"
                        onClick={() => selConnId && setConns((p) => p.map((c) => c.id === selConnId ? { ...c, style: c.style === "solid" ? "dashed" : "solid" } : c))}>--</button>
                      <button className="tool" title="Double-headed"
                        onClick={() => selConnId && setConns((p) => p.map((c) => c.id === selConnId ? { ...c, isDoubleHeaded: !c.isDoubleHeaded } : c))}>↔</button>
                      <button className="tool" title="Edit label"
                        onClick={() => selConnId && setEditLabel(selConnId)}>T</button>
                      <button className="tool delete" title="Delete arrow (Del)"
                        onClick={() => { selConnId && setConns((p) => p.filter((c) => c.id !== selConnId)); setSelConnId(null); }}>✕</button>
                    </div>
                  </div>
                )}

                {drawFrom && <div className="drawing-indicator">Click target snap point · ESC cancels</div>}
              </div>

              {/* Hidden image file input */}
              <input ref={imgInputRef} type="file" accept="image/*" style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file && activeId) embedImage(activeId, file);
                  e.target.value = "";
                }} />

              {/* ══ SVG ARROW LAYER ══ */}
              <svg className="snap-layer" style={{ transform: tf, transformOrigin: "0 0" }}>
                <defs>
                  <marker id="ah-end" markerWidth="8" markerHeight="6"
                    refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
                    <polygon points="0 0,8 3,0 6" fill="context-stroke" />
                  </marker>
                  <marker id="ah-start" markerWidth="8" markerHeight="6"
                    refX="1" refY="3" orient="auto-start-reverse" markerUnits="strokeWidth">
                    <polygon points="8 0,0 3,8 6" fill="context-stroke" />
                  </marker>
                </defs>

                {connections.map((conn) => {
                  const d = buildPath(conn); const mid = midpoint(conn);
                  if (!d) return null;
                  const sel = selConnId === conn.id;
                  return (
                    <g key={conn.id}>
                      <path d={d} stroke="transparent" strokeWidth="14" fill="none"
                        style={{ pointerEvents: "auto", cursor: "pointer" }}
                        onClick={(e) => { e.stopPropagation(); setSelConnId(conn.id); setArrowTool(true); }} />
                      <path d={d}
                        stroke={sel ? "#fff" : conn.color} strokeWidth={sel ? 3 : 2} fill="none"
                        strokeDasharray={conn.style === "dashed" ? "6,4" : undefined}
                        markerEnd="url(#ah-end)"
                        markerStart={conn.isDoubleHeaded ? "url(#ah-start)" : undefined}
                        className={`connection-path${sel ? " selected" : ""}`}
                        style={{ pointerEvents: "none" }}
                      />
                      {mid && conn.label && !editLabel && (
                        <g>
                          <rect x={mid.x - conn.label.length * 3 - 4} y={mid.y - 13}
                            width={conn.label.length * 6 + 8} height={16} rx="3"
                            fill="#0d0d0d" stroke={conn.color} strokeWidth="0.5" strokeOpacity="0.5" />
                          <text x={mid.x} y={mid.y - 2} textAnchor="middle"
                            fill={conn.color} fontSize="9" fontFamily="'JetBrains Mono',monospace"
                            style={{ pointerEvents: "none" }}>
                            {conn.label}
                          </text>
                        </g>
                      )}
                      {mid && editLabel === conn.id && (
                        <foreignObject x={mid.x - 55} y={mid.y - 16} width="110" height="26">
                          <input autoFocus
                            style={{
                              width: "100%", background: "#111", border: `1px solid ${conn.color}`,
                              color: conn.color, fontSize: "10px", fontFamily: "'JetBrains Mono',monospace",
                              outline: "none", padding: "3px 5px", borderRadius: "3px"
                            }}
                            defaultValue={conn.label || ""}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                setConns((p) => p.map((c) => c.id === conn.id ? { ...c, label: (e.target as HTMLInputElement).value } : c));
                                setEditLabel(null);
                              }
                              if (e.key === "Escape") setEditLabel(null);
                            }}
                            onBlur={(e) => {
                              setConns((p) => p.map((c) => c.id === conn.id ? { ...c, label: e.target.value } : c));
                              setEditLabel(null);
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </foreignObject>
                      )}
                    </g>
                  );
                })}

                {drawFrom && tempEnd && (
                  <line x1={drawFrom.wx} y1={drawFrom.wy} x2={tempEnd.wx} y2={tempEnd.wy}
                    stroke={activeColor} strokeWidth="1.5" strokeDasharray="5,4" opacity="0.65" />
                )}
              </svg>

              {/* ══ NOTES ══ */}
              <div className="canvas-content" style={{ transform: tf, transformOrigin: "0 0" }}>
                {notes.map((note) => {
                  const isAct = activeId === note.id;
                  const isRen = renamingId === note.id;
                  const dispH = note.collapsed ? COLLAPSED_H : note.height;

                  return (
                    <div key={note.id}
                      className={`sticky-note ${isAct ? "active" : ""} ${isRen ? "renaming" : ""} ${note.collapsed ? "collapsed" : ""}`}
                      style={{
                        left: note.x, top: note.y, width: note.width, height: dispH,
                        "--nc": note.color
                      } as React.CSSProperties}
                    >
                      {arrowTool && (["top", "bottom", "left", "right"] as const).map((side) => (
                        <div key={side}
                          className={`snap-point ${side}${drawFrom?.id === note.id && drawFrom?.side === side ? " node-selected" : ""}`}
                          onClick={(e) => handleSnap(note.id, side, e)} />
                      ))}

                      <div className="sticky-top-shade" />

                      <button className="collapse-btn"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); toggleCollapse(note.id); }}
                        title={note.collapsed ? "Expand note" : "Collapse note"}>
                        {note.collapsed ? "+" : "−"}
                      </button>

                      {!note.collapsed && (
                        <>
                          {(["top", "bottom", "left", "right"] as const).map((edge) => (
                            <div key={edge} className={`resizer-edge ${edge}`}
                              onMouseDown={(e) => { e.stopPropagation(); setResizing({ id: note.id, edge }); }} />
                          ))}
                          <div className="sticky-resize-handle"
                            onMouseDown={(e) => { e.stopPropagation(); setResizing({ id: note.id, edge: "bottom-right" }); }} />
                        </>
                      )}

                      <div className="sticky-header-label"
                        onMouseDown={(e) => {
                          if (isRen || arrowTool) return;
                          e.stopPropagation();
                          setDragging(note.id); setActiveId(note.id);
                        }}
                        onDoubleClick={(e) => { e.stopPropagation(); setRenamingId(note.id); }}
                        onContextMenu={(e) => {
                          e.preventDefault(); e.stopPropagation();
                          setMenu({ x: e.clientX, y: e.clientY, visible: true, target: note.id, type: "sticky" });
                        }}
                      >
                        {isRen ? (
                          <input autoFocus className="sticky-title-input" defaultValue={note.title}
                            onMouseDown={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") finalizeRename(note.id, e.currentTarget.value);
                              if (e.key === "Escape") setRenamingId(null);
                            }}
                            onBlur={(e) => finalizeRename(note.id, e.currentTarget.value)}
                          />
                        ) : <span>{note.title}</span>}

                        {isAct && !isRen && (
                          <div className="note-color-dot"
                            style={{ background: note.color }}
                            onClick={(e) => { e.stopPropagation(); setShowCP((v) => !v); }} />
                        )}
                      </div>

                      {isAct && showColorPicker && (
                        <div className="note-color-picker" onClick={(e) => e.stopPropagation()}>
                          {NOTE_COLORS.map((c) => (
                            <div key={c} className="nc-swatch" style={{
                              background: c,
                              boxShadow: note.color === c ? `0 0 0 2px #0d0d0d, 0 0 0 3px ${c}` : "none"
                            }}
                              onClick={() => { patchNote(note.id, { color: c }); setShowCP(false); }} />
                          ))}
                        </div>
                      )}

                      {!note.collapsed && (
                        <>
                          {note.imageUrl && (
                            <div className="note-img-wrap">
                              <img src={note.imageUrl} alt="" className="note-img" />
                              <button className="note-img-rm"
                                onClick={(e) => { e.stopPropagation(); patchNote(note.id, { imageUrl: undefined }); }}>✕</button>
                            </div>
                          )}
                          <div className="sticky-input"
                            contentEditable={isAct && !isRen && !arrowTool}
                            suppressContentEditableWarning
                            onMouseDown={(e) => { if (arrowTool) return; e.stopPropagation(); setActiveId(note.id); }}
                            ref={(el) => {
                              if (el && el.innerHTML !== note.content && activeId !== note.id)
                                el.innerHTML = note.content;
                            }}
                            onInput={(e) => { note.content = (e.target as HTMLElement).innerHTML; }}
                            onBlur={(e) => {
                              const html = (e.target as HTMLElement).innerHTML;
                              setNotes((p) => p.map((n) => n.id === note.id ? { ...n, content: html } : n));
                            }}
                          />
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── Graph resizer ── */}
            <div className="resizer-h" onMouseDown={() => {
              const mv = (e: MouseEvent) => setGraphH(Math.max(30, Math.min(window.innerHeight - e.clientY, 500)));
              const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); };
              document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
            }} />

            {/* ── GRAPH VIEW ── */}
            <div className="graph-section" style={{ height: graphH }}>
              <div className="section-header" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div className="graph-nav" style={{ display: 'flex', gap: '4px' }}>
                  <button className="tool" onClick={() => setGraphHistoryIdx(p => Math.max(0, p - 1))} disabled={graphHistoryIdx <= 0} title="Back">⬅</button>
                  <button className="tool" onClick={() => setGraphHistoryIdx(p => Math.min(graphHistory.length - 1, p + 1))} disabled={graphHistoryIdx >= graphHistory.length - 1} title="Forward">➡</button>
                  <button className="tool" onClick={() => {
                    setGraphHistory(prev => { const n = prev.slice(0, graphHistoryIdx + 1); n.push(""); return n; });
                    setGraphHistoryIdx(prev => prev + 1);
                  }} title="Highest Level">Top Level</button>
                  <button className="tool" onClick={() => {
                    if (activeTabId) {
                      setGraphHistory(prev => { const n = prev.slice(0, graphHistoryIdx + 1); n.push(activeTabId); return n; });
                      setGraphHistoryIdx(prev => prev + 1);
                    }
                  }} disabled={!activeTabId} title="Current Page">Current Page</button>
                </div>
                <span>Graph View — {currentGraphContext || vaultName}</span>
                <span className="graph-hint" style={{ marginLeft: 'auto' }}>
                  {gNodes.length} node{gNodes.length !== 1 ? "s" : ""} · scroll to zoom · drag to pan · click to navigate
                </span>
              </div>
              <GraphView nodes={gNodes} edges={gEdges} onNodeClick={handleGraphNodeClick} />
            </div>
          </>
        )}
      </div>

      {/* ════ CONTEXT MENU ════ */}
      {menu.visible && (
        <div className="context-menu" style={{ top: menu.y, left: menu.x }}>
          {menu.type === "space" ? (
            <div className="menu-item" onClick={() => createNote(menu.x, menu.y)}>✦ New Sticky Note</div>
          ) : (
            <>
              <div className="menu-item" onClick={() => {
                const n = notes.find(x => x.id === menu.target);
                if (n) { setRenamingId(n.id); setActiveId(n.id); }
                setMenu(m => ({ ...m, visible: false }));
              }}>✎ Rename</div>
              <div className="menu-item" onClick={() => {
                toggleCollapse(menu.target);
                setMenu(m => ({ ...m, visible: false }));
              }}>
                {notes.find(x => x.id === menu.target)?.collapsed ? "▼ Expand" : "▲ Collapse"}
              </div>
              <div className="menu-item" onClick={() => {
                if (activeId === menu.target) imgInputRef.current?.click();
                setMenu(m => ({ ...m, visible: false }));
              }}>🖼 Embed Image</div>
              <div className="menu-item delete" onClick={() => deleteNote(menu.target)}>✕ Delete Note</div>
            </>
          )}
        </div>
      )}
      {fileMenu.visible && (
        <div className="context-menu" style={{ top: fileMenu.y, left: fileMenu.x }}>
          <div className="menu-item" onClick={() => {
            setFileMenu(m => ({ ...m, visible: false }));
            setRenamingFilePath(fileMenu.path);
          }}>✎ Rename</div>
          {fileMenu.isDir && (
            <>
              <div className="menu-item" onClick={async () => {
                setFileMenu(m => ({ ...m, visible: false }));
                await createNewPage(fileMenu.path);
              }}>✦ New Page inside</div>
              <div className="menu-item" onClick={async () => {
                setFileMenu(m => ({ ...m, visible: false }));
                const name = getNextName(tree, "Folder", "");
                try {
                  await invoke("create_folder", { path: `${fileMenu.path}/${name}` });
                  await fetchTree();
                } catch (err) { console.error(err); }
              }}>📁 New Folder inside</div>
            </>
          )}
          <div className="menu-item delete" onClick={() => {
            setFileMenu(m => ({ ...m, visible: false }));
            handleDeleteItem(fileMenu.path);
          }}>✕ Delete</div>
        </div>
      )}
    </main>
  );
}