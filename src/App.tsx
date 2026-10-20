import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import AnnotationEditor from "./components/AnnotationEditor";
import RecordingPanel from "./components/RecordingPanel";
import StudioWorkspace from "./components/StudioWorkspace";
import type { CapturePayload, LongCaptureStatus } from "./types";

function App() {
  const [capture, setCapture] = useState<CapturePayload | null>(null);
  const [shortcut, setShortcut] = useState("Ctrl/Cmd + Shift + X");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [longStatus, setLongStatus] = useState<LongCaptureStatus | null>(null);
  const [page, setPage] = useState<"capture" | "record" | "studio">("capture");
  const [studioOpened, setStudioOpened] = useState(false);
  const [studioRecording, setStudioRecording] = useState<string | null>(null);
  const [recordingForStudio, setRecordingForStudio] = useState(false);
  const switchPage = useCallback((next: "capture" | "record" | "studio") => {
    void invoke("switch_workspace", { editing: next === "studio" }).then(() => {
      if (next === "studio") setStudioOpened(true);
      setPage(next);
    }).catch(error => setMessage(`切换工作区失败：${String(error)}`));
  }, []);
  const requestRecording = useCallback(() => { setRecordingForStudio(true); switchPage("record"); }, [switchPage]);
  const recordingToStudio = useCallback((path: string) => { setStudioRecording(path); switchPage("studio"); }, [switchPage]);
  const importedRecording = useCallback(() => { setStudioRecording(null); setRecordingForStudio(false); }, []);

  useEffect(() => {
    invoke<string>("default_shortcut")
      .then((value) => setShortcut(value.replace("CommandOrControl", "Ctrl/Cmd")))
      .catch(() => undefined);

    const unlisteners = Promise.all([
      listen("capture-cancelled", () => setBusy(false)),
      listen("capture-copied", () => {
        setBusy(false);
        setMessage("图片已复制到剪贴板，可以直接粘贴");
      }),
      listen<CapturePayload>("capture-ready", ({ payload }) => {
        void invoke("switch_workspace", { editing: false }).catch(() => undefined);
        setPage("capture");
        setCapture(payload);
        setBusy(false);
        setLongStatus(null);
        setMessage(
          payload.captureKind === "long" ? "长截图拼接完成" : "截图完成",
        );
      }),
      listen<string>("app-error", ({ payload }) => {
        setBusy(false);
        setMessage(payload);
      }),
      listen<LongCaptureStatus>("long-capture-status", ({ payload }) => {
        setLongStatus(payload);
      }),
    ]);
    return () => {
      unlisteners.then((items) => items.forEach((unlisten) => unlisten()));
    };
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 3600);
    return () => window.clearTimeout(timer);
  }, [message]);

  async function startCapture() {
    setBusy(true);
    setMessage(null);
    try {
      await invoke("begin_capture");
    } catch (error) {
      setBusy(false);
      setMessage(String(error));
    }
  }

  if (capture) {
    return (
      <>
        <AnnotationEditor
          capture={capture}
          onClose={() => {
            void invoke("release_capture", { captureId: capture.captureId }).catch(() => undefined);
            setCapture(null);
          }}
          onNotify={setMessage}
        />
        {message && <div className="status-toast">{message}</div>}
      </>
    );
  }

  return (
    <main className={`home-shell ${page === "studio" ? "editing-workspace" : ""}`}>
      <header className="app-header">
        <div className="brand-mark" aria-hidden="true">
          <span />
        </div>
        <div>
          <h1>ScreenShot</h1>
          <p>{page === "studio" ? "录制演示，添加旁白，合成成片。" : "轻快、私密，截图之后立刻能用。"}</p>
        </div>
        <div className="privacy-pill">{page === "studio" ? "视频本机处理 · 在线语音需联网" : "完全本地处理"}</div>
      </header>

      <nav className="mode-tabs" aria-label="工具模式">
        <button className={page === "capture" ? "selected" : ""} onClick={() => switchPage("capture")}>截图</button>
        <button className={page === "record" ? "selected" : ""} onClick={() => { setRecordingForStudio(false); switchPage("record"); }}>录屏</button>
        <button className={page === "studio" ? "selected" : ""} onClick={() => switchPage("studio")}>视频制作</button>
        {page === "studio" && <button onClick={() => { void invoke("toggle_studio_fullscreen").catch(error => setMessage(String(error))); }}>全屏 / 退出全屏</button>}
      </nav>

      {studioOpened && <StudioWorkspace visible={page === "studio"} recording={studioRecording} onImported={importedRecording} onRecord={requestRecording} onNotify={setMessage} />}
      {page === "record" ? <RecordingPanel onNotify={setMessage} onEditVideo={recordingToStudio} defaultEditAfter={recordingForStudio} /> : page === "capture" ? <>

      <section className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">READY WHEN YOU ARE</span>
          <h2>框住重点，剩下的交给它。</h2>
          <p>
            框选后可直接完成并复制；需要画箭头、圈重点、添加文字或打马赛克时，选择编辑截图。也支持手动滚动长截图。
          </p>
          <button className="capture-button" onClick={startCapture} disabled={busy}>
            <span className="capture-icon" aria-hidden="true" />
            {busy ? "正在准备屏幕…" : "开始截图"}
          </button>
          <div className="shortcut-row">
            <span>全局快捷键</span>
            <kbd>{shortcut}</kbd>
          </div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="demo-window">
            <div className="demo-topbar">
              <i />
              <i />
              <i />
            </div>
            <div className="demo-content">
              <div className="demo-line wide" />
              <div className="demo-line" />
              <div className="demo-selection">
                <span className="corner tl" />
                <span className="corner tr" />
                <span className="corner bl" />
                <span className="corner br" />
                <div className="demo-arrow">↘</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="feature-grid">
        <article>
          <div className="feature-icon">⌗</div>
          <h3>精确框选</h3>
          <p>冻结当前桌面，跨应用选取你真正需要的区域。</p>
        </article>
        <article>
          <div className="feature-icon">⇣</div>
          <h3>手动滚动长图</h3>
          <p>慢慢向下滚动，程序识别重叠内容并自动拼接。</p>
        </article>
        <article>
          <div className="feature-icon">↗</div>
          <h3>快速标注</h3>
          <p>箭头、矩形、画笔、文字和马赛克，完成即复制。</p>
        </article>
      </section>

      </> : null}
      {page !== "studio" && <footer className="home-footer">
        <span>关闭窗口后仍在托盘运行</span>
        <span>Windows · macOS</span>
      </footer>}

      {longStatus && (
        <div className="status-toast persistent">
          <strong>长截图进行中 · {longStatus.totalHeight}px</strong>
          <span>{longStatus.message}</span>
        </div>
      )}
      {message && <div className="status-toast">{message}</div>}
    </main>
  );
}

export default App;
