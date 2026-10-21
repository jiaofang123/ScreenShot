use std::{
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tempfile::NamedTempFile;
use tiny_http::{Header, Method, Request, Response, Server};
use tungstenite::{
    handshake::server::{ErrorResponse, Request as WsRequest, Response as WsResponse},
    Message,
};
use uuid::Uuid;

const MAX_CHUNK: u64 = 4 * 1024 * 1024;
const CONTINUE: u8 = 0;
const PAUSE: u8 = 1;
const STOP: u8 = 2;
const CANCEL: u8 = 3;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecordingMode {
    Window,
    Tab,
    Desktop,
    Region,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingOptions {
    pub mode: RecordingMode,
    pub fps: u32,
    pub audio: bool,
    #[serde(default)]
    pub original_resolution: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<RecordingResolution>,
    #[serde(default)]
    pub browser: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum RecordingResolution {
    #[serde(rename = "1080p")]
    FullHd,
    #[serde(rename = "2k")]
    Qhd,
    #[serde(rename = "4k")]
    Uhd,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controller_id: Option<String>,
    pub mode: RecordingMode,
    pub phase: String,
    pub message: String,
    pub elapsed_ms: u64,
    pub bytes_written: u64,
    pub file_path: Option<String>,
    pub browser: String,
    pub source_name: String,
    pub width: u32,
    pub height: u32,
    pub has_audio: bool,
    pub options: RecordingOptions,
    pub stop_shortcut_available: bool,
}

impl RecordingStatus {
    pub fn active(&self) -> bool {
        !matches!(self.phase.as_str(), "saved" | "cancelled" | "error")
    }
}

type EventSink = Arc<dyn Fn(RecordingStatus) + Send + Sync>;

struct Session {
    status: Mutex<RecordingStatus>,
    native_running: AtomicBool,
    desired: AtomicU8,
    disconnected: AtomicBool,
    connected: AtomicBool,
    shutdown: AtomicBool,
    replacement_url: Mutex<Option<String>>,
    browser_launch: Mutex<Option<Instant>>,
    stop_requested_at: Mutex<Option<Instant>>,
    url: String,
    sink: EventSink,
}

impl Session {
    fn update(&self, change: impl FnOnce(&mut RecordingStatus)) {
        let snapshot = {
            let mut status = self.status.lock();
            change(&mut status);
            status.clone()
        };
        (self.sink)(snapshot);
    }

    fn control(&self, action: &str) -> Result<(), String> {
        if !self.status.lock().active() {
            return Ok(());
        }
        let command = match action {
            "pause" => PAUSE,
            "resume" => CONTINUE,
            "stop" => STOP,
            "cancel" => CANCEL,
            _ => return Err("未知录屏操作".into()),
        };
        let mut current = self.desired.load(Ordering::Acquire);
        while current < STOP {
            match self.desired.compare_exchange_weak(
                current,
                command,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(next) => current = next,
            }
        }
        if command >= STOP {
            self.stop_requested_at
                .lock()
                .get_or_insert_with(Instant::now);
            let phase = self.status.lock().phase.clone();
            if matches!(phase.as_str(), "recording" | "paused") {
                self.update(|status| {
                    status.phase = "saving".into();
                    status.message = "正在停止录屏并保存视频…".into();
                });
            }
        }
        Ok(())
    }

    fn control_json(&self) -> serde_json::Value {
        let command = match self.desired.load(Ordering::Acquire) {
            PAUSE => "pause",
            STOP => "stop",
            CANCEL => "cancel",
            _ => "resume",
        };
        let status = self.status.lock().clone();
        serde_json::json!({"command":command, "phase":status.phase,"status":status})
    }
}

#[derive(Default)]
pub struct RecordingManager {
    current: Mutex<Option<Arc<Session>>>,
    pub quit_when_finished: AtomicBool,
    pub stop_shortcut_available: AtomicBool,
}

pub struct PreparedRecording {
    #[allow(dead_code)] // Read by standalone test harnesses.
    pub url: String,
    pub status: RecordingStatus,
    pub reused_controller: bool,
}

impl RecordingManager {
    pub fn start_native(
        &self,
        app: AppHandle,
        options: RecordingOptions,
        source: serde_json::Value,
        path: PathBuf,
    ) -> Result<RecordingStatus, String> {
        if !cfg!(target_os = "macos") {
            return Err("当前系统请使用浏览器兼容录屏".into());
        }
        if !path.is_absolute()
            || !path.parent().is_some_and(Path::is_dir)
            || path.is_dir()
            || !matches!(options.fps, 15 | 30 | 60)
        {
            return Err("保存路径或帧率无效".into());
        }
        if options.mode == RecordingMode::Tab {
            return Err("单页签请使用浏览器授权录制".into());
        }
        let mut current = self.current.lock();
        if current
            .as_ref()
            .is_some_and(|session| session.status.lock().active())
        {
            return Err("已有录屏任务，请先停止".into());
        }
        let status = RecordingStatus {
            id: Uuid::new_v4().to_string(),
            controller_id: None,
            mode: options.mode,
            phase: "waiting".into(),
            message: "正在启动本机录屏…".into(),
            elapsed_ms: 0,
            bytes_written: 0,
            file_path: None,
            browser: "macOS 原生录屏".into(),
            source_name: source["name"].as_str().unwrap_or("").into(),
            width: 0,
            height: 0,
            has_audio: options.audio,
            options: options.clone(),
            stop_shortcut_available: self.stop_shortcut_available.load(Ordering::Acquire),
        };
        let event_app = app.clone();
        let sink: EventSink = Arc::new(move |status| {
            let manager = event_app.state::<RecordingManager>();
            if manager
                .status()
                .is_some_and(|current| current.id == status.id)
            {
                let _ = event_app.emit_to("main", "recording-status", &status);
                if !status.active() {
                    if manager.quit_when_finished.load(Ordering::Acquire) {
                        event_app.exit(0);
                    } else {
                        crate::capture::show_main_window(&event_app);
                    }
                }
            }
        });
        let session = Arc::new(Session {
            status: Mutex::new(status.clone()),
            native_running: AtomicBool::new(false),
            desired: AtomicU8::new(CONTINUE),
            disconnected: AtomicBool::new(false),
            connected: AtomicBool::new(true),
            shutdown: AtomicBool::new(false),
            replacement_url: Mutex::new(None),
            browser_launch: Mutex::new(None),
            stop_requested_at: Mutex::new(None),
            url: String::new(),
            sink,
        });
        if let Some(previous) = current.replace(session.clone()) {
            previous.shutdown.store(true, Ordering::Release);
        }
        drop(current);
        (session.sink)(status.clone());
        if let Err(error) = launch_native(app.clone(), session.clone(), source, path) {
            session.update(|status| {
                status.phase = "error".into();
                status.message = error.clone();
            });
            crate::capture::show_main_window(&app);
            return Err(error);
        }
        Ok(self.status().unwrap_or(status))
    }

    pub fn status(&self) -> Option<RecordingStatus> {
        self.current
            .lock()
            .as_ref()
            .map(|session| session.status.lock().clone())
    }

    pub fn is_active(&self) -> bool {
        self.status().is_some_and(|status| status.active())
    }

    pub fn control(&self, action: &str) -> Result<(), String> {
        let current = self.current.lock().clone();
        if let Some(session) = current {
            session.control(action)?;
        }
        Ok(())
    }

    #[allow(dead_code)] // Also used by the standalone synthetic-media harness.
    pub fn prepare(
        &self,
        options: RecordingOptions,
        path: PathBuf,
        browser: String,
        sink: EventSink,
    ) -> Result<PreparedRecording, String> {
        self.prepare_with_app(options, path, browser, sink, None)
    }

    pub(crate) fn prepare_with_app(
        &self,
        options: RecordingOptions,
        path: PathBuf,
        browser: String,
        sink: EventSink,
        app: Option<AppHandle>,
    ) -> Result<PreparedRecording, String> {
        if !matches!(options.fps, 15 | 30 | 60) {
            return Err("录屏帧率仅支持 15、30 或 60 fps".into());
        }
        if !path.is_absolute()
            || !path.parent().is_some_and(Path::is_dir)
            || path.file_name().is_none()
        {
            return Err("请选择有效的视频保存路径".into());
        }
        if path.is_dir() {
            return Err("视频保存路径不能是文件夹".into());
        }
        let mut current = self.current.lock();
        if current
            .as_ref()
            .is_some_and(|session| session.status.lock().active())
        {
            return Err("已有录屏任务，请先停止并等待保存完成".into());
        }
        let server = Server::http(("127.0.0.1", 0))
            .map_err(|error| format!("无法创建本机录屏连接：{error}"))?;
        let port = server
            .server_addr()
            .to_ip()
            .ok_or("无法读取录屏端口")?
            .port();
        let ws_listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
        ws_listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let ws_port = ws_listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let temporary = NamedTempFile::new_in(path.parent().unwrap())
            .map_err(|error| format!("无法写入视频保存目录：{error}"))?;
        let token = Uuid::new_v4().simple().to_string();
        let origin = format!("http://127.0.0.1:{port}");
        let prefix = format!("/{token}/");
        let id = Uuid::new_v4().to_string();
        let status = RecordingStatus {
            id: id.clone(),
            controller_id: Some(id),
            mode: options.mode,
            phase: "waiting".into(),
            message: format!("已打开{browser}，请在录屏页面选择要共享的内容"),
            elapsed_ms: 0,
            bytes_written: 0,
            file_path: None,
            browser,
            source_name: String::new(),
            width: 0,
            height: 0,
            has_audio: false,
            options: options.clone(),
            stop_shortcut_available: self.stop_shortcut_available.load(Ordering::Acquire),
        };
        let session = Arc::new(Session {
            status: Mutex::new(status.clone()),
            native_running: AtomicBool::new(false),
            desired: AtomicU8::new(CONTINUE),
            disconnected: AtomicBool::new(false),
            connected: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
            replacement_url: Mutex::new(None),
            browser_launch: Mutex::new(None),
            stop_requested_at: Mutex::new(None),
            url: format!("{origin}{prefix}"),
            sink,
        });
        let mut reused_controller = false;
        if let Some(previous) = current.replace(session.clone()) {
            // A completed controller can navigate to a new session in its existing
            // window, including when the project/destination has changed.
            reused_controller = previous.connected.load(Ordering::Acquire)
                && !previous.shutdown.load(Ordering::Acquire)
                && !previous.url.is_empty()
                && previous.status.lock().browser == status.browser;
            if reused_controller {
                *previous.replacement_url.lock() = Some(session.url.clone());
                *session.browser_launch.lock() = Some(Instant::now());
            }
            previous.shutdown.store(true, Ordering::Release);
        }
        drop(current);
        let ws_session = session.clone();
        let ws_origin = origin.clone();
        let ws_prefix = prefix.clone();
        thread::spawn(move || websocket_worker(ws_listener, ws_session, ws_origin, ws_prefix));
        let http_session = session.clone();
        thread::spawn(move || {
            recording_server(
                server,
                http_session,
                origin,
                prefix,
                ws_port,
                path,
                temporary,
                app,
            )
        });
        (session.sink)(status.clone());
        Ok(PreparedRecording {
            url: session.url.clone(),
            status,
            reused_controller,
        })
    }
}

#[tauri::command]
pub fn native_recording_available() -> bool {
    cfg!(target_os = "macos")
}

#[tauri::command]
pub async fn native_capture_sources(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = Command::new(crate::studio::resource(&app, "runtime/screenshot-recorder"))
            .arg("list")
            .arg(std::process::id().to_string())
            .output()
            .map_err(|e| e.to_string())?;
        let data: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|_| "无法读取录屏来源，请检查 ScreenShot 的屏幕录制权限")?;
        if !output.status.success() {
            return Err(data["message"]
                .as_str()
                .unwrap_or("请检查屏幕录制权限")
                .into());
        }
        Ok(data["sources"].clone())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn native_source_preview(kind: String, id: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let image = if kind == "window" {
            xcap::Window::all()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|w| w.id().ok() == Some(id))
                .ok_or("窗口不存在")?
                .capture_image()
                .map_err(|e| e.to_string())?
        } else {
            xcap::Monitor::all()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|m| m.id().ok() == Some(id))
                .ok_or("屏幕不存在")?
                .capture_image()
                .map_err(|e| e.to_string())?
        };
        crate::image_utils::image_to_preview_data_url(&image, 1.0)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn start_native_recording(
    app: AppHandle,
    options: RecordingOptions,
    source: serde_json::Value,
    path: String,
) -> Result<RecordingStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<RecordingManager>()
            .start_native(app.clone(), options, source, path.into())
    })
    .await
    .map_err(|error| format!("录屏启动任务异常：{error}"))?
}

