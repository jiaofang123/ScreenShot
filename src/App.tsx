import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import AnnotationEditor from "./components/AnnotationEditor";
import type { CapturePayload, LongCaptureStatus } from "./types";

function App() {
  const [capture, setCapture] = useState<CapturePayload | null>(null);
  const [shortcut, setShortcut] = useState("Ctrl/Cmd + Shift + X");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [longStatus, setLongStatus] = useState<LongCaptureStatus | null>(null);

  useEffect(() => {
    invoke<string>("default_shortcut")
      .then((value) => setShortcut(value.replace("CommandOrControl", "Ctrl/Cmd")))
      .catch(() => undefined);

    const unlisteners = Promise.all([
      listen<CapturePayload>("capture-ready", ({ payload }) => {
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
          onClose={() => setCapture(null)}
          onNotify={setMessage}
        />
        {message && <div className="status-toast">{message}</div>}
      </>
    );
  }

  return (
    <main className="home-shell">
      <header className="app-header">
        <div className="brand-mark" aria-hidden="true">
          <span />
        </div>
        <div>
          <h1>ScreenShot</h1>
          <p>轻快、私密，截图之后立刻能用。</p>
        </div>
        <div className="privacy-pill">完全本地处理</div>
      </header>

      <section className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">READY WHEN YOU ARE</span>
          <h2>框住重点，剩下的交给它。</h2>
          <p>
            支持普通框选和手动滚动长截图。完成后可以画箭头、圈重点、打马赛克，随后自动复制到剪贴板。
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
          <p>箭头、矩形、画笔和马赛克，完成即复制。</p>
        </article>
      </section>

      <footer className="home-footer">
        <span>关闭窗口后仍在托盘运行</span>
        <span>Windows · macOS</span>
      </footer>

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
