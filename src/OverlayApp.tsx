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
  const [dragging, setDragging] = useState(false);
  const [operation, setOperation] = useState<CaptureAction | null>(null);
  const [instruction, setInstruction] = useState<string | null>(null);
  const revealedSession = useRef<number | null>(null);
  const processingSession = useRef<number | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarSize, setToolbarSize] = useState({ width: 360, height: 48 });
  const processing = operation !== null;

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
      setSnapshot(null);
      setStart(null);
      setEnd(null);
      setDragging(false);
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

  function pointerPosition(event: React.PointerEvent): Point {
    return {
      x: Math.max(0, Math.min(window.innerWidth, event.clientX)),
      y: Math.max(0, Math.min(window.innerHeight, event.clientY)),
    };
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (processingSession.current !== null || event.button !== 0) return;
    const point = pointerPosition(event);
    setStart(point);
    setEnd(point);
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (dragging) setEnd(pointerPosition(event));
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    setEnd(pointerPosition(event));
    setDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
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
    if (!region || processingSession.current !== null) return;
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
      className="capture-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
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
            <i className="handle nw" />
            <i className="handle ne" />
            <i className="handle sw" />
            <i className="handle se" />
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
        <span>拖动框选 · Enter 复制 · 右键或 Esc 取消</span>
      </div>
      {instruction && <div className="overlay-instruction">{instruction}</div>}
    </div>
  );
}

export default OverlayApp;
