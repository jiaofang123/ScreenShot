import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { recordingPath } from "../recordingPaths";

type RecordingMode = "window" | "tab" | "desktop" | "region";
interface RecordingStatus {
  id: string; controllerId?: string; mode: RecordingMode; phase: string; message: string; elapsedMs: number;
  bytesWritten: number; filePath: string | null; browser: string; sourceName: string;
  width: number; height: number; hasAudio: boolean;
  options?: { fps: number; audio: boolean; originalResolution: boolean; browser: string | null };
  stopShortcutAvailable?: boolean;
}
const modes: { value: RecordingMode; icon: string; label: string; description: string }[] = [
  { value: "window", icon: "▣", label: "应用窗口", description: "选择某个应用的具体窗口" },
  { value: "tab", icon: "▤", label: "浏览器页签", description: "选择 Chrome / Edge 中的单个页签" },
  { value: "desktop", icon: "▰", label: "电脑桌面", description: "选择一块屏幕，录制整个桌面" },
  { value: "region", icon: "⌗", label: "框选区域", description: "在共享画面上框选，可拖动四角调整" },
];
const labels: Record<string, string> = { waiting: "等待选择", selecting: "调整选区", recording: "录屏中", paused: "已暂停", saving: "保存中", saved: "已保存", cancelled: "已取消", error: "录屏出错" };