impl Drop for RecordingManager {
    fn drop(&mut self) {
        if let Some(session) = self.current.get_mut().as_ref() {
            session.shutdown.store(true, Ordering::Release);
        }
    }
}

fn valid_recording_date(date: &str) -> bool {
    let bytes = date.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return false;
    }
    let year = date[..4].parse::<u32>().unwrap_or(0);
    let month = date[5..7].parse::<u32>().unwrap_or(0);
    let day = date[8..].parse::<u32>().unwrap_or(0);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    year >= 1970 && day > 0 && day <= days
}

fn recording_destination(
    root: &Path,
    project: Option<&Path>,
    date: &str,
) -> Result<PathBuf, String> {
    if !root.is_absolute() || !valid_recording_date(date) {
        return Err("录屏保存目录或日期无效".into());
    }
    let directory = if let Some(project) = project {
        if !project.is_absolute() || !project.join("project.json").is_file() {
            return Err("视频项目不存在，请先创建或打开项目".into());
        }
        project.join("assets")
    } else {
        root.join(date)
    };
    std::fs::create_dir_all(&directory).map_err(|e| format!("无法创建录屏保存目录：{e}"))?;
    Ok(directory.join(format!("{}.mp4", Uuid::new_v4())))
}

#[tauri::command]
pub fn default_recording_path(
    app: AppHandle,
    project_root: Option<String>,
    date: String,
) -> Result<String, String> {
    recording_destination(
        &crate::studio::workspace_root(&app)?,
        project_root.as_deref().map(Path::new),
        &date,
    )
    .map(|path| path.to_string_lossy().into_owned())
}

