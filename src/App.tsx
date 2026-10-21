import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import AnnotationEditor from "./components/AnnotationEditor";
import RecordingPanel from "./components/RecordingPanel";
import StudioWorkspace, { type StudioRecording } from "./components/StudioWorkspace";
import { recordingPath } from "./recordingPaths";
import type { CapturePayload, LongCaptureStatus } from "./types";

type RecordingStatus = { id: string; controllerId?: string; phase: string; filePath: string | null };

function App() {
  const [capture, setCapture] = useState<CapturePayload | null>(null);
  const [shortcut, setShortcut] = useState("Ctrl/Cmd + Shift + X");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [longStatus, setLongStatus] = useState<LongCaptureStatus | null>(null);
  const [page, setPage] = useState<"capture" | "record" | "studio">("capture");
  const [studioOpened, setStudioOpened] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [studioRecording, setStudioRecording] = useState<StudioRecording | null>(null);
  const studioController = useRef<string | null>(null), studioProject = useRef<string | undefined>(undefined);
  const preparingRecording = useRef(false), latestRecording = useRef<RecordingStatus | null>(null);
  const importedSessions = useRef(new Set<string>());
  const switchPage = useCallback((next: "capture" | "record" | "studio") => {
    void invoke("switch_workspace", { editing: next === "studio" }).then(() => {
      if (next === "studio") setStudioOpened(true);
      setPage(next);
    }).catch(error => setMessage(`切换工作区失败：${String(error)}`));
  }, []);
  const recordingToStudio = useCallback((path: string) => { setStudioRecording({ path }); switchPage("studio"); }, [switchPage]);
  const importedRecording = useCallback(() => { setStudioRecording(null); }, []);
  const studioStatus = useCallback((value: RecordingStatus) => {
    if (preparingRecording.current) latestRecording.current = value;
    if (!studioController.current || (value.id !== studioController.current && value.controllerId !== studioController.current)) return;
    if (value.phase === "saved" && value.filePath && !importedSessions.current.has(value.id)) {
      importedSessions.current.add(value.id);
      setStudioRecording({ path: value.filePath, projectRoot: studioProject.current });
      switchPage("studio");
    }
  }, [switchPage]);
  useEffect(() => {
    const unlisten = listen<RecordingStatus>("recording-status", ({ payload }) => studioStatus(payload));
    return () => { void unlisten.then(off => off()); };
  }, [studioStatus]);
  const requestRecording = useCallback(async ({ projectRoot }: { projectRoot: string }) => {
    if (preparingRecording.current) return;
    preparingRecording.current = true;
    try {
      const path = await recordingPath(projectRoot);
      const status = await invoke<RecordingStatus>("start_recording_session", {
        path, options: { mode: "window", fps: 30, audio: true, originalResolution: false, browser: "auto" },
      });
      studioController.current = status.controllerId || status.id;
      studioProject.current = projectRoot;
      const latest = latestRecording.current;
      studioStatus(latest && (latest.id === studioController.current || latest.controllerId === studioController.current) ? latest : status);
    } finally { preparingRecording.current = false; latestRecording.current = null; }
  }, [studioStatus]);

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
    const timer = window.setTimeout(() => setMessage(null), 7000);
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
        {message && <div className="status-toast" role="status"><span>{message}</span><button aria-label="关闭提示" onClick={() => setMessage(null)}>×</button></div>}
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
          <p>{page === "studio" ? "添加视频 → 编辑文字和旁白 → 合成并导出" : page === "record" ? "选择录制内容，录完自动保存。" : "截图、录屏、制作讲解视频，选一个开始。"}</p>
        </div>
        <div className="privacy-pill">{page === "studio" ? "视频本机处理 · 在线语音需联网" : "完全本地处理"}</div>
      </header>

      <nav className="mode-tabs" aria-label="工具模式">
        <button aria-label="截图" aria-pressed={page === "capture"} className={page === "capture" ? "selected" : ""} onClick={() => switchPage("capture")}>截图<small aria-hidden="true">截取画面、添加标注</small></button>
        <button aria-label="录屏" aria-pressed={page === "record"} className={page === "record" ? "selected" : ""} onClick={() => switchPage("record")}>录屏<small aria-hidden="true">把屏幕录成视频</small></button>
        <button aria-label="视频制作" aria-pressed={page === "studio"} className={page === "studio" ? "selected" : ""} onClick={() => switchPage("studio")}>视频制作<small aria-hidden="true">加文字、配音、合并视频</small></button>
        {page === "studio" && <button onClick={() => { void invoke("toggle_studio_fullscreen").catch(error => setMessage(String(error))); }}>全屏 / 退出全屏</button>}
        <button className="help-toggle" aria-expanded={showHelp} onClick={() => setShowHelp(value => !value)}>{showHelp ? "收起帮助" : "使用帮助"}</button>
      </nav>
      {showHelp && <section className="usage-guide" aria-label="使用帮助">
        <div><strong>截图</strong><p>开始截图 → 拖动框选。拖动四角可调整，按 Enter 直接复制；需要标注时点“编辑截图”。</p></div>
        <div><strong>录屏</strong><p>选择窗口、屏幕或区域 → 开始录屏。窗口会自动收起，用菜单栏图标或停止快捷键结束，视频自动保存。</p></div>
        <div><strong>视频制作</strong><p>导入或录制视频 → 写稿并生成语音，也可只插入文字 → 合成音视频 → 合并预览 → 合并导出。修改自动保存。</p></div>
      </section>}

      {studioOpened && <StudioWorkspace visible={page === "studio"} recording={studioRecording} onImported={importedRecording} onRecord={requestRecording} onNotify={setMessage} />}
      {page === "record" ? <RecordingPanel onNotify={setMessage} onEditVideo={recordingToStudio} /> : page === "capture" ? <>

      <section className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">截图 · 三步完成</span>
          <h2>拖动框选，马上复制。</h2>
          <p>
            点击下方按钮后，在屏幕上拖出需要的范围。按 Enter 或点“完成并复制”，就能粘贴到聊天、文档里。
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
          <h3>1. 框选需要的画面</h3>
          <p>屏幕冻结后拖动框选，四角可调整。选错了可重新拖动；按 Esc 取消。</p>
        </article>
        <article>
          <div className="feature-icon">⇣</div>
          <h3>2. 需要标注时再编辑</h3>
          <p>选“编辑截图”，可添加文字、箭头、方框或打码；长页面选“滚动长截图”。</p>
        </article>
        <article>
          <div className="feature-icon">↗</div>
          <h3>3. 复制或保存</h3>
          <p>“完成并复制”后直接粘贴；想保留图片文件，可在编辑页选择“另存为”。</p>
        </article>
      </section>

      </> : null}
      {page !== "studio" && <footer className="home-footer">
        <span>关闭窗口后仍在菜单栏 / 托盘运行，可从图标重新打开</span>
        <span>截图和视频保存在本机</span>
      </footer>}

      {longStatus && (
        <div className="status-toast persistent">
          <strong>长截图进行中 · {longStatus.totalHeight}px</strong>
          <span>{longStatus.message}</span>
        </div>
      )}
      {message && <div className="status-toast" role="status"><span>{message}</span><button aria-label="关闭提示" onClick={() => setMessage(null)}>×</button></div>}
    </main>
  );
}

export default App;
