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
    pub original_resolution: bool,
    #[serde(default)]
    pub browser: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub id: String,
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
    options: RecordingOptions,
    desired: AtomicU8,
    disconnected: AtomicBool,
    connected: AtomicBool,
    shutdown: AtomicBool,
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
        serde_json::json!({"command":command, "phase":self.status.lock().phase})
    }
}

#[derive(Default)]
pub struct RecordingManager {
    current: Mutex<Option<Arc<Session>>>,
    pub quit_when_finished: AtomicBool,
    pub stop_shortcut_available: AtomicBool,
}

pub struct PreparedRecording {
    pub url: String,
    pub status: RecordingStatus,
}

impl RecordingManager {
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

    pub fn prepare(
        &self,
        options: RecordingOptions,
        path: PathBuf,
        browser: String,
        sink: EventSink,
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
        let status = RecordingStatus {
            id: Uuid::new_v4().to_string(),
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
            options,
            desired: AtomicU8::new(CONTINUE),
            disconnected: AtomicBool::new(false),
            connected: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
            stop_requested_at: Mutex::new(None),
            url: format!("{origin}{prefix}"),
            sink,
        });
        if let Some(previous) = current.replace(session.clone()) {
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
            )
        });
        (session.sink)(status.clone());
        Ok(PreparedRecording {
            url: session.url.clone(),
            status,
        })
    }
}

impl Drop for RecordingManager {
    fn drop(&mut self) {
        if let Some(session) = self.current.get_mut().as_ref() {
            session.shutdown.store(true, Ordering::Release);
        }
    }
}

fn websocket_worker(listener: TcpListener, session: Arc<Session>, origin: String, prefix: String) {
    let deadline = Instant::now() + Duration::from_secs(600);
    let mut connection = None;
    while !session.shutdown.load(Ordering::Acquire) && Instant::now() < deadline {
        if !session.status.lock().active() {
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
                let result =
                    tungstenite::accept_hdr(stream, |request: &WsRequest, response: WsResponse| {
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
                    });
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
    let _ = socket.close(None);
    session.disconnected.store(true, Ordering::Release);
    session.connected.store(false, Ordering::Release);
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
) {
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
            fail_session(&session, &mut output, "录屏页面已关闭或连接中断");
        }
        let stop_timed_out = session
            .stop_requested_at
            .lock()
            .is_some_and(|since| since.elapsed() > Duration::from_secs(20));
        if stop_timed_out && session.status.lock().active() {
            fail_session(&session, &mut output, "录屏页面未能及时停止");
        }
        if session.status.lock().phase == "waiting"
            && (created.elapsed() > Duration::from_secs(600)
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
            if since.elapsed() > Duration::from_secs(30) {
                break;
            }
        }
        let request = match server.recv_timeout(Duration::from_millis(200)) {
            Ok(Some(request)) => request,
            Ok(None) => continue,
            Err(_) => break,
        };
        handle_request(request, &session, &origin, &prefix, ws_port, &mut output);
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
    session: &Session,
    origin: &str,
    prefix: &str,
    ws_port: u16,
    output: &mut Output,
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
            "config" => json(
                request,
                200,
                serde_json::json!({"options":session.options,"status":session.status.lock().clone(),"preferredFormat":output.requested.extension().and_then(|extension| extension.to_str()).unwrap_or("mp4"),"webSocketUrl":format!("ws://127.0.0.1:{ws_port}{prefix}")}),
            ),
            _ => respond(request, 404, "text/plain", "未找到录屏资源"),
        }
        return;
    }
    if request.method() != &Method::Post {
        respond(request, 405, "text/plain", "不支持的请求方法");
        return;
    }
    if !session.status.lock().active() {
        json(request, 409, serde_json::json!({"error":"录屏会话已结束"}));
        return;
    }
    let result: Result<serde_json::Value, String> = (|| match route {
        "begin" => {
            let data: BeginRequest = serde_json::from_slice(&body(&mut request, 64 * 1024)?)
                .map_err(|error| error.to_string())?;
            if session.desired.load(Ordering::Acquire) >= STOP {
                return Err("录屏已取消".into());
            }
            output.begin(&data, session.options.mode)?;
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
    let result = {
        let mut command = Command::new("open");
        if let Some(browser) = browser {
            command.arg("-a").arg(browser);
        }
        command.arg(url).status().and_then(|status| {
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
                .arg(url)
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
    let prepared = state.prepare(options, path.into(), browser, sink)?;
    let preference = state
        .current
        .lock()
        .as_ref()
        .and_then(|session| session.options.browser.clone());
    if let Err(error) = open_browser(&prepared.url, preference.as_deref()) {
        let _ = state.control("cancel");
        return Err(error);
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
    open_browser(&session.url, session.options.browser.as_deref())
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

    fn options(mode: RecordingMode) -> RecordingOptions {
        RecordingOptions {
            mode,
            fps: 30,
            audio: false,
            original_resolution: false,
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