fn websocket_worker(listener: TcpListener, session: Arc<Session>, origin: String, prefix: String) {
    loop {
        let mut connection = None;
        while !session.shutdown.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
                    let result = tungstenite::accept_hdr(
                        stream,
                        |request: &WsRequest, response: WsResponse| {
                            if request.uri().path() != prefix
                                || request
                                    .headers()
                                    .get("Origin")
                                    .and_then(|value| value.to_str().ok())
                                    != Some(origin.as_str())
                            {
                                let mut denied = ErrorResponse::new(Some("禁止访问".into()));
                                *denied.status_mut() = tungstenite::http::StatusCode::FORBIDDEN;
                                return Err(denied);
                            }
                            Ok(response)
                        },
                    );
                    if let Ok(socket) = result {
                        connection = Some(socket);
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(50))
                }
                Err(_) => break,
            }
        }
        let Some(mut socket) = connection else {
            return;
        };
        session.disconnected.store(false, Ordering::Release);
        session.connected.store(true, Ordering::Release);
        let _ = socket
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)));
        let mut last_message = Instant::now() - Duration::from_secs(2);
        let mut last_control = u8::MAX;
        while !session.shutdown.load(Ordering::Acquire) {
            let desired = session.desired.load(Ordering::Acquire);
            if desired != last_control || last_message.elapsed() >= Duration::from_secs(1) {
                if socket
                    .send(Message::Text(session.control_json().to_string().into()))
                    .is_err()
                {
                    break;
                }
                last_control = desired;
                last_message = Instant::now();
            }
            match socket.read() {
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(tungstenite::Error::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => break,
            }
        }
        if let Some(url) = session.replacement_url.lock().as_ref() {
            let _ = socket.send(Message::Text(
                serde_json::json!({"controllerUrl":url}).to_string().into(),
            ));
        } else if session.shutdown.load(Ordering::Acquire) {
            let _ = socket.send(Message::Text(
                serde_json::json!({"controllerClosed":true})
                    .to_string()
                    .into(),
            ));
        }
        let _ = socket.close(None);
        session.disconnected.store(true, Ordering::Release);
        session.connected.store(false, Ordering::Release);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BeginRequest {
    mime: String,
    width: u32,
    height: u32,
    has_audio: bool,
    source_name: String,
    display_surface: Option<String>,
}

struct Output {
    file: Option<NamedTempFile>,
    destination: PathBuf,
    requested: PathBuf,
    next_sequence: u64,
    bytes: u64,
    mime: Option<String>,
}

impl Output {
    fn begin(&mut self, request: &BeginRequest, mode: RecordingMode) -> Result<(), String> {
        if self.mime.is_some() {
            return Err("录屏已经开始".into());
        }
        if !(2..=8192).contains(&request.width) || !(2..=8192).contains(&request.height) {
            return Err("录屏尺寸无效".into());
        }
        let expected = match mode {
            RecordingMode::Window => "window",
            RecordingMode::Tab => "browser",
            _ => "monitor",
        };
        if request.display_surface.as_deref() != Some(expected) {
            return Err("共享来源与所选录屏模式不符，请重新选择".into());
        }
        let extension = if request.mime.starts_with("video/mp4") {
            "mp4"
        } else if request.mime.starts_with("video/webm") {
            "webm"
        } else {
            return Err("不支持的视频编码格式".into());
        };
        self.destination = self.requested.with_extension(extension);
        if self.destination != self.requested && self.destination.exists() {
            return Err("实际视频格式对应的文件已存在，请更换保存文件名".into());
        }
        self.mime = Some(request.mime.clone());
        Ok(())
    }

    fn append(&mut self, sequence: u64, bytes: &[u8]) -> Result<(), String> {
        let mime = self.mime.as_deref().ok_or("录屏尚未开始")?;
        if sequence != self.next_sequence {
            return Err("视频数据顺序不正确，录屏已保留到上一个完整片段".into());
        }
        if bytes.is_empty() {
            return Err("视频片段为空".into());
        }
        if sequence == 0 {
            let valid = if mime.starts_with("video/mp4") {
                bytes.get(4..8) == Some(b"ftyp")
            } else {
                bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
            };
            if !valid {
                return Err("视频文件头无效".into());
            }
        }
        self.file
            .as_mut()
            .ok_or("录屏文件已关闭")?
            .write_all(bytes)
            .map_err(|error| format!("视频写入失败：{error}"))?;
        self.bytes += bytes.len() as u64;
        self.next_sequence += 1;
        Ok(())
    }

    fn finish(&mut self, count: u64) -> Result<PathBuf, String> {
        if self.bytes == 0 || count != self.next_sequence {
            return Err("视频数据未写入完整，无法完成保存".into());
        }
        let mut file = self.file.take().ok_or("视频已保存")?;
        if let Err(error) = file.flush().and_then(|_| file.as_file().sync_all()) {
            self.file = Some(file);
            return Err(format!("视频同步到磁盘失败：{error}"));
        }
        let result = if self.destination == self.requested {
            file.persist(&self.destination)
        } else {
            file.persist_noclobber(&self.destination)
        };
        match result {
            Ok(_) => Ok(self.destination.clone()),
            Err(error) => {
                let message = error.error.to_string();
                self.file = Some(error.file);
                Err(format!("无法保存视频：{message}"))
            }
        }
    }

    fn recover(&mut self) -> Option<PathBuf> {
        if self.bytes == 0 {
            self.file.take();
            return None;
        }
        let mut file = self.file.take()?;
        let _ = file.flush();
        let stem = self.destination.file_stem()?.to_string_lossy();
        let extension = self.destination.extension()?.to_string_lossy();
        let path = self.destination.with_file_name(format!(
            "{stem}-未完成-{}.{}",
            &Uuid::new_v4().simple().to_string()[..8],
            extension
        ));
        file.persist_noclobber(&path).ok().map(|_| path)
    }
}

fn recording_server(
    server: Server,
    session: Arc<Session>,
    origin: String,
    prefix: String,
    ws_port: u16,
    path: PathBuf,
    temporary: NamedTempFile,
    app: Option<AppHandle>,
) {
    let base_path = path.clone();
    let mut output = Output {
        file: Some(temporary),
        destination: path.clone(),
        requested: path,
        next_sequence: 0,
        bytes: 0,
        mime: None,
    };
    let mut terminal_at = None;
    let created = Instant::now();
    loop {
        if session.shutdown.load(Ordering::Acquire) {
            break;
        }
        if session.disconnected.load(Ordering::Acquire) && session.status.lock().active() {
            if session.native_running.load(Ordering::Acquire) {
                let _ = session.control("stop");
            } else {
                fail_session(&session, &mut output, "录屏页面已关闭或连接中断");
            }
        }
        let stop_timed_out = session
            .stop_requested_at
            .lock()
            .is_some_and(|since| since.elapsed() > Duration::from_secs(20));
        if stop_timed_out
            && session.status.lock().active()
            && !session.native_running.load(Ordering::Acquire)
        {
            fail_session(&session, &mut output, "录屏页面未能及时停止");
        }
        if session.status.lock().phase == "waiting"
            && !session.native_running.load(Ordering::Acquire)
            && ((created.elapsed() > Duration::from_secs(600)
                && !session.connected.load(Ordering::Acquire))
                || session.desired.load(Ordering::Acquire) >= STOP)
        {
            output.file.take();
            session.update(|status| {
                status.phase = "cancelled".into();
                status.message = "已取消录屏".into();
            });
        }
        if !session.status.lock().active() {
            let since = terminal_at.get_or_insert_with(Instant::now);
            if since.elapsed() > Duration::from_secs(30)
                && !session.connected.load(Ordering::Acquire)
            {
                break;
            }
        } else {
            terminal_at = None;
        }
        let request = match server.recv_timeout(Duration::from_millis(200)) {
            Ok(Some(request)) => request,
            Ok(None) => continue,
            Err(_) => break,
        };
        handle_request(
            request,
            &session,
            &origin,
            &prefix,
            ws_port,
            &mut output,
            &base_path,
            app.as_ref(),
        );
    }
    if session.status.lock().active() {
        fail_session(&session, &mut output, "录屏连接已停止");
    }
    session.shutdown.store(true, Ordering::Release);
}

fn fail_session(session: &Session, output: &mut Output, message: &str) {
    let recovered = output.recover();
    session.update(|status| {
        status.phase = "error".into();
        status.file_path = recovered.as_ref().map(|path| path.to_string_lossy().into());
        status.message = if recovered.is_some() {
            format!("{message}，已保留未完成的视频文件")
        } else {
            message.into()
        };
    });
}

fn header(request: &Request, name: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str().to_owned())
}

