import React, {
  useState, useEffect, useRef, useCallback,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { app } from "@tauri-apps/api";

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

// ─── Constants ────────────────────────────────────────────────────────────────

const NOTE_COLORS = [
  "#2ecc71", "#e74c3c", "#3498db", "#f39c12", "#9b59b6", "#ffffff",
];

const COLLAPSED_H = 40;

// ─── Utilities ────────────────────────────────────────────────────────────────

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

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

// ─── Force-directed layout (no external deps) ────────────────────────────────

interface FNode { id: string; x: number; y: number; vx: number; vy: number; }

function forceLayout(
  nodes: FNode[],
  edges: { a: string; b: string }[],
  W: number, H: number,
  iters = 140,
): Record<string, { x: number; y: number }> {
  const m: Record<string, FNode> = {};
  nodes.forEach((n) => { m[n.id] = { ...n }; });
  const ids = Object.keys(m);

  for (let t = 0; t < iters; t++) {
    const a = 1 - t / iters;
    // repulsion
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const A = m[ids[i]]; const B = m[ids[j]];
        const dx = B.x - A.x; const dy = B.y - A.y;
        const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const f = 7000 / (d * d) * a;
        A.vx -= dx / d * f; A.vy -= dy / d * f;
        B.vx += dx / d * f; B.vy += dy / d * f;
      }
    }
    // attraction
    edges.forEach(({ a: ai, b: bi }) => {
      const A = m[ai]; const B = m[bi];
      if (!A || !B) return;
      const dx = B.x - A.x; const dy = B.y - A.y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const f = (d - 110) * 0.04 * a;
      A.vx += dx / d * f; A.vy += dy / d * f;
      B.vx -= dx / d * f; B.vy -= dy / d * f;
    });
    // gravity
    Object.values(m).forEach((n) => {
      n.vx += (W / 2 - n.x) * 0.007 * a;
      n.vy += (H / 2 - n.y) * 0.007 * a;
    });
    // integrate
    Object.values(m).forEach((n) => {
      n.x += n.vx * 0.5; n.y += n.vy * 0.5;
      n.vx *= 0.82; n.vy *= 0.82;
      n.x = Math.max(16, Math.min(W - 16, n.x));
      n.y = Math.max(16, Math.min(H - 16, n.y));
    });
  }

  const out: Record<string, { x: number; y: number }> = {};
  Object.entries(m).forEach(([id, n]) => { out[id] = { x: n.x, y: n.y }; });
  return out;
}

// ─── GraphView ────────────────────────────────────────────────────────────────

