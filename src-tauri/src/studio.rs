//! Video editor integration. Media jobs run in the bundled Node worker on demand.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::Arc,
};
use tauri::{path::BaseDirectory, AppHandle, Manager, PhysicalPosition, PhysicalSize, State};

const METHODS: &[&str] = &[
    "app:getStatus",
    "project:create",
    "project:defaultPath",
    "project:openFolder",
    "project:saveAsFolder",
    "project:save",
    "project:deleteSegment",
    "project:importVideos",
    "tts:generate",
    "audio:preparePreview",
    "media:synthesizeSegment",
    "media:synthesizeAsset",
    "media:mergeVideos",
];

struct MediaWorker {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Drop for MediaWorker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[derive(Default)]
pub struct StudioState {
    worker: Arc<Mutex<Option<MediaWorker>>>,
    layout: Mutex<Layouts>,
}

pub fn resource(app: &AppHandle, name: &str) -> PathBuf {
    let bundled = app
        .path()
        .resolve(name, BaseDirectory::Resource)
        .unwrap_or_default();
    if bundled.exists() {
        return bundled;
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if name.starts_with("runtime/") {
        root.join("resources").join(name)
    } else {
        root.join(name)
    }
}

pub fn workspace_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .join("screenshot"))
}

fn launch_worker(app: &AppHandle) -> Result<MediaWorker, String> {
    let node = resource(
        app,
        if cfg!(windows) {
            "runtime/node.exe"
        } else {
            "runtime/node"
        },
    );
    if !node.is_file() {
        return Err("视频处理运行时尚未准备，请运行 npm run media:prepare 后重新打包".into());
    }
    let mut command = Command::new(node);
    command
        .arg(resource(app, "studio/worker.mjs"))
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env("SCREENSHOT_STUDIO_WORKSPACE", workspace_root(app)?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动视频处理：{e}"))?;
    Ok(MediaWorker {
        input: child.stdin.take().unwrap(),
        output: BufReader::new(child.stdout.take().unwrap()),
        child,
    })
}

#[tauri::command]
pub async fn studio_call(
    app: AppHandle,
    state: State<'_, StudioState>,
    method: String,
    payload: Value,
) -> Result<Value, String> {
    if !METHODS.contains(&method.as_str()) {
        return Err("不支持的视频制作操作".into());
    }
    let worker = state.worker.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut current = worker.lock();
        if current
            .as_mut()
            .is_some_and(|w| w.child.try_wait().ok().flatten().is_some())
        {
            current.take();
        }
        if current.is_none() {
            *current = Some(launch_worker(&app)?);
        }
        let active = current.as_mut().unwrap();
        let request = serde_json::json!({ "method":method, "payload":payload });
        let response = (|| {
            writeln!(active.input, "{request}").map_err(|e| e.to_string())?;
            active.input.flush().map_err(|e| e.to_string())?;
            let mut line = String::new();
            if active
                .output
                .read_line(&mut line)
                .map_err(|e| e.to_string())?
                == 0
            {
                return Err("视频处理进程已退出，任务未完成".into());
            }
            serde_json::from_str::<Value>(&line).map_err(|e| format!("视频处理响应无效：{e}"))
        })();
        match response {
            Ok(response) if response["ok"] == true => {
                let result = response["result"].clone();
                for root in [
                    payload.get("projectRoot"),
                    payload.get("rootDir"),
                    payload.get("targetRoot"),
                    result.get("rootDir"),
                ] {
                    if let Some(path) = root.and_then(Value::as_str) {
                        let _ = app.asset_protocol_scope().allow_directory(path, true);
                    }
                }
                Ok(result)
            }
            Ok(response) => Err(response["error"]
                .as_str()
                .unwrap_or("视频处理失败")
                .to_string()),
            Err(error) => {
                current.take();
                Err(error)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    result
}

#[tauri::command]
pub fn studio_reveal(path: String) -> Result<(), String> {
    if !PathBuf::from(&path).exists() {
        return Err("文件不存在".into());
    }
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg("-R").arg(path).spawn();
    #[cfg(target_os = "windows")]
    let result = Command::new("explorer")
        .arg(format!("/select,{path}"))
        .spawn();
    #[cfg(target_os = "linux")]
    let result = Command::new("xdg-open")
        .arg(PathBuf::from(path).parent().unwrap())
        .spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct Layout {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
    fullscreen: bool,
}
#[derive(Default, Deserialize, Serialize)]
struct Layouts {
    editing: bool,
    compact: Option<Layout>,
    studio: Option<Layout>,
}

fn snapshot(window: &tauri::WebviewWindow) -> Result<Layout, String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    Ok(Layout {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
        fullscreen: window.is_fullscreen().unwrap_or(false),
    })
}

#[tauri::command]
pub fn switch_workspace(
    app: AppHandle,
    state: State<'_, StudioState>,
    editing: bool,
) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("主窗口不存在")?;
    let mut layouts = state.layout.lock();
    if layouts.editing == editing {
        return Ok(());
    }
    let previous = snapshot(&window)?;
    if layouts.editing {
        layouts.studio = Some(previous);
    } else {
        layouts.compact = Some(previous);
    }
    window.set_fullscreen(false).map_err(|e| e.to_string())?;
    window.unmaximize().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let monitor = window.current_monitor().ok().flatten();
    if let Some(layout) = if editing {
        &layouts.studio
    } else {
        &layouts.compact
    } {
        let mut size = PhysicalSize::new(layout.width, layout.height);
        let mut position = PhysicalPosition::new(layout.x, layout.y);
        if let Some(monitor) = &monitor {
            let area = monitor.work_area();
            size.width = size.width.min(area.size.width);
            size.height = size.height.min(area.size.height);
            position.x = position.x.clamp(
                area.position.x,
                area.position.x + (area.size.width - size.width) as i32,
            );
            position.y = position.y.clamp(
                area.position.y,
                area.position.y + (area.size.height - size.height) as i32,
            );
        }
        let _ = window.set_min_size(Some(tauri::LogicalSize::new(760., 620.)));
        window.set_size(size).map_err(|e| e.to_string())?;
        window.set_position(position).map_err(|e| e.to_string())?;
        if layout.maximized {
            let _ = window.maximize();
        }
        if layout.fullscreen {
            let _ = window.set_fullscreen(true);
        }
    } else if editing {
        let _ = window.set_min_size(Some(tauri::LogicalSize::new(760., 620.)));
        if let Some(monitor) = &monitor {
            let area = monitor.work_area();
            let _ = window.set_position(area.position);
            let _ = window.set_size(area.size);
        }
        window.maximize().map_err(|e| e.to_string())?;
    } else {
        let _ = window.set_size(tauri::LogicalSize::new(960., 720.));
        let _ = window.center();
    }
    let _ = scale;
    layouts.editing = editing;
    if let Ok(directory) = app.path().app_config_dir() {
        let _ = std::fs::create_dir_all(&directory);
        if let Ok(data) = serde_json::to_vec(&*layouts) {
            let _ = std::fs::write(directory.join("workspaces.json"), data);
        }
    }
    Ok(())
}

pub fn restore_layouts(app: &AppHandle) {
    if let Ok(directory) = app.path().app_config_dir() {
        if let Ok(data) = std::fs::read(directory.join("workspaces.json")) {
            if let Ok(mut saved) = serde_json::from_slice::<Layouts>(&data) {
                saved.editing = false;
                app.state::<StudioState>().layout.lock().studio = saved.studio;
                app.state::<StudioState>().layout.lock().compact = saved.compact;
            }
        }
    }
    if let Some(layout) = app.state::<StudioState>().layout.lock().compact.clone() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_size(PhysicalSize::new(layout.width, layout.height));
            let _ = window.set_position(PhysicalPosition::new(layout.x, layout.y));
            if layout.maximized {
                let _ = window.maximize();
            }
        }
    }
}

