import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

type MediaPayload = Record<string, unknown>;
export type StudioRecording = { path: string; projectRoot?: string };
export default function StudioWorkspace({ visible, recording, onImported, onRecord, onNotify }: {
  visible: boolean; recording: StudioRecording | null; onImported: () => void; onRecord: (project: { projectRoot: string }) => Promise<void>; onNotify: (message: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    const call = async (method: string, payload: unknown = {}) => {
      const result = await invoke("studio_call", { method, payload });
      const project = result as { rootDir?: string } | null;
      if (project?.rootDir) localStorage.setItem("screenshot-studio-last-project", project.rootDir);
      return result;
    };
    const chooseDirectory = (title: string) => open({ directory: true, title });
    const bridge = {
      getStatus: () => call("app:getStatus"),
      mediaUrl: (path: string) => convertFileSrc(path),
      createProject: (payload: MediaPayload) => call("project:create", payload),
      createProjectDialog: async () => {
        const defaultPath = await call("project:defaultPath") as string;
        const targetRoot = await save({ title: "创建视频项目文件夹", defaultPath });
        return targetRoot ? call("project:create", { targetRoot }) : null;
      },
      openProject: async () => { const targetRoot = await chooseDirectory("打开视频项目文件夹"); return targetRoot ? call("project:openFolder", { targetRoot }) : null; },
      openProjectFolder: (targetRoot: string) => call("project:openFolder", { targetRoot }),
      saveProject: (project: unknown) => call("project:save", project),
      deleteSegment: (payload: MediaPayload) => call("project:deleteSegment", payload),
      saveProjectFolder: async (project: MediaPayload, options: MediaPayload = {}) => {
        const targetRoot = options.targetRoot || await chooseDirectory("将项目另存到文件夹");
        return targetRoot ? call("project:saveAsFolder", { project, targetRoot }) : null;
      },
      importVideos: async (payload: MediaPayload) => {
        const paths = payload.paths || await open({ title: "导入视频", multiple: true, filters: [{ name: "视频", extensions: ["mp4", "mov", "m4v", "webm", "mkv"] }] });
        return paths ? call("project:importVideos", { ...payload, paths: Array.isArray(paths) ? paths : [paths] }) : [];
      },
      generateVoice: (payload: MediaPayload) => call("tts:generate", payload),
      prepareAudioPreview: (payload: MediaPayload) => call("audio:preparePreview", payload),
      synthesizeSegment: (payload: MediaPayload) => call("media:synthesizeSegment", payload),
      synthesizeAsset: (payload: MediaPayload) => call("media:synthesizeAsset", payload),
      mergeVideos: (payload: MediaPayload) => call("media:mergeVideos", payload),
      showItem: (path: string) => invoke("studio_reveal", { path }),
      openPath: (path: string) => invoke("studio_reveal", { path }),
      requestRecording: onRecord,
      onStopRecordingShortcut: () => () => {},
    };
    (window as unknown as { screenShotStudio: unknown }).screenShotStudio = bridge;
    const listener = () => setInitialized(true);
    window.addEventListener("studio-ready", listener);
    setReady(true);
    return () => { window.removeEventListener("studio-ready", listener); };
  }, [onRecord]);
  useEffect(() => {
    if (!recording || !initialized) return;
    const target = frame.current?.contentWindow as (Window & { importRecording?: (path: string, projectRoot?: string) => Promise<void> }) | null;
    if (target?.importRecording) void target.importRecording(recording.path, recording.projectRoot).then(onImported).catch(error => { onNotify(String(error)); onImported(); });
  }, [recording, initialized, onImported, onNotify]);
  return <section className="studio-workspace" hidden={!visible} aria-label="视频制作工作区">
    {ready && <iframe ref={frame} title="视频制作" src="/studio/index.html" />}
  </section>;
}