fn respond(request: Request, status: u16, mime: &str, body: impl Into<Vec<u8>>) {
    let mut response = Response::from_data(body.into()).with_status_code(status);
    for (name, value) in [("Content-Type", mime), ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"), ("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://127.0.0.1:*; media-src 'self' blob:; worker-src 'self'; img-src 'self' data:; frame-ancestors 'none'")] {
        response.add_header(Header::from_bytes(name, value).unwrap());
    }
    let _ = request.respond(response);
}

fn json(request: Request, status: u16, value: serde_json::Value) {
    respond(request, status, "application/json", value.to_string());
}

fn body(request: &mut Request, maximum: u64) -> Result<Vec<u8>, String> {
    let expected = request.body_length();
    let mut bytes = Vec::new();
    request
        .as_reader()
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > maximum {
        return Err("请求数据过大".into());
    }
    if expected.is_some_and(|length| length != bytes.len()) {
        return Err("请求数据未传输完整".into());
    }
    Ok(bytes)
}

fn handle_request(
    mut request: Request,
    session: &Arc<Session>,
    origin: &str,
    prefix: &str,
    ws_port: u16,
    output: &mut Output,
    base_path: &Path,
    app: Option<&AppHandle>,
) {
    if header(&request, "Host").as_deref() != Some(origin.trim_start_matches("http://"))
        || header(&request, "Origin").is_some_and(|value| value != origin)
    {
        respond(request, 403, "text/plain", "禁止访问");
        return;
    }
    let url = request.url().to_string();
    let Some(route) = url.strip_prefix(prefix) else {
        respond(request, 404, "text/plain", "录屏会话不存在");
        return;
    };
    if request.method() == &Method::Get {
        match route {
            "" | "index.html" => respond(
                request,
                200,
                "text/html; charset=utf-8",
                include_str!("../recorder/index.html"),
            ),
            "recorder.js" => respond(
                request,
                200,
                "text/javascript; charset=utf-8",
                include_str!("../recorder/recorder.js"),
            ),
            "recorder.css" => respond(
                request,
                200,
                "text/css; charset=utf-8",
                include_str!("../recorder/recorder.css"),
            ),
            "crop-worker.js" => respond(
                request,
                200,
                "text/javascript; charset=utf-8",
                include_str!("../recorder/crop-worker.js"),
            ),
            "config" => {
                let status = session.status.lock().clone();
                json(
                    request,
                    200,
                    serde_json::json!({"options":status.options,"status":status,"nativeCapture":app.is_some() && cfg!(target_os="macos"),"preferredFormat":output.requested.extension().and_then(|extension| extension.to_str()).unwrap_or("mp4"),"webSocketUrl":format!("ws://127.0.0.1:{ws_port}{prefix}")}),
                );
            }
            _ => respond(request, 404, "text/plain", "未找到录屏资源"),
        }
        return;
    }
    if request.method() != &Method::Post {
        respond(request, 405, "text/plain", "不支持的请求方法");
        return;
    }
    // Requests from an earlier round must never append to or stop a new recording.
    if header(&request, "X-Recording-Id").as_deref() != Some(session.status.lock().id.as_str()) {
        json(
            request,
            409,
            serde_json::json!({"error":"录屏任务已更新，请使用当前设置页"}),
        );
        return;
    }
    if route == "restart" {
        let result = (|| -> Result<serde_json::Value, String> {
            let current = session.status.lock().clone();
            if session.native_running.load(Ordering::Acquire)
                || (current.active()
                    && (output.mime.is_some()
                        || !matches!(current.phase.as_str(), "waiting" | "selecting")))
            {
                return Err("请先停止并等待当前录制保存完成".into());
            }
            let data: serde_json::Value = serde_json::from_slice(&body(&mut request, 4096)?)
                .map_err(|error| error.to_string())?;
            let options: RecordingOptions =
                serde_json::from_value(data.clone()).map_err(|error| error.to_string())?;
            if !matches!(options.fps, 15 | 30 | 60) {
                return Err("帧率无效".into());
            }
            // An open standalone controller can continue across midnight. Project
            // recordings and explicitly selected paths stay in their own folder.
            let daily_root = app
                .and_then(|app| crate::studio::workspace_root(app).ok())
                .filter(|root| {
                    base_path.parent().and_then(Path::parent) == Some(root.as_path())
                        && base_path
                            .parent()
                            .and_then(Path::file_name)
                            .and_then(|value| value.to_str())
                            .is_some_and(valid_recording_date)
                });
            let path = if let (Some(root), Some(date)) = (daily_root, data["date"].as_str()) {
                recording_destination(&root, None, date)?
            } else if current.phase == "waiting" && output.mime.is_none() {
                output.requested.clone()
            } else {
                next_recording_path(base_path)
            };
            let temporary =
                NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
            *output = Output {
                file: Some(temporary),
                destination: path.clone(),
                requested: path,
                next_sequence: 0,
                bytes: 0,
                mime: None,
            };
            session.desired.store(CONTINUE, Ordering::Release);
            session.stop_requested_at.lock().take();
            session.update(|status| {
                status.id = Uuid::new_v4().to_string();
                status.mode = options.mode;
                status.options = options;
                status.phase = "waiting".into();
                status.message = "请选择下一次录制的内容".into();
                status.elapsed_ms = 0;
                status.bytes_written = 0;
                status.file_path = None;
                status.width = 0;
                status.height = 0;
                status.has_audio = false;
                status.source_name.clear();
            });
            Ok(serde_json::json!({"status":session.status.lock().clone()}))
        })();
        match result {
            Ok(value) => json(request, 200, value),
            Err(error) => json(request, 400, serde_json::json!({"error":error})),
        }
        return;
    }
    if !session.status.lock().active() && !matches!(route, "reveal" | "native-sources") {
        json(request, 409, serde_json::json!({"error":"录屏会话已结束"}));
        return;
    }
    let result: Result<serde_json::Value, String> = (|| match route {
        "reveal" => {
            let app = app.ok_or("请在 ScreenShot 中打开保存目录")?;
            reveal_recording(app.state::<RecordingManager>())?;
            Ok(serde_json::json!({"ok":true}))
        }
        "native-sources" => {
            let app = app.ok_or("当前系统不支持本机来源选择")?;
            tauri::async_runtime::block_on(native_capture_sources(app.clone()))
        }
        "native-region" => {
            let app = app.ok_or("当前系统不支持本机区域框选")?;
            let value: serde_json::Value =
                serde_json::from_slice(&body(&mut request, 4096)?).map_err(|e| e.to_string())?;
            let monitor = value["monitorId"]
                .as_u64()
                .and_then(|id| u32::try_from(id).ok())
                .ok_or("请选择显示器")?;
            let selected = tauri::async_runtime::block_on(
                crate::capture::select_recording_region(app.clone(), monitor, Some(false)),
            )?;
            serde_json::to_value(selected).map_err(|e| e.to_string())
        }
        "native-begin" => {
            let app = app.ok_or("当前系统不支持原生录制")?;
            if !cfg!(target_os = "macos")
                || session.status.lock().mode == RecordingMode::Tab
                || output.mime.is_some()
                || session.native_running.load(Ordering::Acquire)
            {
                return Err("当前录制来源不可用".into());
            }
            let source: serde_json::Value =
                serde_json::from_slice(&body(&mut request, 4096)?).map_err(|e| e.to_string())?;
            launch_native(
                app.clone(),
                session.clone(),
                source,
                output.requested.clone(),
            )?;
            Ok(session.control_json())
        }
        "begin" => {
            let data: BeginRequest = serde_json::from_slice(&body(&mut request, 64 * 1024)?)
                .map_err(|error| error.to_string())?;
            if session.desired.load(Ordering::Acquire) >= STOP {
                return Err("录屏已取消".into());
            }
            if app.is_some()
                && cfg!(target_os = "macos")
                && session.status.lock().mode != RecordingMode::Tab
            {
                return Err("窗口和屏幕请使用排除工具界面的原生录制".into());
            }
            output.begin(&data, session.status.lock().mode)?;
            session.update(|status| {
                status.phase = "recording".into();
                status.message = "录屏进行中，可切换回目标应用".into();
                status.width = data.width;
                status.height = data.height;
                status.has_audio = data.has_audio;
                status.source_name = data.source_name.chars().take(300).collect();
                status.file_path = Some(output.destination.to_string_lossy().into());
            });
            Ok(serde_json::json!({"path":output.destination}))
        }
        "selecting" => {
            if output.mime.is_none() {
                session.update(|status| {
                    status.phase = "selecting".into();
                    status.message = "请在共享画面上框选录制范围".into();
                });
            }
            Ok(session.control_json())
        }
        "state" => {
            let value: serde_json::Value = serde_json::from_slice(&body(&mut request, 4096)?)
                .map_err(|error| error.to_string())?;
            if output.mime.is_some() && session.desired.load(Ordering::Acquire) < STOP {
                let phase = value["phase"].as_str().unwrap_or("");
                if matches!(phase, "recording" | "paused") {
                    session.update(|status| {
                        status.phase = phase.into();
                        status.elapsed_ms =
                            value["elapsedMs"].as_u64().unwrap_or(status.elapsed_ms);
                        status.message = if phase == "paused" {
                            "录屏已暂停".into()
                        } else {
                            "录屏进行中，可切换回目标应用".into()
                        };
                    });
                }
            }
            Ok(session.control_json())
        }
        "finish" => {
            let value: serde_json::Value = serde_json::from_slice(&body(&mut request, 4096)?)
                .map_err(|error| error.to_string())?;
            let path = output.finish(value["chunks"].as_u64().ok_or("缺少视频片段数量")?)?;
            session.update(|status| {
                status.phase = "saved".into();
                status.elapsed_ms = value["elapsedMs"].as_u64().unwrap_or(status.elapsed_ms);
                status.message = "录屏已保存".into();
                status.file_path = Some(path.to_string_lossy().into());
            });
            Ok(serde_json::json!({"path":path}))
        }
        "control" => {
            let value: serde_json::Value = serde_json::from_slice(&body(&mut request, 4096)?)
                .map_err(|error| error.to_string())?;
            session.control(value["action"].as_str().ok_or("缺少录屏操作")?)?;
            Ok(session.control_json())
        }
        "cancel" => {
            if output.bytes > 0 {
                return Err("已有录屏数据，请停止并保存".into());
            }
            output.file.take();
            session.update(|status| {
                status.phase = "cancelled".into();
                status.message = "已取消录屏".into();
            });
            Ok(serde_json::json!({"ok":true}))
        }
        "error" => {
            let value: serde_json::Value = serde_json::from_slice(&body(&mut request, 4096)?)
                .map_err(|error| error.to_string())?;
            if session.native_running.load(Ordering::Acquire) {
                session.control("stop")?;
                return Ok(session.control_json());
            }
            fail_session(
                session,
                output,
                &value["message"]
                    .as_str()
                    .unwrap_or("录屏出错")
                    .chars()
                    .take(500)
                    .collect::<String>(),
            );
            Ok(serde_json::json!({"ok":true}))
        }
        _ if route.starts_with("chunk?seq=") => {
            let sequence: u64 = route
                .trim_start_matches("chunk?seq=")
                .parse()
                .map_err(|_| "视频片段序号无效")?;
            let bytes = body(&mut request, MAX_CHUNK)?;
            output.append(sequence, &bytes)?;
            session.update(|status| status.bytes_written = output.bytes);
            Ok(session.control_json())
        }
        _ => Err("未找到录屏操作".into()),
    })();
    match result {
        Ok(value) => json(request, 200, value),
        Err(error) => json(request, 400, serde_json::json!({"error":error})),
    }
}

