import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CaptureRegion, OverlaySnapshot, Point } from "./types";

interface Selection {
  x: number;
  y: number;
  width: number;
  height: number;
}

type CaptureAction = "copy" | "edit" | "long";
type SelectionCorner = "nw" | "ne" | "sw" | "se";

interface DragSession {
  pointerId: number;
  offset: Point;
}

const selectionCorners = [
  { corner: "nw", label: "左上角" },
  { corner: "ne", label: "右上角" },
  { corner: "sw", label: "左下角" },
  { corner: "se", label: "右下角" },
] as const;

function normalizeSelection(start: Point, end: Point): Selection {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function OverlayApp() {
  const monitorId = Number(
    new URLSearchParams(window.location.search).get("monitorId"),
  );
  const [snapshot, setSnapshot] = useState<OverlaySnapshot | null>(null);
  const [start, setStart] = useState<Point | null>(null);
  const [end, setEnd] = useState<Point | null>(null);
  const [dragMode, setDragMode] = useState<"select" | "resize" | null>(null);
  const [operation, setOperation] = useState<CaptureAction | null>(null);
  const [instruction, setInstruction] = useState<string | null>(null);
  const revealedSession = useRef<number | null>(null);
  const processingSession = useRef<number | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragSession = useRef<DragSession | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarSize, setToolbarSize] = useState({ width: 360, height: 48 });
  const processing = operation !== null;
  const dragging = dragMode !== null;

  const selection = useMemo(
    () => (start && end ? normalizeSelection(start, end) : null),
    [start, end],
  );
  const showToolbar = !!selection && selection.width >= 8 && selection.height >= 8 && !dragging;

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const measure = () => setToolbarSize({ width: toolbar.offsetWidth, height: toolbar.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [showToolbar]);

  useEffect(() => {
    let active = true;
    let request = 0;
    const reset = () => {
      request += 1;
      revealedSession.current = null;
      processingSession.current = null;
      stopDragging();
      setSnapshot(null);
      setStart(null);
      setEnd(null);
      setOperation(null);
      setInstruction(null);
    };
    const refresh = async (quiet = false) => {
      reset();
      const current = request;
      try {
        const next = await invoke<OverlaySnapshot>("get_overlay_snapshot", { monitorId });
        if (active && current === request) setSnapshot(next);
      } catch (error) {
        // Prewarmed windows intentionally have no screenshot until capture starts.
        if (active && current === request && !quiet) setInstruction(String(error));
      }
    };
    const unlisteners = Promise.all([
      listen("overlay-reset", reset),
      listen("overlay-refresh", () => { void refresh(); }),
    ]);
    void unlisteners.then(() => { if (active) void refresh(true); });
    return () => {
      active = false;
      request += 1;
      void unlisteners.then((items) => items.forEach((unlisten) => unlisten()));
    };
  }, [monitorId]);

  async function revealOverlayWindow(sessionId: number) {
    if (revealedSession.current === sessionId) return;
    revealedSession.current = sessionId;
    try {
      await invoke("show_overlay_window", { monitorId, sessionId });
    } catch (error) {
      if (revealedSession.current === sessionId) {
        revealedSession.current = null;
        setInstruction(String(error));
      }
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || processingSession.current !== null) return;
      if (event.key === "Escape") {
        void invoke("cancel_capture");
      }
      if (event.key === "Enter" && showToolbar &&
        !(event.target instanceof Element && event.target.closest("button"))) {
        event.preventDefault();
        void finish("copy");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function pointerPosition(event: React.PointerEvent, offset: Point = { x: 0, y: 0 }): Point {
    return {
      x: Math.max(0, Math.min(window.innerWidth, event.clientX + offset.x)),
      y: Math.max(0, Math.min(window.innerHeight, event.clientY + offset.y)),
    };
  }

  function stopDragging() {
    const current = dragSession.current;
    dragSession.current = null;
    setDragMode(null);
    if (current && overlayRef.current?.hasPointerCapture(current.pointerId)) {
      overlayRef.current.releasePointerCapture(current.pointerId);
    }
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (processingSession.current !== null || dragSession.current || event.button !== 0) return;
    const point = pointerPosition(event);
    dragSession.current = { pointerId: event.pointerId, offset: { x: 0, y: 0 } };
    setStart(point);
    setEnd(point);
    setDragMode("select");
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onResizePointerDown(event: React.PointerEvent<HTMLButtonElement>, corner: SelectionCorner) {
    event.stopPropagation();
    event.preventDefault();
    if (!selection || processingSession.current !== null || dragSession.current || event.button !== 0) return;
    const point = {
      x: selection.x + (corner.endsWith("e") ? selection.width : 0),
      y: selection.y + (corner.startsWith("s") ? selection.height : 0),
    };
    const anchor = {
      x: selection.x + (corner.endsWith("w") ? selection.width : 0),
      y: selection.y + (corner.startsWith("n") ? selection.height : 0),
    };
    // Keep the grab offset so clicking the enlarged handle does not move the corner.
    dragSession.current = {
      pointerId: event.pointerId,
      offset: { x: point.x - event.clientX, y: point.y - event.clientY },
    };
    setStart(anchor);
    setEnd(point);
    setDragMode("resize");
    overlayRef.current?.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const current = dragSession.current;
    if (current?.pointerId === event.pointerId) setEnd(pointerPosition(event, current.offset));
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const current = dragSession.current;
    if (current?.pointerId !== event.pointerId) return;
    setEnd(pointerPosition(event, current.offset));
    stopDragging();
  }

  function onPointerCancel(event: React.PointerEvent<HTMLDivElement>) {
    if (dragSession.current?.pointerId === event.pointerId) stopDragging();
  }

  function toPhysicalRegion(): CaptureRegion | null {
    if (!snapshot || !selection || selection.width < 8 || selection.height < 8) {
      return null;
    }
    const scaleX = snapshot.width / window.innerWidth;
    const scaleY = snapshot.height / window.innerHeight;
    const x = Math.max(0, Math.round(selection.x * scaleX));
    const y = Math.max(0, Math.round(selection.y * scaleY));
    return {
      sessionId: snapshot.sessionId,
      monitorId,
      x,
      y,
      width: Math.min(snapshot.width - x, Math.round(selection.width * scaleX)),
      height: Math.min(snapshot.height - y, Math.round(selection.height * scaleY)),
    };
  }

  async function finish(kind: CaptureAction) {
    const region = toPhysicalRegion();
    if (!region || processingSession.current !== null || dragSession.current) return;
    processingSession.current = region.sessionId;
    setOperation(kind);
    setInstruction(null);
    try {
      if (kind === "long") {
        setInstruction("准备好了：窗口消失后缓慢向下滚动，再按相同快捷键停止");
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (processingSession.current !== region.sessionId) return;
        await invoke("start_long_capture", { region });
      } else {
        await invoke(kind === "copy" ? "copy_region_to_clipboard" : "finish_region_capture", { region });
      }
    } catch (error) {
      if (processingSession.current === region.sessionId) {
        processingSession.current = null;
        setOperation(null);
        setInstruction(`${kind === "copy" ? "复制失败：" : ""}${String(error)}`);
      }
    }
  }

  if (!snapshot) {
    return <div className="overlay-loading">正在准备截图…</div>;
  }

  const toolbarLeft = selection
    ? Math.max(12, Math.min(window.innerWidth - toolbarSize.width - 12, selection.x))
    : 12;
  const toolbarTop = selection
    ? Math.max(12, Math.min(window.innerHeight - toolbarSize.height - 12,
        selection.y + selection.height + 12 + toolbarSize.height <= window.innerHeight - 12
          ? selection.y + selection.height + 12
          : selection.y - toolbarSize.height - 12))
    : 12;

  return (
    <div
      ref={overlayRef}
      className={`capture-overlay${dragMode === "resize" ? " resizing" : ""}`}
      style={{ cursor: dragMode === "resize" && start && end
        ? (end.x < start.x) === (end.y < start.y) ? "nwse-resize" : "nesw-resize"
        : undefined }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onContextMenu={(event) => {
        event.preventDefault();
        if (processingSession.current === null) void invoke("cancel_capture");
      }}
    >
      <img
        key={snapshot.sessionId}
        src={snapshot.dataUrl}
        draggable={false}
        onLoad={async () => {
          await revealOverlayWindow(snapshot.sessionId);
        }}
        alt="Frozen screen"
      />

      {selection ? (
        <>
          <div className="shade top" style={{ height: selection.y }} />
          <div
            className="shade bottom"
            style={{ top: selection.y + selection.height }}
          />
          <div
            className="shade left"
            style={{
              top: selection.y,
              width: selection.x,
              height: selection.height,
            }}
          />
          <div
            className="shade right"
            style={{
              top: selection.y,
              left: selection.x + selection.width,
              height: selection.height,
            }}
          />
          <div
            className="selection-box"
            style={{
              left: selection.x,
              top: selection.y,
              width: selection.width,
              height: selection.height,
            }}
          >
            <span className="selection-size">
              {Math.round(selection.width * (snapshot.width / window.innerWidth))} ×{" "}
              {Math.round(selection.height * (snapshot.height / window.innerHeight))}
            </span>
            {selectionCorners.map(({ corner, label }) => (
              <button key={corner} type="button" className={`handle ${corner}`}
                aria-label={`拖动${label}调整选区`} title={`拖动${label}调整选区`}
                tabIndex={-1} disabled={processing}
                onPointerDown={(event) => onResizePointerDown(event, corner)} />
            ))}
          </div>
        </>
      ) : (
        <div className="shade full" />
      )}

      {showToolbar && (
        <div
          ref={toolbarRef}
          className="capture-toolbar"
          style={{ left: toolbarLeft, top: toolbarTop }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button className="accent" disabled={processing} onClick={() => finish("copy")}
            title="直接复制选区截图（Enter）">
            {operation === "copy" ? "正在复制…" : "完成并复制"}
          </button>
          <button disabled={processing} onClick={() => finish("edit")}
            title="打开编辑器添加文字、箭头等标注">
            编辑截图
          </button>
          <button
            disabled={processing}
            onClick={() => finish("long")}
          >
            滚动长截图
          </button>
          <button className="icon-only" disabled={processing} aria-label="取消截图"
            onClick={() => invoke("cancel_capture")}>
            Esc
          </button>
        </div>
      )}

      <div className="overlay-hint">
        <strong>{snapshot.name}</strong>
        <span>拖动框选 · 拖动四角调整 · Enter 复制 · Esc 取消</span>
      </div>
      {instruction && <div className="overlay-instruction">{instruction}</div>}
    </div>
  );
}

export default OverlayApp;