function GraphView({
  notes, connections, onFocus,
}: {
  notes: StickyNote[];
  connections: Connection[];
  onFocus: (id: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const posRef = useRef<Record<string, { x: number; y: number }>>({});
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const [gc, setGc] = useState({ x: 0, y: 0, zoom: 1 });
  const [panning, setPanning] = useState(false);
  const [hov, setHov] = useState<string | null>(null);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const W = el.clientWidth || 500;
    const H = el.clientHeight || 180;
    const seed: FNode[] = notes.map((n, i) => {
      const prev = posRef.current[n.id];
      return prev
        ? { id: n.id, ...prev, vx: 0, vy: 0 }
        : {
          id: n.id,
          x: W / 2 + Math.cos((i / Math.max(notes.length, 1)) * Math.PI * 2) * 80,
          y: H / 2 + Math.sin((i / Math.max(notes.length, 1)) * Math.PI * 2) * 55,
          vx: 0, vy: 0
        };
    });
    const edges = connections.map((c) => ({ a: c.fromId, b: c.toId }));
    const result = forceLayout(seed, edges, W, H);
    posRef.current = result;
    setPos(result);
  }, [notes.length, connections.length]);

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
          <polygon points="0 0,5 2,0 4" fill="#2ecc71" opacity="0.4" />
        </marker>
      </defs>
      <g style={{ transform: gt, transformOrigin: "0 0" }}>
        {connections.map((c) => {
          const f = pos[c.fromId]; const t = pos[c.toId];
          if (!f || !t) return null;
          return <line key={c.id} x1={f.x} y1={f.y} x2={t.x} y2={t.y}
            stroke={c.color} strokeWidth="1" strokeOpacity="0.3" markerEnd="url(#garrow)" />;
        })}
        {notes.map((n) => {
          const p = pos[n.id]; if (!p) return null;
          const h = hov === n.id;
          return (
            <g key={n.id} style={{ cursor: "pointer" }}
              onClick={() => onFocus(n.id)}
              onMouseEnter={() => setHov(n.id)}
              onMouseLeave={() => setHov(null)}
            >
              {h && <circle cx={p.x} cy={p.y} r="16" fill="none"
                stroke={n.color} strokeWidth="0.5" strokeOpacity="0.35" />}
              <circle cx={p.x} cy={p.y} r={h ? 8 : 5}
                fill="#0d0d0d" stroke={n.color} strokeWidth={h ? 2 : 1.5}
                style={{ transition: "r 0.12s" }} />
              <text x={p.x} y={p.y + (h ? 20 : 16)} textAnchor="middle"
                fill={h ? n.color : "#3a3a3a"} fontSize="8"
                fontFamily="'JetBrains Mono',monospace"
                style={{ transition: "fill 0.12s", pointerEvents: "none" }}>
                {n.title.slice(0, 20)}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

// ─── FileTree ─────────────────────────────────────────────────────────────────

function FileTree({ nodes, depth = 0, activeId, onSelect }: {
  nodes: FileNode[]; depth?: number; activeId: string | null; onSelect: (n: string) => void;
}) {
  const [col, setCol] = useState<Record<string, boolean>>({});
  return (
    <div className={depth > 0 ? "indent" : ""}>
      {nodes.map((node) => (
        <div key={node.name}>
          <div
            className={`file-item ${!node.is_dir && activeId === node.name ? "active" : ""}`}
            style={{ paddingLeft: `${15 + depth * 12}px` }}
            onClick={() => node.is_dir
              ? setCol((p) => ({ ...p, [node.name]: !p[node.name] }))
              : onSelect(node.name)}
          >
            <span className="file-icon">{node.is_dir ? (col[node.name] ? "▶" : "▾") : "◈"}</span>
            <span className="file-name">{node.name.replace(/\.md$/, "")}</span>
          </div>
          {node.is_dir && !col[node.name] && node.children && (
            <FileTree nodes={node.children} depth={depth + 1} activeId={activeId} onSelect={onSelect} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [notes, setNotes] = useState<StickyNote[]>([
    {
      id: "1", title: "1974 ECOA Act", content: "Lenders must compare based on numbers...",
      x: 120, y: 80, width: 300, height: 200, color: "#2ecc71", collapsed: false
    },
  ]);
  const [connections, setConns] = useState<Connection[]>([]);
  const [vaultName] = useState("EMERALD");

  const [activeId, setActiveId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [selConnId, setSelConnId] = useState<string | null>(null);
  const [arrowTool, setArrowTool] = useState(false);
  const [editLabel, setEditLabel] = useState<string | null>(null);
  const [showColorPicker, setShowCP] = useState(false);

  const [sidebarW, setSidebarW] = useState(220);
  const [graphH, setGraphH] = useState(220);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [panning, setPanning] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [resizing, setResizing] = useState<{ id: string; edge: string } | null>(null);

  const [drawFrom, setDrawFrom] = useState<{ id: string; side: string; wx: number; wy: number } | null>(null);
  const [tempEnd, setTempEnd] = useState<{ wx: number; wy: number } | null>(null);

  // Phase 4 toolbar
  const [fmts, setFmts] = useState<string[]>([]);
  const [fontSize, setFontSize] = useState(14);
  const [activeColor, setActiveColor] = useState("#2ecc71");

  const [menu, setMenu] = useState({ x: 0, y: 0, visible: false, target: "", type: "space" as "space" | "sticky" });

  const canvasRef = useRef<HTMLDivElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);

  // ── Load tree ────────────────────────────────────────────────────────────
  useEffect(() => {
    invoke("get_directory_tree").then((d) => setTree(d as FileNode[])).catch(console.error);
  }, []);

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
  }, [selConnId, activeId]);

  // ── Wheel zoom ────────────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e: WheelEvent) => {
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
  }, [camera.zoom, renamingId]);

  // ── Coords ────────────────────────────────────────────────────────────────
  const s2w = useCallback((sx: number, sy: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { wx: 0, wy: 0 };
    return { wx: (sx - rect.left - camera.x) / camera.zoom, wy: (sy - rect.top - camera.y) / camera.zoom };
  }, [camera]);

  // ── Note ops ──────────────────────────────────────────────────────────────
  const createNote = (sx: number, sy: number) => {
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

  // ── Format ops (Phase 4) ──────────────────────────────────────────────────
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

  // ── Focus note (from graph or sidebar) ───────────────────────────────────
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
        setShowCP(false);
        const t = e.target as HTMLElement;
        if (!t.classList.contains("snap-point")) { setDrawFrom(null); setTempEnd(null); }
      }}
    >

      {/* ════ SIDEBAR ════ */}
      <div className="sidebar" style={{ width: sidebarW }}>
        <div className="sidebar-header"><span className="vault-title">{vaultName}</span></div>

        <div className="sidebar-actions">
          <button className="sidebar-btn" onClick={() => {
            const id = uid();
            const { wx, wy } = s2w(sidebarW + 60, 80);
            setNotes((p) => [...p, {
              id, title: "New Note", content: "", x: wx, y: wy,
              width: 260, height: 170, color: "#2ecc71", collapsed: false
            }]);
            setActiveId(id);
          }}>+ Note</button>
          <button className="sidebar-btn">+ Folder</button>
        </div>

        <div className="file-list">
          {tree.length > 0 && (
            <FileTree nodes={tree} activeId={activeId} onSelect={(name) => {
              const m = notes.find((n) => n.title === name.replace(/\.md$/, ""));
              if (m) focusNote(m.id);
            }} />
          )}
          {notes.length > 0 && (
            <div className="sidebar-section">
              <div className="sidebar-section-label">Canvas Notes</div>
              {notes.map((n) => (
                <div key={n.id}
                  className={`file-item ${activeId === n.id ? "active" : ""}`}
                  onClick={() => focusNote(n.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, visible: true, target: n.id, type: "sticky" });
                  }}
                >
                  <span className="file-icon" style={{ color: n.color }}>◈</span>
                  <span className="file-name">{n.title}</span>
                  {n.collapsed && <span className="collapsed-badge">—</span>}
                </div>
              ))}
            </div>
          )}
          {notes.length === 0 && tree.length === 0 && (
            <div className="empty-vault">
              <span>No notes yet</span>
              <small>Right-click canvas to create one</small>
            </div>
          )}
        </div>

        <div className="resizer-v" onMouseDown={() => {
          const mv = (e: MouseEvent) => setSidebarW(Math.max(50, e.clientX));
          const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); };
          document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
        }} />
      </div>

      {/* ════ WORKSPACE ════ */}
      <div className="workspace">

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
            {/* Bold / Italic / Underline / Strikethrough / Code */}
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

            {/* Font size */}
            <div className="toolbar-group">
              <button className="tool" onMouseDown={(e) => changeFontSize(e, -1)} title="Smaller">A−</button>
              <span className="font-sz-display">{fontSize}</span>
              <button className="tool" onMouseDown={(e) => changeFontSize(e, +1)} title="Larger">A+</button>
            </div>

            <div className="tool-divider" />

            {/* Lists */}
            <div className="toolbar-group">
              <button className="tool" title="Bullet list" onMouseDown={(e) => fmt(e, "insertUnorderedList")}>•≡</button>
              <button className="tool" title="Numbered list" onMouseDown={(e) => fmt(e, "insertOrderedList")}>1≡</button>
            </div>

            <div className="tool-divider" />

            {/* Colour swatches */}
            <div className="toolbar-group">
              {NOTE_COLORS.map((c) => (
                <div key={c} className={`swatch ${activeColor === c ? "selected" : ""}`}
                  style={{ backgroundColor: c }}
                  onMouseDown={(e) => fmt(e, "foreColor", c)} />
              ))}
            </div>

            <div className="tool-divider" />

            {/* Link */}
            <button className="tool" title="Insert link"
              onMouseDown={(e) => {
                e.preventDefault();
                const url = prompt("Enter URL:");
                if (url) fmt(e, "createLink", url);
              }}>🔗</button>

            {/* Image embed */}
            <button className="tool" title="Embed image"
              onMouseDown={(e) => { e.preventDefault(); imgInputRef.current?.click(); }}>🖼</button>

            <div className="tool-divider" />

            {/* Reset view */}
            <button className="tool" title="Reset view (R)"
              onClick={() => setCamera({ x: 0, y: 0, zoom: 1 })}>⌂</button>

            <div className="tool-divider" />

            {/* Arrow tool */}
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
                  {/* Fat invisible hit target */}
                  <path d={d} stroke="transparent" strokeWidth="14" fill="none"
                    style={{ pointerEvents: "auto", cursor: "pointer" }}
                    onClick={(e) => { e.stopPropagation(); setSelConnId(conn.id); setArrowTool(true); }} />
                  {/* Visible arrow */}
                  <path d={d}
                    stroke={sel ? "#fff" : conn.color} strokeWidth={sel ? 3 : 2} fill="none"
                    strokeDasharray={conn.style === "dashed" ? "6,4" : undefined}
                    markerEnd="url(#ah-end)"
                    markerStart={conn.isDoubleHeaded ? "url(#ah-start)" : undefined}
                    className={`connection-path${sel ? " selected" : ""}`}
                    style={{ pointerEvents: "none" }}
                  />
                  {/* Edge label */}
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
                  {/* Inline label editor */}
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

            {/* Temp preview */}
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
                  {/* Snap points */}
                  {arrowTool && (["top", "bottom", "left", "right"] as const).map((side) => (
                    <div key={side}
                      className={`snap-point ${side}${drawFrom?.id === note.id && drawFrom?.side === side ? " node-selected" : ""}`}
                      onClick={(e) => handleSnap(note.id, side, e)} />
                  ))}

                  {/* Folded corner */}
                  <div className="sticky-top-shade" />

                  {/* Collapse button */}
                  <button className="collapse-btn"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); toggleCollapse(note.id); }}
                    title={note.collapsed ? "Expand note" : "Collapse note"}>
                    {note.collapsed ? "+" : "−"}
                  </button>

                  {/* Resize handles (only expanded) */}
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

                  {/* Header */}
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

                    {/* Colour dot (Phase 2) */}
                    {isAct && !isRen && (
                      <div className="note-color-dot"
                        style={{ background: note.color }}
                        onClick={(e) => { e.stopPropagation(); setShowCP((v) => !v); }} />
                    )}
                  </div>

                  {/* Note colour picker (Phase 2) */}
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

                  {/* Body (hidden when collapsed) */}
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
          <div className="section-header">
            Graph View
            <span className="graph-hint">{notes.length} node{notes.length !== 1 ? "s" : ""} · scroll to zoom · drag to pan · click to focus</span>
          </div>
          <GraphView notes={notes} connections={connections} onFocus={focusNote} />
        </div>
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
    </main>
  );
}