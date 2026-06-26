import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type {
  Annotation,
  CapturePayload,
  EditorTool,
  Point,
} from "../types";

interface Props {
  capture: CapturePayload;
  onClose: () => void;
  onNotify: (message: string) => void;
}

interface Pan {
  x: number;
  y: number;
}

const MIN_ZOOM = 0.04;
const MAX_ZOOM = 8;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedRect(annotation: {
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  return {
    x: Math.min(annotation.x, annotation.x + annotation.width),
    y: Math.min(annotation.y, annotation.y + annotation.height),
    width: Math.abs(annotation.width),
    height: Math.abs(annotation.height),
  };
}

function AnnotationEditor({ capture, onClose, onNotify }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<EditorTool>("arrow");
  const [color, setColor] = useState("#ff4d5e");
  const [strokeWidth, setStrokeWidth] = useState(5);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [redoStack, setRedoStack] = useState<Annotation[]>([]);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const [initialized, setInitialized] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [panning, setPanning] = useState(false);
  const [spacePressed, setSpacePressed] = useState(false);
  const [processing, setProcessing] = useState(false);
  const pointerStartRef = useRef<Point>({ x: 0, y: 0 });
  const panStartRef = useRef<Pan>({ x: 0, y: 0 });

  const fitWidth = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const nextZoom = clamp(
      (viewport.clientWidth - 80) / capture.width,
      MIN_ZOOM,
      1,
    );
    setZoom(nextZoom);
    setPan({
      x: (viewport.clientWidth - capture.width * nextZoom) / 2,
      y: 42,
    });
  }, [capture.width]);

  const fitAll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const nextZoom = clamp(
      Math.min(
        (viewport.clientWidth - 80) / capture.width,
        (viewport.clientHeight - 80) / capture.height,
        1,
      ),
      MIN_ZOOM,
      1,
    );
    setZoom(nextZoom);
    setPan({
      x: (viewport.clientWidth - capture.width * nextZoom) / 2,
      y: (viewport.clientHeight - capture.height * nextZoom) / 2,
    });
  }, [capture.height, capture.width]);

  useEffect(() => {
    if (initialized) return;
    const frame = requestAnimationFrame(() => {
      if (capture.height > capture.width * 1.6) fitWidth();
      else fitAll();
      setInitialized(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [capture.height, capture.width, fitAll, fitWidth, initialized]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        setSpacePressed(true);
        event.preventDefault();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        if (!processing) void completeAndCopy();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!processing) void saveImage();
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpacePressed(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  });

  function viewportPoint(event: React.PointerEvent | React.WheelEvent): Point {
    const bounds = viewportRef.current!.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function imagePoint(event: React.PointerEvent): Point {
    const point = viewportPoint(event);
    return {
      x: clamp((point.x - pan.x) / zoom, 0, capture.width),
      y: clamp((point.y - pan.y) / zoom, 0, capture.height),
    };
  }

  function onWheel(event: React.WheelEvent) {
    event.preventDefault();
    const cursor = viewportPoint(event);
    const imageX = (cursor.x - pan.x) / zoom;
    const imageY = (cursor.y - pan.y) / zoom;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const nextZoom = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    setZoom(nextZoom);
    setPan({
      x: cursor.x - imageX * nextZoom,
      y: cursor.y - imageY * nextZoom,
    });
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (processing) return;
    const shouldPan = tool === "pan" || spacePressed || event.button === 1;
    if (shouldPan) {
      setPanning(true);
      pointerStartRef.current = viewportPoint(event);
      panStartRef.current = pan;
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    const point = imagePoint(event);
    pointerStartRef.current = point;
    setDrawing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "rect") {
      setDraft({
        type: "rect",
        x: point.x,
        y: point.y,
        width: 0,
        height: 0,
        color,
        strokeWidth,
      });
    } else if (tool === "mosaic") {
      setDraft({
        type: "mosaic",
        x: point.x,
        y: point.y,
        width: 0,
        height: 0,
        blockSize: Math.max(8, Math.round(strokeWidth * 2.4)),
      });
    } else if (tool === "arrow") {
      setDraft({
        type: "arrow",
        start: point,
        end: point,
        color,
        strokeWidth,
      });
    } else if (tool === "pen") {
      setDraft({ type: "pen", points: [point], color, strokeWidth });
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (panning) {
      const point = viewportPoint(event);
      setPan({
        x: panStartRef.current.x + point.x - pointerStartRef.current.x,
        y: panStartRef.current.y + point.y - pointerStartRef.current.y,
      });
      return;
    }
    if (!drawing || !draft) return;
    const point = imagePoint(event);
    if (draft.type === "rect" || draft.type === "mosaic") {
      setDraft({
        ...draft,
        width: point.x - pointerStartRef.current.x,
        height: point.y - pointerStartRef.current.y,
      });
    } else if (draft.type === "arrow") {
      setDraft({ ...draft, end: point });
    } else if (draft.type === "pen") {
      const previous = draft.points[draft.points.length - 1];
      if (Math.hypot(point.x - previous.x, point.y - previous.y) > 1.5 / zoom) {
        setDraft({ ...draft, points: [...draft.points, point] });
      }
    }
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (panning) {
      setPanning(false);
      event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (!drawing) return;
    setDrawing(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (draft && isMeaningful(draft)) {
      setAnnotations((items) => [...items, draft]);
      setRedoStack([]);
    }
    setDraft(null);
  }

  function isMeaningful(annotation: Annotation) {
    if (annotation.type === "pen") return annotation.points.length > 1;
    if (annotation.type === "arrow") {
      return Math.hypot(
        annotation.end.x - annotation.start.x,
        annotation.end.y - annotation.start.y,
      ) > 3;
    }
    return Math.abs(annotation.width) > 3 && Math.abs(annotation.height) > 3;
  }

  function undo() {
    setAnnotations((items) => {
      const last = items[items.length - 1];
      if (!last) return items;
      setRedoStack((redoItems) => [...redoItems, last]);
      return items.slice(0, -1);
    });
  }

  function redo() {
    setRedoStack((items) => {
      const last = items[items.length - 1];
      if (!last) return items;
      setAnnotations((annotationItems) => [...annotationItems, last]);
      return items.slice(0, -1);
    });
  }

  async function renderCurrent() {
    const renderAnnotations = annotations.map((annotation) => {
      if (annotation.type === "rect") {
        const { strokeWidth, ...rest } = annotation;
        return { ...rest, stroke_width: strokeWidth };
      }
      if (annotation.type === "arrow") {
        const { strokeWidth, ...rest } = annotation;
        return { ...rest, stroke_width: strokeWidth };
      }
      if (annotation.type === "pen") {
        const { strokeWidth, ...rest } = annotation;
        return { ...rest, stroke_width: strokeWidth };
      }
      const { blockSize, ...rest } = annotation;
      return { ...rest, block_size: blockSize };
    });

    return invoke<string>("render_annotations", {
      sourceDataUrl: capture.dataUrl,
      annotations: renderAnnotations,
    });
  }

  async function completeAndCopy() {
    setProcessing(true);
    onNotify("正在渲染并复制图片…");
    try {
      const output = await renderCurrent();
      await invoke("copy_png_to_clipboard", { dataUrl: output });
      onNotify("图片已复制到剪贴板，可以直接粘贴");
    } catch (error) {
      onNotify(`复制失败：${String(error)}`);
    } finally {
      setProcessing(false);
    }
  }

  async function saveImage() {
    try {
      const path = await save({
        defaultPath: `ScreenShot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
        filters: [{ name: "PNG 图片", extensions: ["png"] }],
      });
      if (!path) {
        return;
      }
      setProcessing(true);
      onNotify("正在渲染并保存图片…");
      const output = await renderCurrent();
      await invoke("save_png", { path, dataUrl: output });
      onNotify("PNG 已保存");
    } catch (error) {
      onNotify(`保存失败：${String(error)}`);
    } finally {
      setProcessing(false);
    }
  }

  function zoomBy(factor: number) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const center = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
    const imageX = (center.x - pan.x) / zoom;
    const imageY = (center.y - pan.y) / zoom;
    const nextZoom = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    setZoom(nextZoom);
    setPan({ x: center.x - imageX * nextZoom, y: center.y - imageY * nextZoom });
  }

  const allAnnotations = useMemo(
    () => (draft ? [...annotations, draft] : annotations),
    [annotations, draft],
  );

  return (
    <main className="editor-shell">
      <header className="editor-header">
        <button className="ghost-button" onClick={onClose} disabled={processing}>
          ← 返回
        </button>
        <div className="editor-title">
          <strong>{capture.captureKind === "long" ? "滚动长截图" : "截图预览"}</strong>
          <span>
            {capture.width} × {capture.height}px
          </span>
        </div>
        <div className="zoom-controls">
          <button onClick={() => zoomBy(0.85)}>−</button>
          <output>{Math.round(zoom * 100)}%</output>
          <button onClick={() => zoomBy(1.18)}>＋</button>
          <button onClick={fitWidth}>适合宽度</button>
          <button onClick={fitAll}>显示全部</button>
        </div>
        <div className="editor-actions">
          <button className="secondary-button" onClick={saveImage} disabled={processing}>
            另存为
          </button>
          <button className="primary-button" onClick={completeAndCopy} disabled={processing}>
            {processing ? "处理中…" : "完成并复制"}
          </button>
        </div>
      </header>

      <aside className="annotation-toolbar">
        <ToolButton tool="pan" current={tool} setTool={setTool} icon="✥" label="移动" />
        <ToolButton tool="arrow" current={tool} setTool={setTool} icon="↗" label="箭头" />
        <ToolButton tool="rect" current={tool} setTool={setTool} icon="□" label="矩形" />
        <ToolButton tool="pen" current={tool} setTool={setTool} icon="⌁" label="画笔" />
        <ToolButton tool="mosaic" current={tool} setTool={setTool} icon="▦" label="打码" />
        <div className="toolbar-divider" />
        <label className="color-control" title="标注颜色">
          <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
          <span style={{ background: color }} />
        </label>
        <label className="stroke-control" title="线条粗细">
          <span>{strokeWidth}</span>
          <input
            type="range"
            min="2"
            max="18"
            value={strokeWidth}
            onChange={(event) => setStrokeWidth(Number(event.target.value))}
          />
        </label>
        <div className="toolbar-divider" />
        <button className="tool-button" onClick={undo} disabled={!annotations.length} title="撤销">
          <b>↶</b><small>撤销</small>
        </button>
        <button className="tool-button" onClick={redo} disabled={!redoStack.length} title="重做">
          <b>↷</b><small>重做</small>
        </button>
      </aside>

      <div
        ref={viewportRef}
        className={`image-viewport tool-${tool} ${panning ? "is-panning" : ""}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div
          className="image-stage"
          style={{
            width: capture.width,
            height: capture.height,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          <img src={capture.dataUrl} draggable={false} alt="Screenshot preview" />
          <svg
            className="annotation-layer"
            width={capture.width}
            height={capture.height}
            viewBox={`0 0 ${capture.width} ${capture.height}`}
          >
            <defs>
              <pattern id="mosaic-pattern" width="18" height="18" patternUnits="userSpaceOnUse">
                <rect width="9" height="9" fill="#1f2937" />
                <rect x="9" y="9" width="9" height="9" fill="#1f2937" />
                <rect x="9" width="9" height="9" fill="#94a3b8" />
                <rect y="9" width="9" height="9" fill="#94a3b8" />
              </pattern>
            </defs>
            {allAnnotations.map((annotation, index) => (
              <AnnotationShape key={index} annotation={annotation} />
            ))}
          </svg>
        </div>
        <div className="viewport-help">滚轮缩放 · 空格/中键拖动 · Ctrl/Cmd+Z 撤销</div>
      </div>
    </main>
  );
}

function ToolButton({
  tool,
  current,
  setTool,
  icon,
  label,
}: {
  tool: EditorTool;
  current: EditorTool;
  setTool: (tool: EditorTool) => void;
  icon: string;
  label: string;
}) {
  return (
    <button
      className={`tool-button ${current === tool ? "active" : ""}`}
      onClick={() => setTool(tool)}
      title={label}
    >
      <b>{icon}</b>
      <small>{label}</small>
    </button>
  );
}

function AnnotationShape({ annotation }: { annotation: Annotation }) {
  if (annotation.type === "rect") {
    const rect = normalizedRect(annotation);
    return (
      <rect
        {...rect}
        fill="none"
        stroke={annotation.color}
        strokeWidth={annotation.strokeWidth}
      />
    );
  }
  if (annotation.type === "mosaic") {
    const rect = normalizedRect(annotation);
    return <rect {...rect} fill="url(#mosaic-pattern)" stroke="#ffffff" />;
  }
  if (annotation.type === "pen") {
    return (
      <polyline
        points={annotation.points.map((point) => `${point.x},${point.y}`).join(" ")}
        fill="none"
        stroke={annotation.color}
        strokeWidth={annotation.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }
  const angle = Math.atan2(
    annotation.end.y - annotation.start.y,
    annotation.end.x - annotation.start.x,
  );
  const head = Math.max(14, annotation.strokeWidth * 4.5);
  const left = {
    x: annotation.end.x + Math.cos(angle + 2.55) * head,
    y: annotation.end.y + Math.sin(angle + 2.55) * head,
  };
  const right = {
    x: annotation.end.x + Math.cos(angle - 2.55) * head,
    y: annotation.end.y + Math.sin(angle - 2.55) * head,
  };
  return (
    <g stroke={annotation.color} strokeWidth={annotation.strokeWidth} strokeLinecap="round">
      <line x1={annotation.start.x} y1={annotation.start.y} x2={annotation.end.x} y2={annotation.end.y} />
      <line x1={annotation.end.x} y1={annotation.end.y} x2={left.x} y2={left.y} />
      <line x1={annotation.end.x} y1={annotation.end.y} x2={right.x} y2={right.y} />
    </g>
  );
}

export default AnnotationEditor;