export default function BrowserRecordingPanel({ onNotify, lockedMode, onEditVideo, onRecordingStarted, onRecordingPreparing }: { onNotify: (message: string) => void; lockedMode: RecordingMode; onEditVideo: (path: string) => void; onRecordingStarted?: (status: RecordingStatus) => void; onRecordingPreparing?: () => void }) {
  const [mode, setMode] = useState<RecordingMode>(lockedMode);
  const [fps, setFps] = useState(30);
  const [audio, setAudio] = useState(true);
  const [originalResolution, setOriginalResolution] = useState(false);
  const [browser, setBrowser] = useState("auto");
  const [browsers, setBrowsers] = useState<{ id: string; name: string }[]>([]);
  const [status, setStatus] = useState<RecordingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useRef<string|null>(null);
  const active = !!status && !["saved", "cancelled", "error"].includes(status.phase);

  function applyStatus(value: RecordingStatus | null) {
    if(controller.current&&value&&value.id!==controller.current&&value.controllerId!==controller.current)return;
    setStatus(value);
    if (value && !["saved", "cancelled", "error"].includes(value.phase)) {
      setMode(value.mode);
      if (value.options) {
        setFps(value.options.fps); setAudio(value.options.audio);
        setOriginalResolution(value.options.originalResolution); setBrowser(value.options.browser || "auto");
      }
    }
  }

  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    void invoke<{ id: string; name: string }[]>("get_recording_browsers").then(value => { if (active) setBrowsers(value || []); }).catch(() => undefined);
    const unlisten = listen<RecordingStatus>("recording-status", ({ payload }) => { if (active) { receivedEvent = true; applyStatus(payload); } });
    void unlisten.then(() => invoke<RecordingStatus | null>("get_recording_status").then(value => { if (active && !receivedEvent) applyStatus(value); })).catch(() => undefined);
    return () => { active = false; void unlisten.then(callback => callback()); };
  }, []);

  useEffect(() => { if (!active) setMode(lockedMode); }, [lockedMode, active]);

  async function start() {
    if (busy || active) return;
    setBusy(true);
    try {
      const path = await recordingPath();
      controller.current=null;onRecordingPreparing?.();
      const value = await invoke<RecordingStatus>("start_recording_session", { path, options: { mode, fps, audio, originalResolution, browser } });
      controller.current=value.controllerId||value.id;
      onRecordingStarted?.(value);
      setStatus(current => current?.id === value.id ? current : value);
      onNotify(`已打开${value.browser}，请选择录制内容`);
    } catch (error) { onNotify(`无法开始录屏：${String(error)}`); }
    finally { setBusy(false); }
  }

  async function control(action: string) {
    try { await invoke("recording_control", { action }); }
    catch (error) { onNotify(`录屏操作失败：${String(error)}`); }
  }

  const seconds = Math.floor((status?.elapsedMs || 0) / 1000);
  return (
    <section className="recording-panel">
      <div className="recording-heading"><div><span className="eyebrow">SCREEN RECORDING</span><h2>录下需要的内容</h2></div><span className={`recording-badge ${active ? "active" : ""}`}>{status ? labels[status.phase] : "准备录制"}</span></div>
      <p className="recording-intro">选择录制范围，在浏览器共享面板授权后开始。视频自动保存到用户目录下的 screenshot / 日期文件夹。</p>
      <fieldset className="recording-sources" hidden disabled={active || busy}>
        <legend>录制来源</legend>
        {modes.map(item => <label key={item.value} className={`recording-source ${mode === item.value ? "selected" : ""}`}>
          <input type="radio" name="recording-mode" value={item.value} checked={mode === item.value} onChange={() => setMode(item.value)} />
          <span className="recording-source-icon">{item.icon}</span><span><strong>{item.label}</strong><small>{item.description}</small></span>
        </label>)}
      </fieldset>
      <div className="recording-options">
        <label>浏览器 <select aria-label="录屏浏览器" value={browser} disabled={active || busy} onChange={event => setBrowser(event.target.value)}><option value="auto">自动选择</option>{browsers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="system">系统默认浏览器</option></select></label>
        <label>帧率 <select aria-label="录屏帧率" value={fps} disabled={active || busy} onChange={event => setFps(Number(event.target.value))}><option value={15}>15 fps</option><option value={30}>30 fps</option><option value={60}>60 fps</option></select></label>
        <label>画质 <select aria-label="录屏画质" value={originalResolution ? "4k" : "1080p"} disabled={active || busy} onChange={event => setOriginalResolution(event.target.value === "4k")}><option value="1080p">最高 1080p</option><option value="4k">最高 4K</option></select></label>
        <label className="recording-audio"><input type="checkbox" checked={audio} disabled={active || busy} onChange={event => setAudio(event.target.checked)} />录制共享声音</label>
      </div>
      <div className="recording-actions">
        {!active && <button className="capture-button" disabled={busy} onClick={start}><span className="record-dot" />{busy ? "正在准备录屏…" : "开始录屏"}</button>}
        {active && <>
          {["recording", "paused"].includes(status.phase) && <button className="recording-secondary" onClick={() => control(status.phase === "paused" ? "resume" : "pause")}>{status.phase === "paused" ? "继续录制" : "暂停录制"}</button>}
          <button className="recording-stop" disabled={status.phase === "saving"} onClick={() => control("stop")}>{status.phase === "saving" ? "正在保存…" : ["waiting", "selecting"].includes(status.phase) ? "取消录屏" : "停止并保存"}</button>
          {status.phase === "waiting" && <button className="recording-secondary" onClick={() => { void invoke("reopen_recording_browser").catch(error => onNotify(String(error))); }}>打开录屏页面</button>}
        </>}
        {status?.filePath && status.phase === "saved" && <button className="recording-secondary" onClick={() => onEditVideo(status.filePath!)}>添加旁白 / 编辑视频</button>}
        {status?.filePath && !active && <button className="recording-secondary" onClick={() => { void invoke("reveal_recording").catch(error => onNotify(String(error))); }}>打开所在文件夹</button>}
      </div>
      {status && <div className={`recording-status ${status.phase === "error" ? "error" : ""}`} role="status">
        <strong>{status.message}</strong>
        {status.width > 0 && <span>{Math.floor(seconds / 60).toString().padStart(2, "0")}:{(seconds % 60).toString().padStart(2, "0")} · {status.width} × {status.height} · {(status.bytesWritten / 1024 / 1024).toFixed(1)} MB · {status.hasAudio ? "含共享声音" : "仅画面"}</span>}
        {status.filePath && <span className="recording-path">{status.filePath}</span>}
      </div>}
      <p className="recording-note">{status?.stopShortcutAvailable ? <>停止快捷键：<kbd>Ctrl/Cmd + Alt + Shift + R</kbd>，或使用托盘菜单“停止录屏”。</> : <>可使用工具按钮或托盘菜单“停止录屏并保存”结束录制。</>}<br />共享声音取决于浏览器和来源；不采集麦克风。页签和区域录制需要新版 Chrome / Edge，请保留录屏页面直到保存完成。</p>
    </section>
  );
}