fn next_recording_path(base: &Path) -> PathBuf {
    base.with_file_name(format!(
        "{}-{}.{}",
        base.file_stem().unwrap_or_default().to_string_lossy(),
        &Uuid::new_v4().simple().to_string()[..8],
        base.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("mp4")
    ))
}

fn launch_native(
    app: AppHandle,
    session: Arc<Session>,
    source: serde_json::Value,
    path: PathBuf,
) -> Result<(), String> {
    let options = session.status.lock().options.clone();
    let helper = crate::studio::resource(&app, "runtime/screenshot-recorder");
    if !helper.is_file() {
        return Err("未找到原生录屏组件，请重新打包安装".into());
    }
    let destination = path.with_extension("mp4");
    if destination != path && destination.exists() {
        return Err("同名 MP4 已存在，请更换文件名".into());
    }
    let temporary =
        destination.with_file_name(format!(".ScreenShot-{}.partial.mp4", Uuid::new_v4()));
    let mix_audio = options.audio && source["microphone"] == true;
    let mut config = serde_json::to_value(&options).map_err(|e| e.to_string())?;
    config["excludedProcessIDs"] = serde_json::json!([std::process::id()]);
    for key in ["sourceId", "crop", "microphone", "cursor", "clicks"] {
        if let Some(value) = source.get(key) {
            config[key] = value.clone();
        }
    }
    let mut child = Command::new(helper)
        .arg(config.to_string())
        .arg(&temporary)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动原生录屏：{e}"))?;
    let input = Arc::new(Mutex::new(child.stdin.take().unwrap()));
    let output = child.stdout.take().unwrap();
    let errors = child.stderr.take().unwrap();
    let diagnostics = thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let mut tail = String::new();
        for line in BufReader::new(errors).lines().map_while(Result::ok) {
            tail.push_str(&line);
            tail.push('\n');
            if tail.len() > 8192 {
                tail = tail
                    .chars()
                    .rev()
                    .take(4096)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
            }
        }
        tail
    });
    let child = Arc::new(Mutex::new(child));
    let startup_process = child.clone();
    let startup_session = session.clone();
    session.native_running.store(true, Ordering::Release);
    let recording_id = session.status.lock().id.clone();
    let controller = session.clone();
    let process = child.clone();
    let temporary_metrics = temporary.clone();
    thread::spawn(move || {
        let mut previous = CONTINUE;
        let mut elapsed = 0;
        let mut last = Instant::now();
        let mut tick = Instant::now();
        while controller.native_running.load(Ordering::Acquire)
            && controller.status.lock().id == recording_id
        {
            let command = controller.desired.load(Ordering::Acquire);
            if command != previous {
                let name = match command {
                    PAUSE => "pause",
                    STOP | CANCEL => "stop",
                    _ => "resume",
                };
                let _ = writeln!(input.lock(), "{name}");
                previous = command;
            }
            let phase = controller.status.lock().phase.clone();
            if phase == "recording" {
                elapsed += last.elapsed().as_millis() as u64;
            }
            last = Instant::now();
            if tick.elapsed() >= Duration::from_secs(1) {
                let bytes = std::fs::metadata(&temporary_metrics)
                    .map(|m| m.len())
                    .unwrap_or(0);
                controller.update(|status| {
                    if status.id == recording_id {
                        status.elapsed_ms = elapsed;
                        status.bytes_written = bytes;
                    }
                });
                tick = Instant::now();
            }
            if controller
                .stop_requested_at
                .lock()
                .is_some_and(|since| since.elapsed() > Duration::from_secs(30))
            {
                let _ = process.lock().kill();
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    });
    thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let mut saved = false;
        let mut message = "原生录屏进程已结束".to_string();
        for line in BufReader::new(output).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            match value["event"].as_str().unwrap_or("") {
                "started" => {
                    session.update(|status| {
                        status.phase = "recording".into();
                        status.message = "原生录屏进行中".into();
                        status.width = value["width"].as_u64().unwrap_or(0) as u32;
                        status.height = value["height"].as_u64().unwrap_or(0) as u32;
                        status.has_audio = value["hasAudio"] == true;
                    });
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
                "paused" => session.update(|s| {
                    s.phase = "paused".into();
                    s.message = "录屏已暂停".into();
                }),
                "resumed" => session.update(|s| {
                    s.phase = "recording".into();
                    s.message = "原生录屏进行中".into();
                }),
                "saved" => {
                    saved = true;
                }
                "error" | "sourceEnded" => {
                    message = value["message"].as_str().unwrap_or("原生录屏失败").into();
                }
                _ => {}
            }
        }
        let exit_status = child.lock().wait();
        let diagnostic = diagnostics.join().unwrap_or_default();
        if !saved {
            if message == "原生录屏进程已结束" {
                message = format!(
                    "原生录屏进程异常退出（{}）",
                    exit_status
                        .map(|status| status.to_string())
                        .unwrap_or_else(|error| error.to_string())
                );
            }
            if !diagnostic.trim().is_empty() {
                message.push_str("：");
                message.push_str(diagnostic.trim());
            }
        }
        if saved && mix_audio {
            session.update(|status| {
                status.phase = "saving".into();
                status.message = "正在合并系统声音和麦克风…".into();
            });
            if let Err(error) = crate::studio::mix_recording_audio(&app, &temporary) {
                saved = false;
                message = error;
            }
        }
        let bytes = std::fs::metadata(&temporary).map(|m| m.len()).unwrap_or(0);
        if saved && bytes > 0 {
            let commit = if destination == path {
                std::fs::rename(&temporary, &destination)
            } else {
                std::fs::hard_link(&temporary, &destination)
                    .and_then(|_| std::fs::remove_file(&temporary))
            };
            if let Err(error) = commit {
                saved = false;
                message = format!("视频提交失败：{error}");
            }
        } else {
            saved = false;
        }
        let final_path = if saved {
            Some(destination)
        } else if bytes > 0 {
            let recovery = path.with_file_name(format!(
                "{}-未完成-{}.mp4",
                path.file_stem().unwrap_or_default().to_string_lossy(),
                &Uuid::new_v4().simple().to_string()[..8]
            ));
            if std::fs::rename(&temporary, &recovery).is_ok() {
                Some(recovery)
            } else {
                Some(temporary.clone())
            }
        } else {
            let _ = std::fs::remove_file(&temporary);
            None
        };
        session.native_running.store(false, Ordering::Release);
        session.update(|status| {
            status.phase = if saved { "saved" } else { "error" }.into();
            status.message = if saved {
                "录屏已保存".into()
            } else {
                message
            };
            status.bytes_written = bytes;
            status.file_path = final_path.map(|p| p.to_string_lossy().into_owned());
        });
        if session.url.is_empty() {
            session.shutdown.store(true, Ordering::Release);
        }
    });
    let started = Instant::now();
    loop {
        let status = startup_session.status.lock().clone();
        match status.phase.as_str() {
            "recording" | "paused" | "saved" => return Ok(()),
            "error" | "cancelled" => return Err(status.message),
            _ if started.elapsed() > Duration::from_secs(15) => {
                let _ = startup_process.lock().kill();
                return Err("原生录屏启动超时，请检查屏幕录制权限后重试".into());
            }
            _ => thread::sleep(Duration::from_millis(15)),
        }
    }
}