pub fn remember_layout(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(current) = snapshot(&window) {
            let state = app.state::<StudioState>();
            let mut layouts = state.layout.lock();
            if layouts.editing {
                layouts.studio = Some(current);
            } else {
                layouts.compact = Some(current);
            }
            if let Ok(directory) = app.path().app_config_dir() {
                let _ = std::fs::create_dir_all(&directory);
                if let Ok(data) = serde_json::to_vec(&*layouts) {
                    let _ = std::fs::write(directory.join("workspaces.json"), data);
                }
            }
        }
    }
}

#[tauri::command]
pub fn toggle_studio_fullscreen(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("主窗口不存在")?;
    window
        .set_fullscreen(!window.is_fullscreen().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

pub fn mix_recording_audio(app: &AppHandle, path: &std::path::Path) -> Result<(), String> {
    let ffmpeg = resource(
        app,
        if cfg!(windows) {
            "studio/node_modules/ffmpeg-static/ffmpeg.exe"
        } else {
            "studio/node_modules/ffmpeg-static/ffmpeg"
        },
    );
    let metadata = Command::new(&ffmpeg)
        .arg("-hide_banner")
        .arg("-i")
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    let streams = String::from_utf8_lossy(&metadata.stderr)
        .lines()
        .filter(|line| line.contains("Stream #") && line.contains("Audio:"))
        .count();
    if streams < 2 {
        return Ok(());
    }
    let mixed = path.with_extension("mixed.mp4");
    let output = Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(path)
        .args([
            "-filter_complex",
            "[0:a:0][0:a:1]amix=inputs=2:duration=longest:normalize=0[a]",
            "-map",
            "0:v",
            "-map",
            "[a]",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
        ])
        .arg(&mixed)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&mixed);
        return Err(format!(
            "声音合并失败：{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    std::fs::rename(mixed, path).map_err(|e| e.to_string())
}
