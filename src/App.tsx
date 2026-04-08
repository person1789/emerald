import React, {
  useState, useEffect, useRef, useCallback,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

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
  fromSide: 'top' | 'bottom' | 'left' | 'right';
  toId: string;
  toSide: 'top' | 'bottom' | 'left' | 'right';
  type: 'straight' | 'bezier';
  style: 'solid' | 'dashed';
  isDoubleHeaded: boolean;
  color: string;
}

interface FileNode {
  name: string;
  is_dir: boolean;
  children?: FileNode[];
}

function App() {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [notes, setNotes] = useState<StickyNote[]>([
    { id: "1", title: "1974 ECOA Act", content: "Lenders must compare based on numbers...", x: 100, y: 100, width: 300, height: 180 }
  ]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [vaultName] = useState("EMERALD");
  
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null);
  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);
  const [arrowToolActive, setArrowToolActive] = useState(false);
  
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [graphHeight, setGraphHeight] = useState(300);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const [draggedNote, setDraggedNote] = useState<string | null>(null);
  const [resizingNote, setResizingNote] = useState<{ id: string, edge: string } | null>(null);

  // Two-Click Arrow State
  const [drawingFrom, setDrawingFrom] = useState<{ id: string, side: string, x: number, y: number } | null>(null);
  const [tempEndPoint, setTempEndPoint] = useState<{ x: number, y: number } | null>(null);

  const [activeFormats, setActiveFormats] = useState<string[]>([]);
  const [activeColor, setActiveColor] = useState("#ffffff");
  const [menu, setMenu] = useState({ x: 0, y: 0, visible: false, target: "", type: "space" as "space" | "sticky" | "node" });

  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadTree = async () => {
      try {
        const data = await invoke("get_directory_tree");
        setTree(data as FileNode[]);
      } catch (e) { console.error(e); }
    };
    loadTree();
  }, []);

  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (renamingNoteId) return;
      e.preventDefault();
      const zoomFactor = 1 - e.deltaY * 0.0015;
      const nextZoom = Math.min(Math.max(camera.zoom * zoomFactor, 0.1), 5);
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      setCamera(prev => ({
        zoom: nextZoom,
        x: mouseX - (mouseX - prev.x) * (nextZoom / prev.zoom),
        y: mouseY - (mouseY - prev.y) * (nextZoom / prev.zoom),
      }));
    };
    const canvas = canvasRef.current;
    canvas?.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas?.removeEventListener("wheel", handleWheel);
  }, [camera.zoom, renamingNoteId]);

  const getSnapPoint = (note: StickyNote, side: string) => {
    switch (side) {
      case 'top': return { x: note.x + note.width / 2, y: note.y };
      case 'bottom': return { x: note.x + note.width / 2, y: note.y + note.height };
      case 'left': return { x: note.x, y: note.y + note.height / 2 };
      case 'right': return { x: note.x + note.width, y: note.y + note.height / 2 };
      default: return { x: note.x, y: note.y };
    }
  };

  const applyFormat = (e: React.MouseEvent, command: string, value?: string) => {
    e.preventDefault(); 
    document.execCommand(command, false, value);
    if (command === "foreColor" && value) {
      setActiveColor(value);
      // Link color tool directly to selected arrow
      if(selectedConnId) {
        setConnections(prev => prev.map(c => c.id === selectedConnId ? {...c, color: value} : c));
      }
    }
    if (!value) setActiveFormats(prev => prev.includes(command) ? prev.filter(f => f !== command) : [...prev, command]);
  };

  const handleSnapClick = (noteId: string, side: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const note = notes.find(n => n.id === noteId)!;
    const pt = getSnapPoint(note, side);

    if (!drawingFrom) {
      // First Click: Start point
      setDrawingFrom({ id: noteId, side, x: pt.x, y: pt.y });
    } else {
      // Second Click: Finalize Connection
      if (drawingFrom.id === noteId) {
        setDrawingFrom(null); // Cancel if same note
        setTempEndPoint(null);
        return;
      }

      const newConn: Connection = {
        id: Date.now().toString(),
        fromId: drawingFrom.id,
        fromSide: drawingFrom.side as any,
        toId: noteId,
        toSide: side as any,
        type: 'straight',
        style: 'solid',
        isDoubleHeaded: false,
        color: activeColor === "#ffffff" ? "#2ecc71" : activeColor
      };

      setConnections([...connections, newConn]);
      setDrawingFrom(null);
      setTempEndPoint(null);
      setSelectedConnId(newConn.id);
    }
  };

  const createSticky = (x: number, y: number) => {
    const id = Date.now().toString();
    const newNote: StickyNote = { 
      id, title: "New Sticky", content: "", 
      x: (x - camera.x) / camera.zoom, 
      y: (y - camera.y) / camera.zoom, 
      width: 250, height: 150 
    };
    setNotes(prev => [...prev, newNote]);
    setActiveNoteId(id);
  };

  const deleteSticky = (id: string) => {
    setNotes(prev => prev.filter(n => n.id !== id));
    setConnections(prev => prev.filter(c => c.fromId !== id && c.toId !== id));
    if (activeNoteId === id) setActiveNoteId(null);
  };

  const finalizeRename = (id: string, newTitle: string) => {
    if (!renamingNoteId) return;
    requestAnimationFrame(() => {
      setNotes(prev => prev.map(n => n.id === id ? { ...n, title: newTitle } : n));
      setRenamingNoteId(null);
    });
  };

  return (
    <main className="container" 
      onMouseMove={(e) => {
        if (renamingNoteId) return;
        if (drawingFrom) {
            const rect = canvasRef.current?.getBoundingClientRect();
            if (!rect) return;
            setTempEndPoint({ 
                x: (e.clientX - rect.left - camera.x) / camera.zoom, 
                y: (e.clientY - rect.top - camera.y) / camera.zoom 
            });
            return;
        }
        if (resizingNote) {
          const { id, edge } = resizingNote;
          setNotes(prev => prev.map(n => {
            if (n.id !== id) return n;
            let { x, y, width, height } = n;
            const dx = e.movementX / camera.zoom; const dy = e.movementY / camera.zoom;
            if (edge.includes('right')) width += dx; if (edge.includes('bottom')) height += dy;
            if (edge.includes('left')) { x += dx; width -= dx; } if (edge.includes('top')) { y += dy; height -= dy; }
            return { ...n, x, y, width: Math.max(150, width), height: Math.max(100, height) };
          }));
          return;
        }
        if (draggedNote) {
          setNotes(prev => prev.map(n => n.id === draggedNote ? { ...n, x: n.x + e.movementX / camera.zoom, y: n.y + e.movementY / camera.zoom } : n));
          return;
        }
        if (isPanning && !activeNoteId) {
          setCamera(prev => ({ ...prev, x: prev.x + e.movementX, y: prev.y + e.movementY }));
        }
      }}
      onMouseUp={() => { 
        setIsPanning(false); setDraggedNote(null); setResizingNote(null); 
      }}
      onClick={(e) => {
        setMenu(prev => ({ ...prev, visible: false }));
        // Only cancel arrow drawing if clicking something that isn't a node
        const target = e.target as HTMLElement;
        if (!target.classList.contains('snap-point')) {
          setDrawingFrom(null);
          setTempEndPoint(null);
        }
      }}
    >
      <div className="sidebar" style={{ width: sidebarWidth }}>
        <div className="sidebar-header"><span className="vault-title">{vaultName}</span></div>
        <div className="resizer-v" onMouseDown={(e) => {
          const onMove = (m: MouseEvent) => setSidebarWidth(m.clientX);
          const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
          document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
        }} />
      </div>

      <div className="workspace">
        <div 
          className={`canvas-container ${activeNoteId ? 'panning-locked' : ''}`}
          ref={canvasRef} 
          onMouseDown={(e) => {
            if (activeNoteId || renamingNoteId) return;
            if (e.button === 1) { setIsPanning(true); e.preventDefault(); }
            if (e.button === 0 && e.target === canvasRef.current) {
              setActiveNoteId(null); setSelectedConnId(null);
            }
          }}
          onDoubleClick={(e) => {
             if (e.target === canvasRef.current) {
               setActiveNoteId(null); setRenamingNoteId(null); setSelectedConnId(null); setArrowToolActive(false);
             }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            if (!activeNoteId && e.target === canvasRef.current) {
              setMenu({ x: e.pageX, y: e.pageY, visible: true, target: "", type: "space" });
            }
          }}
        >
          <div className="canvas-toolbar">
            <div className="toolbar-group">
                <button className={`tool ${activeFormats.includes("bold") ? "active-toggled" : ""}`} onMouseDown={(e) => applyFormat(e, "bold")}><b>B</b></button>
                <button className={`tool ${activeFormats.includes("italic") ? "active-toggled" : ""}`} onMouseDown={(e) => applyFormat(e, "italic")}><i>I</i></button>
                <button className={`tool ${activeFormats.includes("underline") ? "active-toggled" : ""}`} onMouseDown={(e) => applyFormat(e, "underline")}><u>U</u></button>
            </div>
            
            <div className="tool-divider" />
            
            <div className="toolbar-group">
                {["#2ecc71", "#e74c3c", "#3498db", "#ffffff"].map(color => (
                <div key={color} className={`swatch ${activeColor === color ? 'selected' : ''}`} 
                     style={{ backgroundColor: color }} 
                     onMouseDown={(e) => applyFormat(e, "foreColor", color)} 
                />
                ))}
            </div>
            
            <div className="tool-divider" />
            <button className={`tool ${arrowToolActive ? "active-toggled" : ""}`} onClick={() => setArrowToolActive(!arrowToolActive)}>↗</button>

            {arrowToolActive && (
                <div className="arrow-submenu">
                    <div className="tool-divider" />
                    <div className="toolbar-group">
                        <button className="tool" title="Bezier/Straight" onClick={() => selectedConnId && setConnections(connections.map(c => c.id === selectedConnId ? { ...c, type: c.type === 'straight' ? 'bezier' : 'straight' } : c))}>⌇</button>
                        <button className="tool" title="Solid/Dashed" onClick={() => selectedConnId && setConnections(connections.map(c => c.id === selectedConnId ? { ...c, style: c.style === 'solid' ? 'dashed' : 'solid' } : c))}>--</button>
                        <button className="tool" title="Double Head" onClick={() => selectedConnId && setConnections(connections.map(c => c.id === selectedConnId ? { ...c, isDoubleHeaded: !c.isDoubleHeaded } : c))}>↔</button>
                        <button className="tool delete" onClick={() => selectedConnId && setConnections(connections.filter(c => c.id !== selectedConnId))}>✕</button>
                    </div>
                </div>
            )}
          </div>

          <svg className="snap-layer" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`, transformOrigin: '0 0' }}>
            <defs>
              <marker id="arrowhead-end" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                <polygon points="0 0, 10 3.5, 0 7" fill="context-stroke" />
              </marker>
              <marker id="arrowhead-start" markerWidth="10" markerHeight="7" refX="1" refY="3.5" orient="auto-start-reverse">
                <polygon points="10 0, 0 3.5, 10 7" fill="context-stroke" />
              </marker>
            </defs>
            {connections.map(conn => {
              const fromNote = notes.find(n => n.id === conn.fromId);
              const toNote = notes.find(n => n.id === conn.toId);
              if (!fromNote || !toNote) return null;
              
              const start = getSnapPoint(fromNote, conn.fromSide);
              const end = getSnapPoint(toNote, conn.toSide);
              const offset = 60;
              
              const pathData = conn.type === 'straight' 
                ? `M ${start.x} ${start.y} L ${end.x} ${end.y}`
                : `M ${start.x} ${start.y} C ${start.x + (conn.fromSide === 'right' ? offset : conn.fromSide === 'left' ? -offset : 0)} ${start.y + (conn.fromSide === 'bottom' ? offset : conn.fromSide === 'top' ? -offset : 0)}, ${end.x + (conn.toSide === 'right' ? offset : conn.toSide === 'left' ? -offset : 0)} ${end.y + (conn.toSide === 'bottom' ? offset : conn.toSide === 'top' ? -offset : 0)}, ${end.x} ${end.y}`;
              
              return (
                <path key={conn.id} d={pathData} stroke={selectedConnId === conn.id ? "#fff" : conn.color} strokeWidth={selectedConnId === conn.id ? "3" : "2"} fill="none"
                  strokeDasharray={conn.style === 'dashed' ? "6,6" : "0"}
                  markerEnd="url(#arrowhead-end)" 
                  markerStart={conn.isDoubleHeaded ? "url(#arrowhead-start)" : ""}
                  onClick={(e) => { e.stopPropagation(); setSelectedConnId(conn.id); setArrowToolActive(true); }}
                  className={`connection-path ${selectedConnId === conn.id ? 'selected' : ''}`}
                  style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                />
              );
            })}
            {drawingFrom && tempEndPoint && (
              <line x1={drawingFrom.x} y1={drawingFrom.y} x2={tempEndPoint.x} y2={tempEndPoint.y} stroke={activeColor} strokeWidth="2" strokeDasharray="4,4" />
            )}
          </svg>

          <div className="canvas-content" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`, transformOrigin: '0 0' }}>
            {notes.map((note) => (
              <div key={note.id} className={`sticky-note ${activeNoteId === note.id ? 'active' : ''} ${renamingNoteId === note.id ? 'renaming' : ''}`}
                style={{ left: note.x, top: note.y, width: note.width, height: note.height }}
              >
                {arrowToolActive && ['top', 'bottom', 'left', 'right'].map(side => (
                    <div key={side} className={`snap-point ${side} ${drawingFrom?.id === note.id && drawingFrom?.side === side ? 'node-selected' : ''}`} 
                         onClick={(e) => handleSnapClick(note.id, side, e)}
                    />
                ))}
                <div className="sticky-top-shade" />
                <div className="resizer-edge top" onMouseDown={() => setResizingNote({id: note.id, edge: 'top'})} />
                <div className="resizer-edge bottom" onMouseDown={() => setResizingNote({id: note.id, edge: 'bottom'})} />
                <div className="resizer-edge left" onMouseDown={() => setResizingNote({id: note.id, edge: 'left'})} />
                <div className="resizer-edge right" onMouseDown={() => setResizingNote({id: note.id, edge: 'right'})} />
                <div className="sticky-resize-handle" onMouseDown={(e) => { e.stopPropagation(); setResizingNote({id: note.id, edge: 'bottom-right'}); }} />
                
                <div className="sticky-header-label" 
                     onMouseDown={(e) => {
                        if (renamingNoteId || arrowToolActive) return;
                        setDraggedNote(note.id); setActiveNoteId(note.id);
                     }}
                     onDoubleClick={(e) => { e.stopPropagation(); setRenamingNoteId(note.id); }}>
                  {renamingNoteId === note.id ? (
                    <input autoFocus className="sticky-title-input" defaultValue={note.title}
                      onMouseDown={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') finalizeRename(note.id, e.currentTarget.value);
                        if (e.key === 'Escape') setRenamingNoteId(null);
                      }}
                      onBlur={(e) => finalizeRename(note.id, e.currentTarget.value)}
                    />
                  ) : (<span>{note.title}</span>)}
                </div>
                <div className="sticky-input" contentEditable={activeNoteId === note.id && !renamingNoteId}
                  suppressContentEditableWarning
                  onMouseDown={() => !arrowToolActive && setActiveNoteId(note.id)}
                  ref={(el) => { if (el && el.innerHTML !== note.content && activeNoteId !== note.id) el.innerHTML = note.content; }}
                  onInput={(e) => { note.content = (e.target as HTMLElement).innerHTML; }}
                  onBlur={(e) => {
                    const html = (e.target as HTMLElement).innerHTML;
                    setNotes(prev => prev.map(n => n.id === note.id ? { ...n, content: html } : n));
                  }}
                />
              </div>
            ))}
          </div>
        </div>
        <div className="resizer-h" onMouseDown={(e) => {
          const startY = e.clientY; const startH = graphHeight;
          const onMove = (m: MouseEvent) => setGraphHeight(startH - (m.clientY - startY));
          const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
          document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
        }} />
        <div className="graph-section" style={{ height: graphHeight }}><div className="section-header">Graph View</div></div>
      </div>

      {menu.visible && (
        <div className="context-menu" style={{ top: menu.y, left: menu.x }}>
          {menu.type === "space" ? (<div className="menu-item" onClick={() => createSticky(menu.x, menu.y)}>New Sticky Note</div>) 
          : (<div className="menu-item delete" onClick={() => deleteSticky(menu.target)}>Delete Note</div>)}
        </div>
      )}
    </main>
  );
}

export default App;