fn available_browsers() -> Vec<(String, String, PathBuf)> {
    let mut browsers = Vec::new();
    #[cfg(target_os = "macos")]
    for (id, name, path) in [
        ("chrome", "Google Chrome", "/Applications/Google Chrome.app"),
        ("edge", "Microsoft Edge", "/Applications/Microsoft Edge.app"),
    ] {
        if Path::new(path).is_dir() {
            browsers.push((id.into(), name.into(), path.into()));
        }
    }
    #[cfg(target_os = "windows")]
    for root in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(root) {
            for (id, name, suffix) in [
                (
                    "chrome",
                    "Google Chrome",
                    "Google/Chrome/Application/chrome.exe",
                ),
                (
                    "edge",
                    "Microsoft Edge",
                    "Microsoft/Edge/Application/msedge.exe",
                ),
            ] {
                let path = PathBuf::from(&base).join(suffix);
                if path.is_file() {
                    if !browsers.iter().any(|(existing, _, _)| existing == id) {
                        browsers.push((id.into(), name.into(), path));
                    }
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        for (id, name) in [
            ("chrome", "google-chrome"),
            ("chromium", "chromium"),
            ("edge", "microsoft-edge"),
        ] {
            let path = directory.join(name);
            if path.is_file() {
                if !browsers.iter().any(|(existing, _, _)| existing == id) {
                    browsers.push((id.into(), name.into(), path));
                }
            }
        }
    }
    browsers
}

fn recording_browser(preference: Option<&str>) -> Result<(String, Option<PathBuf>), String> {
    let browsers = available_browsers();
    match preference.unwrap_or("auto") {
        "system" => Ok(("默认浏览器".into(), None)),
        "auto" => Ok(browsers
            .into_iter()
            .next()
            .map(|(_, name, path)| (name, Some(path)))
            .unwrap_or(("默认浏览器".into(), None))),
        id => browsers
            .into_iter()
            .find(|(candidate, _, _)| candidate == id)
            .map(|(_, name, path)| (name, Some(path)))
            .ok_or_else(|| "所选录屏浏览器未安装".into()),
    }
}

#[tauri::command]
pub fn get_recording_browsers() -> Vec<serde_json::Value> {
    available_browsers()
        .into_iter()
        .map(|(id, name, _)| serde_json::json!({"id":id,"name":name}))
        .collect()
}

fn open_browser(url: &str, preference: Option<&str>) -> Result<(), String> {
    let (_, browser) = recording_browser(preference)?;
    #[cfg(target_os = "macos")]
    let result = if let Some(browser) = browser {
        let executable = browser
            .join("Contents/MacOS")
            .join(browser.file_stem().unwrap());
        Command::new(executable)
            .arg(format!("--app={url}"))
            .spawn()
            .map(|mut child| {
                thread::spawn(move || {
                    let _ = child.wait();
                });
            })
    } else {
        Command::new("open").arg(url).status().and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(std::io::Error::other("浏览器未能启动"))
            }
        })
    };
    #[cfg(target_os = "windows")]
    let result = {
        use std::os::windows::process::CommandExt;
        if let Some(browser) = browser {
            Command::new(browser)
                .arg(format!("--app={url}"))
                .creation_flags(0x08000000)
                .spawn()
                .map(|_| ())
        } else {
            Command::new("rundll32")
                .args(["url.dll,FileProtocolHandler", url])
                .creation_flags(0x08000000)
                .spawn()
                .map(|_| ())
        }
    };
    #[cfg(target_os = "linux")]
    let result = if let Some(browser) = browser {
        Command::new(browser).arg(url).spawn().map(|_| ())
    } else {
        Command::new("xdg-open").arg(url).spawn().map(|_| ())
    };
    result.map_err(|error| format!("无法打开录屏浏览器：{error}"))?;
    Ok(())
}

