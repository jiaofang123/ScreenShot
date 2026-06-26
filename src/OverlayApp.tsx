import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CaptureRegion, OverlaySnapshot, Point } from "./types";

interface Selection {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  const [processing, setProcessing] = useState(false);
  const [instruction, setInstruction] = useState<string | null>(null);

  const selection = useMemo(
    () => (start && end ? normalizeSelection(start, end) : null),
    [start, end],
  );

  useEffect(() => {
    invoke<OverlaySnapshot>("get_overlay_snapshot", { monitorId })
      .then(setSnapshot)
      .catch(async (error) => {
        console.error(error);
        await invoke("cancel_capture");
      });
  }, [monitorId]);

  async function revealOverlayWindow() {
    await invoke("show_overlay_window", { monitorId });
  }

  useEffect(() => {
    if (!snapshot) return;
    const timer = window.setTimeout(() => {
      void revealOverlayWindow();
    }, 60);
    return () => window.clearTimeout(timer);
  }, [snapshot]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        invoke("cancel_capture");
      }
      if (event.key === "Enter" && selection && selection.width >= 8) {
        void finish("normal");
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
    if (processing || event.button !== 0) return;
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
      monitorId,
      x,
      y,
      width: Math.min(snapshot.width - x, Math.round(selection.width * scaleX)),
      height: Math.min(snapshot.height - y, Math.round(selection.height * scaleY)),
    };
  }

  async function finish(kind: "normal" | "long") {
    const region = toPhysicalRegion();
    if (!region || processing) return;
    setProcessing(true);
    try {
      if (kind === "long") {
        setInstruction("准备好了：窗口消失后缓慢向下滚动，再按相同快捷键停止");
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        await invoke("start_long_capture", { region });
      } else {
        await invoke("finish_region_capture", { region });
      }
    } catch (error) {
      setProcessing(false);
      setInstruction(String(error));
    }
  }

  if (!snapshot) {
    return null;
  }

  const toolbarLeft = selection
    ? Math.max(12, Math.min(window.innerWidth - 330, selection.x))
    : 12;
  const toolbarTop = selection
    ? selection.y + selection.height + 12 + 64 < window.innerHeight
      ? selection.y + selection.height + 12
      : Math.max(12, selection.y - 58)
    : 12;

  return (
    <div
      className="capture-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(event) => {
        event.preventDefault();
        invoke("cancel_capture");
      }}
    >
      <img
        src={snapshot.dataUrl}
        draggable={false}
        onLoad={async () => {
          await revealOverlayWindow();
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

      {selection && selection.width >= 8 && selection.height >= 8 && !dragging && (
        <div
          className="capture-toolbar"
          style={{ left: toolbarLeft, top: toolbarTop }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button disabled={processing} onClick={() => finish("normal")}>
            框选截图
          </button>
          <button
            className="accent"
            disabled={processing}
            onClick={() => finish("long")}
          >
            滚动长截图
          </button>
          <button className="icon-only" onClick={() => invoke("cancel_capture")}>
            Esc
          </button>
        </div>
      )}

      <div className="overlay-hint">
        <strong>{snapshot.name}</strong>
        <span>拖动鼠标框选 · 右键或 Esc 取消</span>
      </div>
      {instruction && <div className="overlay-instruction">{instruction}</div>}
    </div>
  );
}

export default OverlayApp;