#[tauri::command]
pub fn get_recording_status(state: State<'_, RecordingManager>) -> Option<RecordingStatus> {
    state.status()
}

#[tauri::command]
pub fn start_recording_session(
    app: AppHandle,
    state: State<'_, RecordingManager>,
    options: RecordingOptions,
    path: String,
) -> Result<RecordingStatus, String> {
    let event_app = app.clone();
    let sink: EventSink = Arc::new(move |status| {
        let manager = event_app.state::<RecordingManager>();
        if manager
            .status()
            .is_some_and(|current| current.id == status.id)
        {
            let _ = event_app.emit_to("main", "recording-status", &status);
            if !status.active() && manager.quit_when_finished.load(Ordering::Acquire) {
                event_app.exit(0);
            }
        }
    });
    let (browser, _) = recording_browser(options.browser.as_deref())?;
    let prepared =
        state.prepare_with_app(options, path.into(), browser, sink, Some(app.clone()))?;
    let preference = state
        .current
        .lock()
        .as_ref()
        .and_then(|session| session.status.lock().options.browser.clone());
    if !prepared.reused_controller {
        let session = state.current.lock().clone().ok_or("没有录屏任务")?;
        if let Err(error) = launch_controller(&session, preference.as_deref()) {
            let _ = state.control("cancel");
            return Err(error);
        }
    }
    Ok(prepared.status)
}

#[tauri::command]
pub fn recording_control(state: State<'_, RecordingManager>, action: String) -> Result<(), String> {
    state.control(&action)
}

#[tauri::command]
pub fn reopen_recording_browser(state: State<'_, RecordingManager>) -> Result<(), String> {
    let current = state.current.lock();
    let session = current.as_ref().ok_or("没有录屏任务")?;
    if session.status.lock().phase != "waiting" {
        return Err("录屏已经开始，请保留原有录屏页面".into());
    }
    if session.connected.load(Ordering::Acquire) {
        return Err("录屏页面已打开，请切回浏览器继续选择".into());
    }
    let browser = session.status.lock().options.browser.clone();
    launch_controller(session, browser.as_deref())
}

fn launch_controller(session: &Session, browser: Option<&str>) -> Result<(), String> {
    let mut launched = session.browser_launch.lock();
    if launched.is_some_and(|time| time.elapsed() < Duration::from_secs(15)) {
        return Err("录屏页面正在打开，请稍候".into());
    }
    open_browser(&session.url, browser)?;
    *launched = Some(Instant::now());
    Ok(())
}

#[tauri::command]
pub fn reveal_recording(state: State<'_, RecordingManager>) -> Result<(), String> {
    let path = state
        .status()
        .and_then(|status| status.file_path)
        .ok_or("尚无已保存的视频")?;
    if !Path::new(&path).is_file() {
        return Err("视频文件不存在".into());
    }
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg("-R").arg(&path).status();
    #[cfg(target_os = "windows")]
    let result = Command::new("explorer")
        .arg(format!("/select,{path}"))
        .status();
    #[cfg(target_os = "linux")]
    let result = Command::new("xdg-open")
        .arg(Path::new(&path).parent().unwrap())
        .status();
    result.map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, net::TcpStream};

    #[test]
    fn recording_paths_use_daily_folders_or_existing_project_assets() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("screenshot");
        let first = recording_destination(&root, None, "2026-10-21").unwrap();
        let second = recording_destination(&root, None, "2026-10-21").unwrap();
        assert_eq!(first.parent(), Some(root.join("2026-10-21").as_path()));
        assert_ne!(first, second);
        assert!(!first.exists());
        let tomorrow = recording_destination(&root, None, "2026-10-22").unwrap();
        assert_eq!(tomorrow.parent(), Some(root.join("2026-10-22").as_path()));
        for date in [
            "../escape",
            "2026-02-29",
            "2026-13-01",
            "2026-10-00",
            "é026-10-21",
        ] {
            assert!(recording_destination(&root, None, date).is_err());
        }
        assert!(recording_destination(&root, None, "2028-02-29").is_ok());
        let project = directory.path().join("existing-project");
        assert!(recording_destination(&root, Some(&project), "2026-10-21").is_err());
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("project.json"), "{}").unwrap();
        let path = recording_destination(&root, Some(&project), "2026-10-21").unwrap();
        assert_eq!(path.parent(), Some(project.join("assets").as_path()));
    }

    #[test]
    fn recording_resolution_accepts_2k_and_legacy_options() {
        let legacy =
            serde_json::json!({"mode":"desktop","fps":30,"audio":false,"originalResolution":true});
        let old: RecordingOptions = serde_json::from_value(legacy.clone()).unwrap();
        assert!(old.original_resolution);
        assert!(old.resolution.is_none());
        for (name, expected) in [
            ("1080p", RecordingResolution::FullHd),
            ("2k", RecordingResolution::Qhd),
            ("4k", RecordingResolution::Uhd),
        ] {
            let mut value = legacy.clone();
            value["resolution"] = name.into();
            let options: RecordingOptions = serde_json::from_value(value).unwrap();
            assert_eq!(options.resolution, Some(expected));
            assert_eq!(serde_json::to_value(options).unwrap()["resolution"], name);
        }
        let mut invalid = legacy;
        invalid["resolution"] = "8k".into();
        assert!(serde_json::from_value::<RecordingOptions>(invalid).is_err());
    }

    fn options(mode: RecordingMode) -> RecordingOptions {
        RecordingOptions {
            mode,
            fps: 30,
            audio: false,
            original_resolution: false,
            resolution: None,
            browser: None,
        }
    }

    fn output(path: PathBuf) -> Output {
        Output {
            file: Some(NamedTempFile::new_in(path.parent().unwrap()).unwrap()),
            destination: path.clone(),
            requested: path,
            next_sequence: 0,
            bytes: 0,
            mime: None,
        }
    }

    fn begin(mime: &str, surface: &str) -> BeginRequest {
        BeginRequest {
            mime: mime.into(),
            width: 640,
            height: 360,
            has_audio: false,
            source_name: "Test source".into(),
            display_surface: Some(surface.into()),
        }
    }

    const MP4: &[u8] = b"\0\0\0\x18ftypisom\0\0\0\0isomiso2";

    #[test]
    fn video_fragments_are_ordered_and_replaced_only_after_complete_save() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("video.mp4");
        fs::write(&path, b"existing video").unwrap();
        let mut file = output(path.clone());
        file.begin(&begin("video/mp4", "window"), RecordingMode::Window)
            .unwrap();
        assert!(file.append(0, b"bad header").is_err());
        file.append(0, MP4).unwrap();
        assert!(file.append(0, b"duplicate").is_err());
        assert!(file.append(2, b"missing fragment").is_err());
        assert!(file.finish(2).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"existing video");
        file.append(1, b"media fragment").unwrap();
        assert_eq!(file.finish(2).unwrap(), path);
        assert_eq!(fs::read(path).unwrap(), [MP4, b"media fragment"].concat());
    }

    #[test]
    fn interrupted_recordings_keep_a_separate_recovery_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("video.mp4");
        fs::write(&path, b"keep existing").unwrap();
        let mut file = output(path.clone());
        file.begin(&begin("video/mp4", "monitor"), RecordingMode::Desktop)
            .unwrap();
        file.append(0, MP4).unwrap();
        let recovered = file.recover().unwrap();
        assert_ne!(recovered, path);
        assert_eq!(fs::read(recovered).unwrap(), MP4);
        assert_eq!(fs::read(path).unwrap(), b"keep existing");
    }

    #[test]
    fn source_type_and_container_are_checked_before_recording() {
        let directory = tempfile::tempdir().unwrap();
        let mut file = output(directory.path().join("video.mp4"));
        assert!(file
            .begin(&begin("video/mp4", "window"), RecordingMode::Tab)
            .is_err());
        assert!(file
            .begin(&begin("video/avi", "browser"), RecordingMode::Tab)
            .is_err());
        let mut unknown = begin("video/mp4", "browser");
        unknown.display_surface = None;
        assert!(file.begin(&unknown, RecordingMode::Tab).is_err());
        assert!(file.begin(&unknown, RecordingMode::Window).is_err());
        file.begin(&begin("video/mp4", "browser"), RecordingMode::Tab)
            .unwrap();
        assert!(file
            .begin(&begin("video/mp4", "browser"), RecordingMode::Tab)
            .is_err());
    }

    #[test]
    fn fallback_format_never_overwrites_a_different_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let requested = directory.path().join("video.mp4");
        let other = directory.path().join("video.webm");
        fs::write(&other, b"keep").unwrap();
        let mut file = output(requested);
        assert!(file
            .begin(&begin("video/webm", "monitor"), RecordingMode::Region)
            .is_err());
        assert_eq!(fs::read(other).unwrap(), b"keep");
    }

    fn http(
        url: &str,
        method: &str,
        path: &str,
        origin: Option<&str>,
        host: Option<&str>,
    ) -> String {
        let address = url.trim_start_matches("http://").split('/').next().unwrap();
        let mut stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let origin = origin
            .map(|value| format!("Origin: {value}\r\n"))
            .unwrap_or_default();
        write!(stream, "{method} {path} HTTP/1.1\r\nHost: {}\r\n{origin}Connection: close\r\nContent-Length: 0\r\n\r\n", host.unwrap_or(address)).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    #[test]
    fn loopback_recording_routes_require_the_session_and_same_origin() {
        let directory = tempfile::tempdir().unwrap();
        let manager = RecordingManager::default();
        let prepared = manager
            .prepare(
                options(RecordingMode::Window),
                directory.path().join("video.mp4"),
                "Test".into(),
                Arc::new(|_| {}),
            )
            .unwrap();
        let path = format!("/{}", prepared.url.splitn(4, '/').nth(3).unwrap());
        assert!(http(&prepared.url, "GET", &path, None, None).starts_with("HTTP/1.1 200"));
        assert!(
            http(&prepared.url, "GET", "/other-session/", None, None).starts_with("HTTP/1.1 404")
        );
        assert!(http(
            &prepared.url,
            "GET",
            &path,
            Some("https://example.com"),
            None
        )
        .starts_with("HTTP/1.1 403"));
        assert!(
            http(&prepared.url, "GET", &path, None, Some("evil.local")).starts_with("HTTP/1.1 403")
        );
        assert!(http(
            &prepared.url,
            "GET",
            &format!("{path}../Cargo.toml"),
            None,
            None
        )
        .starts_with("HTTP/1.1 404"));
        assert!(manager
            .prepare(
                options(RecordingMode::Desktop),
                directory.path().join("second.mp4"),
                "Test".into(),
                Arc::new(|_| {})
            )
            .is_err());
        manager.control("cancel").unwrap();
    }

    #[test]
    fn websocket_control_rejects_other_origins_and_delivers_stop() {
        use tungstenite::client::IntoClientRequest;
        let directory = tempfile::tempdir().unwrap();
        let manager = RecordingManager::default();
        let prepared = manager
            .prepare(
                options(RecordingMode::Desktop),
                directory.path().join("video.mp4"),
                "Test".into(),
                Arc::new(|_| {}),
            )
            .unwrap();
        let path = format!("/{}config", prepared.url.splitn(4, '/').nth(3).unwrap());
        let response = http(&prepared.url, "GET", &path, None, None);
        let config: serde_json::Value =
            serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
        let websocket_url = config["webSocketUrl"].as_str().unwrap();
        let mut denied = websocket_url.into_client_request().unwrap();
        denied
            .headers_mut()
            .insert("Origin", "https://example.com".parse().unwrap());
        assert!(tungstenite::connect(denied).is_err());
        let origin = prepared
            .url
            .trim_end_matches('/')
            .rsplit_once('/')
            .unwrap()
            .0;
        let mut request = websocket_url.into_client_request().unwrap();
        request
            .headers_mut()
            .insert("Origin", origin.parse().unwrap());
        let (mut socket, _) = tungstenite::connect(request).unwrap();
        manager.control("stop").unwrap();
        for _ in 0..5 {
            let data = socket.read().unwrap();
            if let Message::Text(text) = data {
                let value: serde_json::Value = serde_json::from_str(&text).unwrap();
                if value["command"] == "stop" {
                    let _ = socket.close(None);
                    return;
                }
            }
        }
        panic!("stop command was not delivered");
    }
}
