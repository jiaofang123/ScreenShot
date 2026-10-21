use std::{
    collections::HashMap,
    ffi::c_void,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use image::{imageops, RgbaImage};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{
    async_runtime, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition,
    PhysicalSize, Position, Size, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use xcap::Monitor;

use crate::{
    capture_cache::CaptureCache,
    image_utils::{image_to_data_url, image_to_preview_data_url},
    stitch::{ScrollStitcher, StitchOutcome},
};

const CURSOR_HIDE_SETTLE: Duration = Duration::from_millis(60);

#[derive(Default)]
pub struct AppState {
    pub images: CaptureCache,
    snapshots: Mutex<HashMap<u32, MonitorSnapshot>>,
    long_capture_cancel: Mutex<Option<Arc<AtomicBool>>>,
    capture_in_progress: AtomicBool,
    overlay_session: AtomicU64,
    overlay_setup: Mutex<()>,
    recording_selection: Mutex<Option<RecordingSelectionRequest>>,
}

struct RecordingSelectionRequest {
    session_id: u64,
    monitor_id: u32,
    restore_main: bool,
    reply: async_runtime::Sender<Option<RecordingSelection>>,
}

#[derive(Debug, Serialize)]
pub struct RecordingCrop {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Serialize)]
pub struct RecordingSelection {
    crop: RecordingCrop,
    width: u32,
    height: u32,
}

struct CursorHideGuard {
    #[cfg(target_os = "macos")]
    display_ids: Vec<u32>,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
#[repr(C)]
struct CGPoint {
    x: f64,
    y: f64,
}

struct CursorPositionGuard {
    #[cfg(target_os = "macos")]
    original: Option<CGPoint>,
}

impl Drop for CursorHideGuard {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        {
            for display_id in self.display_ids.iter().rev() {
                unsafe {
                    CGDisplayShowCursor(*display_id);
                }
            }
        }
    }
}

impl Drop for CursorPositionGuard {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        {
            if let Some(original) = self.original {
                unsafe {
                    let _ = CGWarpMouseCursorPosition(original);
                }
            }
        }
    }
}

struct MonitorSnapshot {
    session_id: u64,
    id: u32,
    name: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f32,
    preview_data_url: String,
    image: RgbaImage,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlaySnapshot {
    session_id: u64,
    monitor_id: u32,
    name: String,
    width: u32,
    height: u32,
    scale_factor: f32,
    data_url: String,
    purpose: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapturePayload {
    capture_id: u64,
    data_url: String,
    width: u32,
    height: u32,
    capture_kind: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LongCaptureStatus {
    status: String,
    total_height: u32,
    message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRegion {
    session_id: u64,
    monitor_id: u32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn CGDisplayHideCursor(display: u32) -> i32;
    fn CGDisplayShowCursor(display: u32) -> i32;
    fn CGEventCreate(source: *const c_void) -> *mut c_void;
    fn CGEventGetLocation(event: *mut c_void) -> CGPoint;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGWarpMouseCursorPosition(new_cursor_position: CGPoint) -> i32;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(cf: *const c_void);
}

#[tauri::command]
pub async fn begin_capture(app: AppHandle) -> Result<(), String> {
    begin_capture_impl(app).await
}

pub async fn begin_capture_impl(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    if state.recording_selection.lock().is_some() {
        return Ok(()); // A screenshot shortcut must not replace the recording picker.
    }
    if state.long_capture_cancel.lock().is_some() {
        return Err("长截图正在进行，请先按快捷键停止".to_string());
    }

    ensure_screen_capture_permission(&app)?;
    if state
        .capture_in_progress
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(()); // Repeated shortcuts must not show the main window during a freeze.
    }
    let session_id = state.overlay_session.fetch_add(1, Ordering::AcqRel) + 1;
    let result = begin_capture_session(app.clone(), session_id, None).await;
    state.capture_in_progress.store(false, Ordering::Release);
    if result.is_err() {
        state.snapshots.lock().clear();
        hide_overlay_windows(&app);
        show_main_window(&app);
    }
    result
}

#[tauri::command]
pub async fn select_recording_region(
    app: AppHandle,
    monitor_id: u32,
    restore_main: Option<bool>,
) -> Result<Option<RecordingSelection>, String> {
    let state = app.state::<AppState>();
    ensure_screen_capture_permission(&app)?;
    if state
        .capture_in_progress
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("正在准备截图，请稍候".into());
    }
    if state.recording_selection.lock().is_some()
        || state.long_capture_cancel.lock().is_some()
        || !state.snapshots.lock().is_empty()
    {
        state.capture_in_progress.store(false, Ordering::Release);
        return Err("请先完成或取消当前框选".into());
    }
    let session_id = state.overlay_session.fetch_add(1, Ordering::AcqRel) + 1;
    let (reply, mut result) = async_runtime::channel(1);
    *state.recording_selection.lock() = Some(RecordingSelectionRequest {
        session_id,
        monitor_id,
        restore_main: restore_main.unwrap_or(true),
        reply,
    });
    let prepared = begin_capture_session(app.clone(), session_id, Some(monitor_id)).await;
    state.capture_in_progress.store(false, Ordering::Release);
    if let Err(error) = prepared {
        if state.overlay_session.load(Ordering::Acquire) == session_id {
            cancel_capture(app.clone(), state);
        }
        return Err(error);
    }
    result
        .recv()
        .await
        .ok_or_else(|| "区域框选已结束，请重新选择".into())
}

async fn begin_capture_session(
    app: AppHandle,
    session_id: u64,
    target_monitor: Option<u32>,
) -> Result<(), String> {
    let started = Instant::now();
    app.state::<AppState>().snapshots.lock().clear();
    hide_overlay_windows(&app);
    if let Some(main) = app.get_webview_window("main") {
        main.hide()
            .map_err(|error| format!("无法隐藏工具窗口：{error}"))?;
    }

    // Capture only after ordering the tool out. The shared capture path also waits
    // for the window server/cursor update before reading the desktop pixels.
    let snapshot_helper = if target_monitor.is_some() && cfg!(target_os = "macos") {
        Some(crate::studio::resource(&app, "runtime/screenshot-recorder"))
    } else {
        None
    };
    let snapshots = async_runtime::spawn_blocking(move || {
        capture_all_monitors(session_id, target_monitor, snapshot_helper)
    })
    .await
    .map_err(|error| format!("截图任务异常：{error}"))??;
    if app
        .state::<AppState>()
        .overlay_session
        .load(Ordering::Acquire)
        != session_id
    {
        return Ok(()); // A cancelled freeze must not reopen its windows later.
    }

    let window_specs: Vec<(u32, i32, i32, u32, u32, f32)> = snapshots
        .values()
        .map(|snapshot| {
            (
                snapshot.id,
                snapshot.x,
                snapshot.y,
                snapshot.width,
                snapshot.height,
                snapshot.scale_factor,
            )
        })
        .collect();
    *app.state::<AppState>().snapshots.lock() = snapshots;

    let overlay_app = app.clone();
    async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut focused = false;
        for (id, x, y, width, height, scale_factor) in window_specs {
            if overlay_app
                .state::<AppState>()
                .overlay_session
                .load(Ordering::Acquire)
                != session_id
            {
                return Ok(());
            }
            let window =
                ensure_overlay_window(&overlay_app, id, x, y, width, height, scale_factor)?;
            if overlay_app
                .state::<AppState>()
                .overlay_session
                .load(Ordering::Acquire)
                != session_id
            {
                return Ok(());
            }
            window
                .emit("overlay-refresh", ())
                .map_err(|error| error.to_string())?;
            if should_eager_show_overlay() {
                #[cfg(target_os = "macos")]
                overlay_app.show().map_err(|error| error.to_string())?;
                window.show().map_err(|error| error.to_string())?;
                if !focused {
                    window.set_focus().map_err(|error| error.to_string())?;
                    focused = true;
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("框选窗口任务异常：{error}"))??;
    eprintln!(
        "ScreenShot freeze prepared: {:.0} ms",
        started.elapsed().as_secs_f64() * 1000.0
    );
    Ok(())
}

fn ensure_overlay_window(
    app: &AppHandle,
    id: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f32,
) -> Result<WebviewWindow, String> {
    let state = app.state::<AppState>();
    let _setup = state.overlay_setup.lock();
    let label = format!("overlay-{id}");
    let window = if let Some(window) = app.get_webview_window(&label) {
        window
    } else {
        let url = WebviewUrl::App(
            format!("index.html?mode=overlay&monitorId={id}")
                .parse()
                .map_err(|error| format!("无法创建框选页面地址：{error}"))?,
        );
        let mut builder = WebviewWindowBuilder::new(app, &label, url)
            .title("ScreenShot Capture")
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .content_protected(true)
            .skip_taskbar(true)
            .visible(false);
        if cfg!(target_os = "macos") {
            builder = builder.visible_on_all_workspaces(true);
        }
        builder
            .build()
            .map_err(|error| format!("无法创建框选窗口：{error}"))?
    };
    let (position, size) = if cfg!(target_os = "macos") {
        // xcap's macOS origins are logical points; capture pixels may be Retina-sized.
        (
            Position::Logical(LogicalPosition::new(x as f64, y as f64)),
            Size::Logical(LogicalSize::new(
                width as f64 / scale.max(1.0) as f64,
                height as f64 / scale.max(1.0) as f64,
            )),
        )
    } else {
        (
            Position::Physical(PhysicalPosition::new(x, y)),
            Size::Physical(PhysicalSize::new(width, height)),
        )
    };
    window
        .set_position(position)
        .map_err(|error| format!("无法定位框选窗口：{error}"))?;
    window
        .set_size(size)
        .map_err(|error| format!("无法调整框选窗口：{error}"))?;
    Ok(window)
}

pub fn prewarm_overlay_windows(app: AppHandle) {
    async_runtime::spawn_blocking(move || {
        let Ok(monitors) = Monitor::all() else {
            return;
        };
        for monitor in monitors {
            let spec = (
                monitor.id(),
                monitor.x(),
                monitor.y(),
                monitor.width(),
                monitor.height(),
            );
            if let (Ok(id), Ok(x), Ok(y), Ok(width), Ok(height)) = spec {
                let scale = monitor.scale_factor().unwrap_or(1.0).max(1.0);
                let pixel_scale = if cfg!(target_os = "macos") {
                    scale
                } else {
                    1.0
                };
                if let Err(error) = ensure_overlay_window(
                    &app,
                    id,
                    x,
                    y,
                    (width as f32 * pixel_scale).round() as u32,
                    (height as f32 * pixel_scale).round() as u32,
                    scale,
                ) {
                    eprintln!("ScreenShot overlay prewarm: {error}");
                }
            }
        }
    });
}

#[tauri::command]
pub fn get_overlay_snapshot(
    state: State<'_, AppState>,
    monitor_id: u32,
) -> Result<OverlaySnapshot, String> {
    let recording_session = state
        .recording_selection
        .lock()
        .as_ref()
        .map(|request| request.session_id);
    let snapshots = state.snapshots.lock();
    let snapshot = snapshots
        .get(&monitor_id)
        .ok_or_else(|| "截图会话已失效，请重新截图".to_string())?;
    Ok(OverlaySnapshot {
        session_id: snapshot.session_id,
        monitor_id: snapshot.id,
        name: snapshot.name.clone(),
        width: snapshot.width,
        height: snapshot.height,
        scale_factor: snapshot.scale_factor,
        data_url: snapshot.preview_data_url.clone(),
        purpose: if recording_session == Some(snapshot.session_id) {
            "recording"
        } else {
            "screenshot"
        },
    })
}

fn recording_region(
    state: &AppState,
    region: &CaptureRegion,
) -> Result<RecordingSelection, String> {
    let requests = state.recording_selection.lock();
    let request = requests.as_ref().ok_or("录屏框选会话已失效，请重新选择")?;
    if request.session_id != region.session_id || request.monitor_id != region.monitor_id {
        return Err("录屏框选会话已失效，请重新选择".into());
    }
    let snapshots = state.snapshots.lock();
    let snapshot = snapshots
        .get(&region.monitor_id)
        .ok_or("录屏框选会话已失效，请重新选择")?;
    if snapshot.session_id != region.session_id {
        return Err("录屏框选会话已失效，请重新选择".into());
    }
    if region.width < 8 || region.height < 8 {
        return Err("录制区域至少需要 8 × 8 像素".into());
    }
    if region
        .x
        .checked_add(region.width)
        .is_none_or(|right| right > snapshot.width)
        || region
            .y
            .checked_add(region.height)
            .is_none_or(|bottom| bottom > snapshot.height)
    {
        return Err("框选区域超出显示器范围".into());
    }
    Ok(RecordingSelection {
        crop: RecordingCrop {
            x: region.x as f64 / snapshot.width as f64,
            y: region.y as f64 / snapshot.height as f64,
            width: region.width as f64 / snapshot.width as f64,
            height: region.height as f64 / snapshot.height as f64,
        },
        width: region.width,
        height: region.height,
    })
}

#[tauri::command]
pub fn finish_recording_region_selection(
    app: AppHandle,
    region: CaptureRegion,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let selection = recording_region(&state, &region)?;
    state.overlay_session.fetch_add(1, Ordering::AcqRel);
    state.snapshots.lock().clear();
    hide_overlay_windows(&app);
    if let Some(request) = state.recording_selection.lock().take() {
        restore_after_recording_selection(&app, request.restore_main);
        let _ = request.reply.try_send(Some(selection));
    }
    Ok(())
}

#[tauri::command]
pub fn show_overlay_window(app: AppHandle, monitor_id: u32, session_id: u64) -> Result<(), String> {
    let state = app.state::<AppState>();
    if state.overlay_session.load(Ordering::Acquire) != session_id
        || !state.snapshots.lock().contains_key(&monitor_id)
    {
        return Ok(()); // Ignore image-load acknowledgements from an older or cancelled capture.
    }
    let label = format!("overlay-{monitor_id}");
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "框选窗口已关闭，请重新截图".to_string())?;
    #[cfg(target_os = "macos")]
    app.show().map_err(|error| error.to_string())?;
    window
        .show()
        .map_err(|error| format!("无法显示框选窗口：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("无法聚焦框选窗口：{error}"))?;
    Ok(())
}

fn should_eager_show_overlay() -> bool {
    cfg!(target_os = "macos") && !cfg!(debug_assertions)
}

#[tauri::command]
pub async fn finish_region_capture(app: AppHandle, region: CaptureRegion) -> Result<(), String> {
    complete_region_capture(app, region, RegionDestination::Editor).await
}

#[tauri::command]
pub async fn copy_region_to_clipboard(app: AppHandle, region: CaptureRegion) -> Result<(), String> {
    complete_region_capture(app, region, RegionDestination::Clipboard).await
}

#[derive(Clone, Copy)]
enum RegionDestination {
    Editor,
    Clipboard,
}

// Retain the original snapshot on clipboard errors so the user can retry or edit.
fn copy_snapshot(
    state: &AppState,
    region: &CaptureRegion,
    copy: impl FnOnce(&RgbaImage) -> Result<(), String>,
) -> Result<(), String> {
    let image = crop_snapshot(state, region)?;
    copy(&image)?;
    state.snapshots.lock().clear();
    Ok(())
}

async fn complete_region_capture(
    app: AppHandle,
    region: CaptureRegion,
    destination: RegionDestination,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    if state.recording_selection.lock().is_some() {
        return Err("请先确认或取消录屏区域".into());
    }
    if state
        .capture_in_progress
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("正在准备截图，请稍候".to_string());
    }
    let worker_app = app.clone();
    let result = async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let app = worker_app;
        let state = app.state::<AppState>();
        match destination {
            RegionDestination::Clipboard => {
                copy_snapshot(&state, &region, crate::copy_image_to_clipboard)?;
                hide_overlay_windows(&app);
                // Ordering out the last NSWindow alone can leave ScreenShot active.
                // Hide the application as well so the previous app can receive paste.
                #[cfg(target_os = "macos")]
                let _ = app.hide();
                // Notify the hidden main window without opening the editor or encoding a PNG.
                let _ = app.emit_to("main", "capture-copied", ());
            }
            RegionDestination::Editor => {
                let image = crop_snapshot(&state, &region)?;
                state.snapshots.lock().clear();
                hide_overlay_windows(&app);
                deliver_image(&app, image, "normal")?;
            }
        }
        eprintln!(
            "ScreenShot selection completed: {:.0} ms",
            started.elapsed().as_secs_f64() * 1000.0
        );
        Ok(())
    })
    .await
    .map_err(|error| format!("区域截图任务异常：{error}"));
    state.capture_in_progress.store(false, Ordering::Release);
    let result = result.and_then(|result| result);
    if let (Err(error), RegionDestination::Editor) = (&result, destination) {
        hide_overlay_windows(&app);
        report_error(&app, error.clone());
    }
    result
}

#[tauri::command]
pub fn start_long_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    region: CaptureRegion,
) -> Result<(), String> {
    if state.recording_selection.lock().is_some() {
        return Err("请先确认或取消录屏区域".into());
    }
    if state.long_capture_cancel.lock().is_some() {
        return Err("已有长截图任务正在运行".to_string());
    }

    let first_frame = crop_snapshot(&state, &region)?;
    state.snapshots.lock().clear();
    hide_overlay_windows(&app);

    let cancel = Arc::new(AtomicBool::new(false));
    *state.long_capture_cancel.lock() = Some(cancel.clone());
    let app_for_worker = app.clone();
    async_runtime::spawn_blocking(move || {
        run_long_capture(app_for_worker, region, first_frame, cancel);
    });
    Ok(())
}

#[tauri::command]
pub fn stop_long_capture(app: AppHandle) -> bool {
    stop_long_capture_impl(&app)
}

pub fn stop_long_capture_impl(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let cancel = state.long_capture_cancel.lock().clone();
    if let Some(cancel) = cancel {
        cancel.store(true, Ordering::Release);
        true
    } else {
        false
    }
}

#[tauri::command]
pub fn is_long_capture_active(state: State<'_, AppState>) -> bool {
    state.long_capture_cancel.lock().is_some()
}

#[tauri::command]
pub fn cancel_capture(app: AppHandle, state: State<'_, AppState>) {
    state.overlay_session.fetch_add(1, Ordering::AcqRel);
    state.snapshots.lock().clear();
    hide_overlay_windows(&app);
    if let Some(request) = state.recording_selection.lock().take() {
        restore_after_recording_selection(&app, request.restore_main);
        let _ = request.reply.try_send(None);
    } else {
        show_main_window(&app);
        let _ = app.emit_to("main", "capture-cancelled", ());
    }
}

fn restore_after_recording_selection(app: &AppHandle, restore_main: bool) {
    if restore_main {
        show_main_window(app);
    } else {
        #[cfg(target_os = "macos")]
        let _ = app.hide();
    }
}

fn run_long_capture(
    app: AppHandle,
    region: CaptureRegion,
    first_frame: RgbaImage,
    cancel: Arc<AtomicBool>,
) {
    let monitor = match Monitor::all() {
        Ok(monitors) => monitors
            .into_iter()
            .find(|monitor| monitor.id().ok() == Some(region.monitor_id)),
        Err(error) => {
            clear_long_capture(&app);
            report_error(&app, format!("长截图启动失败：{error}"));
            return;
        }
    };
    let Some(monitor) = monitor else {
        clear_long_capture(&app);
        report_error(&app, "长截图启动失败：找不到目标显示器".to_string());
        return;
    };

    let mut stitcher = ScrollStitcher::new(first_frame);
    let mut failures = 0_u32;
    let _cursor_guard = hide_cursor_for_monitor(&monitor);
    emit_long_status(
        &app,
        "capturing",
        stitcher.total_height(),
        "请缓慢向下滚动，再按快捷键停止",
    );

    while !cancel.load(Ordering::Acquire) {
        thread::sleep(Duration::from_millis(240));
        let frame = match capture_live_region(&monitor, &region) {
            Ok(frame) => frame,
            Err(error) => {
                failures += 1;
                if failures >= 8 {
                    report_error(&app, format!("连续捕获屏幕失败：{error}"));
                    break;
                }
                continue;
            }
        };

        match stitcher.try_push(frame) {
            StitchOutcome::Added(_) => {
                failures = 0;
                emit_long_status(&app, "capturing", stitcher.total_height(), "已拼接新内容");
            }
            StitchOutcome::Unchanged => {}
            StitchOutcome::NoReliableMatch => {
                failures = failures.saturating_add(1).min(20);
            }
            StitchOutcome::LimitReached => {
                emit_long_status(
                    &app,
                    "limitReached",
                    stitcher.total_height(),
                    "已达到长图尺寸上限，正在生成图片",
                );
                break;
            }
        }
    }

    let output = stitcher.finish();
    clear_long_capture(&app);
    if let Err(error) = deliver_image(&app, output, "long") {
        report_error(&app, error);
    }
}

#[cfg(target_os = "macos")]
fn capture_live_region(monitor: &Monitor, region: &CaptureRegion) -> Result<RgbaImage, String> {
    let image = monitor
        .capture_image()
        .map_err(|error| screen_capture_error(format!("无法捕获屏幕：{error}")))?;
    crop_image_region(&image, region).ok_or_else(|| {
        format!(
            "框选区域超出当前屏幕范围：({}, {}, {}, {}) / {}x{}",
            region.x,
            region.y,
            region.width,
            region.height,
            image.width(),
            image.height()
        )
    })
}

#[cfg(not(target_os = "macos"))]
fn capture_live_region(monitor: &Monitor, region: &CaptureRegion) -> Result<RgbaImage, String> {
    monitor
        .capture_region(region.x, region.y, region.width, region.height)
        .map_err(|error| format!("无法捕获屏幕区域：{error}"))
}

fn capture_all_monitors(
    session_id: u64,
    target_monitor: Option<u32>,
    snapshot_helper: Option<std::path::PathBuf>,
) -> Result<HashMap<u32, MonitorSnapshot>, String> {
    let monitors = Monitor::all().map_err(|error| format!("无法读取显示器：{error}"))?;
    let monitors: Vec<_> = monitors
        .into_iter()
        .filter(|monitor| target_monitor.is_none_or(|target| monitor.id().ok() == Some(target)))
        .collect();
    let cursor_guard = hide_cursor_for_monitors(&monitors);
    let cursor_position_guard = move_cursor_to_safe_edge(&monitors);
    wait_for_cursor_hide();
    let mut snapshots = HashMap::new();
    for monitor in monitors {
        let id = monitor.id().map_err(|error| error.to_string())?;
        let image = if let Some(helper) = &snapshot_helper {
            filtered_recording_snapshot(helper, id)?
        } else {
            monitor
                .capture_image()
                .map_err(|error| screen_capture_error(format!("无法捕获显示器 {id}：{error}")))?
        };
        let scale_factor = monitor.scale_factor().unwrap_or(1.0);
        snapshots.insert(
            id,
            MonitorSnapshot {
                session_id,
                id,
                name: monitor
                    .friendly_name()
                    .or_else(|_| monitor.name())
                    .unwrap_or_else(|_| format!("显示器 {id}")),
                x: monitor.x().map_err(|error| error.to_string())?,
                y: monitor.y().map_err(|error| error.to_string())?,
                width: image.width(),
                height: image.height(),
                scale_factor,
                preview_data_url: String::new(),
                image,
            },
        );
    }
    drop(cursor_position_guard);
    drop(cursor_guard);
    for snapshot in snapshots.values_mut() {
        snapshot.preview_data_url =
            image_to_preview_data_url(&snapshot.image, snapshot.scale_factor)?;
    }
    if snapshots.is_empty() {
        Err("未找到可截图的显示器".to_string())
    } else {
        Ok(snapshots)
    }
}

fn filtered_recording_snapshot(
    helper: &std::path::Path,
    monitor_id: u32,
) -> Result<RgbaImage, String> {
    use std::process::{Command, Stdio};
    let temporary = tempfile::Builder::new()
        .suffix(".png")
        .tempfile()
        .map_err(|e| e.to_string())?;
    let mut child = Command::new(helper)
        .arg("snapshot")
        .arg(monitor_id.to_string())
        .arg(temporary.path())
        .arg(std::process::id().to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("无法准备桌面框选：{e}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) if status.success() => break,
            Some(_) => return Err("无法获取排除工具窗口的桌面画面，请检查屏幕录制权限".into()),
            None if started.elapsed() > Duration::from_secs(10) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("桌面画面获取超时，请重新框选".into());
            }
            None => thread::sleep(Duration::from_millis(15)),
        }
    }
    image::open(temporary.path())
        .map(|image| image.into_rgba8())
        .map_err(|e| e.to_string())
}

fn crop_snapshot(state: &AppState, region: &CaptureRegion) -> Result<RgbaImage, String> {
    if region.width < 2 || region.height < 2 {
        return Err("框选区域太小".to_string());
    }
    let snapshots = state.snapshots.lock();
    let snapshot = snapshots
        .get(&region.monitor_id)
        .ok_or_else(|| "截图会话已失效，请重新截图".to_string())?;
    if snapshot.session_id != region.session_id {
        return Err("截图会话已失效，请重新截图".to_string());
    }
    let right = region.x.saturating_add(region.width);
    let bottom = region.y.saturating_add(region.height);
    if right > snapshot.width || bottom > snapshot.height {
        return Err("框选区域超出显示器范围".to_string());
    }
    crop_image_region(&snapshot.image, region).ok_or_else(|| "框选区域超出显示器范围".to_string())
}

fn crop_image_region(image: &RgbaImage, region: &CaptureRegion) -> Option<RgbaImage> {
    let right = region.x.checked_add(region.width)?;
    let bottom = region.y.checked_add(region.height)?;
    if right > image.width() || bottom > image.height() {
        return None;
    }
    Some(imageops::crop_imm(image, region.x, region.y, region.width, region.height).to_image())
}

#[cfg(target_os = "macos")]
fn hide_cursor_for_monitors(monitors: &[Monitor]) -> CursorHideGuard {
    let mut display_ids = Vec::new();
    if unsafe { CGDisplayHideCursor(0) == 0 } {
        display_ids.push(0);
    }
    display_ids.extend(
        monitors
            .iter()
            .filter_map(|monitor| monitor.id().ok())
            .filter(|display_id| unsafe { CGDisplayHideCursor(*display_id) == 0 }),
    );
    CursorHideGuard { display_ids }
}

#[cfg(not(target_os = "macos"))]
fn hide_cursor_for_monitors(_monitors: &[Monitor]) -> CursorHideGuard {
    CursorHideGuard {}
}

fn hide_cursor_for_monitor(monitor: &Monitor) -> CursorHideGuard {
    #[cfg(target_os = "macos")]
    {
        let mut display_ids = Vec::new();
        if unsafe { CGDisplayHideCursor(0) == 0 } {
            display_ids.push(0);
        }
        display_ids.extend(
            monitor
                .id()
                .ok()
                .filter(|display_id| unsafe { CGDisplayHideCursor(*display_id) == 0 }),
        );
        CursorHideGuard { display_ids }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = monitor;
        CursorHideGuard {}
    }
}

#[cfg(target_os = "macos")]
fn move_cursor_to_safe_edge(monitors: &[Monitor]) -> CursorPositionGuard {
    let original = current_cursor_position();
    if let Some(target) = safe_edge_position(monitors) {
        unsafe {
            let _ = CGWarpMouseCursorPosition(target);
        }
    }
    CursorPositionGuard { original }
}

#[cfg(not(target_os = "macos"))]
fn move_cursor_to_safe_edge(_monitors: &[Monitor]) -> CursorPositionGuard {
    CursorPositionGuard {}
}

#[cfg(target_os = "macos")]
fn current_cursor_position() -> Option<CGPoint> {
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return None;
        }
        let position = CGEventGetLocation(event);
        CFRelease(event.cast());
        Some(position)
    }
}

#[cfg(target_os = "macos")]
fn safe_edge_position(monitors: &[Monitor]) -> Option<CGPoint> {
    monitors
        .iter()
        .filter_map(|monitor| {
            let x = monitor.x().ok()? as f64;
            let y = monitor.y().ok()? as f64;
            let width = monitor.width().ok()? as f64;
            let height = monitor.height().ok()? as f64;
            Some(CGPoint {
                x: x + width - 2.0,
                y: y + height - 2.0,
            })
        })
        .max_by(|a, b| (a.x + a.y).total_cmp(&(b.x + b.y)))
}

#[cfg(target_os = "macos")]
fn wait_for_cursor_hide() {
    thread::sleep(CURSOR_HIDE_SETTLE);
}

fn deliver_image(app: &AppHandle, image: RgbaImage, capture_kind: &str) -> Result<(), String> {
    let width = image.width();
    let height = image.height();
    let data_url = image_to_data_url(&image)?;
    let capture_id = app.state::<AppState>().images.store(image);
    let payload = CapturePayload {
        capture_id,
        width,
        height,
        data_url,
        capture_kind: capture_kind.to_string(),
    };
    show_main_window(app);
    app.emit_to("main", "capture-ready", payload)
        .map_err(|error| format!("无法打开标注预览：{error}"))
}

pub(crate) fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

#[cfg(target_os = "macos")]
pub fn request_screen_capture_permission_at_launch(app: AppHandle) {
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(800));
        let app_for_main_thread = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = request_screen_capture_permission_if_needed(&app_for_main_thread);
        });
    });
}

#[cfg(not(target_os = "macos"))]
pub fn request_screen_capture_permission_at_launch(_app: AppHandle) {}

#[cfg(target_os = "macos")]
fn ensure_screen_capture_permission(app: &AppHandle) -> Result<(), String> {
    if request_screen_capture_permission_if_needed(app) {
        Ok(())
    } else {
        Err(
            "需要先给 ScreenShot 开启屏幕录制权限：系统设置 > 隐私与安全性 > 录屏与系统录音。授权后请退出并重新打开 ScreenShot，再重新截图。"
                .to_string(),
        )
    }
}

#[cfg(not(target_os = "macos"))]
fn ensure_screen_capture_permission(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn request_screen_capture_permission_if_needed(app: &AppHandle) -> bool {
    if unsafe { CGPreflightScreenCaptureAccess() } {
        return true;
    }

    show_main_window(app);
    let _ = unsafe { CGRequestScreenCaptureAccess() };
    unsafe { CGPreflightScreenCaptureAccess() }
}

#[cfg(target_os = "macos")]
fn screen_capture_error(message: String) -> String {
    if unsafe { CGPreflightScreenCaptureAccess() } {
        message
    } else {
        format!(
            "macOS 仍报告当前 ScreenShot 没有屏幕录制权限。请在系统设置里删除 ScreenShot.app 后重新添加，或重新安装后再授权。原始错误：{message}"
        )
    }
}

#[cfg(not(target_os = "macos"))]
fn screen_capture_error(message: String) -> String {
    message
}

fn hide_overlay_windows(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("overlay-") {
            let _ = window.hide();
            let _ = window.emit("overlay-reset", ());
        }
    }
}

fn clear_long_capture(app: &AppHandle) {
    app.state::<AppState>().long_capture_cancel.lock().take();
}

fn emit_long_status(app: &AppHandle, status: &str, total_height: u32, message: &str) {
    let _ = app.emit_to(
        "main",
        "long-capture-status",
        LongCaptureStatus {
            status: status.to_string(),
            total_height,
            message: message.to_string(),
        },
    );
}

pub fn report_error(app: &AppHandle, message: String) {
    show_main_window(app);
    let _ = app.emit_to("main", "app-error", message);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture_fixture() -> (AppState, CaptureRegion) {
        let state = AppState::default();
        let image = RgbaImage::from_fn(12, 10, |x, y| image::Rgba([x as u8, y as u8, 42, 255]));
        state.snapshots.lock().insert(
            1,
            MonitorSnapshot {
                session_id: 7,
                id: 1,
                name: "Test".into(),
                x: -100,
                y: 0,
                width: 12,
                height: 10,
                scale_factor: 2.0,
                preview_data_url: String::new(),
                image,
            },
        );
        let region = CaptureRegion {
            session_id: 7,
            monitor_id: 1,
            x: 3,
            y: 4,
            width: 5,
            height: 3,
        };
        (state, region)
    }

    #[test]
    fn crops_original_pixels_and_rejects_stale_overlay_sessions() {
        let (state, mut region) = capture_fixture();
        let cropped = crop_snapshot(&state, &region).unwrap();
        assert_eq!(cropped.dimensions(), (5, 3));
        assert_eq!(*cropped.get_pixel(0, 0), image::Rgba([3, 4, 42, 255]));
        assert_eq!(*cropped.get_pixel(4, 2), image::Rgba([7, 6, 42, 255]));
        region.session_id = 6;
        assert!(crop_snapshot(&state, &region).is_err());
        region.session_id = 7;
        region.x = u32::MAX;
        assert!(crop_snapshot(&state, &region).is_err());
    }

    #[test]
    fn quick_copy_preserves_selection_on_failure_and_can_retry_original_pixels() {
        let (state, region) = capture_fixture();
        let error = copy_snapshot(&state, &region, |_| Err("剪贴板暂时不可用".into()));
        assert_eq!(error.unwrap_err(), "剪贴板暂时不可用");
        assert_eq!(state.snapshots.lock().len(), 1);

        copy_snapshot(&state, &region, |image| {
            assert_eq!(image.dimensions(), (5, 3));
            assert_eq!(*image.get_pixel(0, 0), image::Rgba([3, 4, 42, 255]));
            assert_eq!(*image.get_pixel(4, 2), image::Rgba([7, 6, 42, 255]));
            Ok(())
        })
        .unwrap();
        assert!(state.snapshots.lock().is_empty());
        assert!(copy_snapshot(&state, &region, |_| panic!("不可重复复制已完成的选区")).is_err());
    }

    #[test]
    fn stale_quick_copy_never_writes_the_clipboard_or_discards_the_current_session() {
        let (state, mut region) = capture_fixture();
        region.session_id -= 1;
        assert!(copy_snapshot(&state, &region, |_| panic!("不可复制过期选区")).is_err());
        assert_eq!(state.snapshots.lock().len(), 1);
    }

    #[test]
    fn recording_selection_normalizes_physical_pixels_without_consuming_the_snapshot() {
        let (state, mut region) = capture_fixture();
        let (reply, _result) = async_runtime::channel(1);
        *state.recording_selection.lock() = Some(RecordingSelectionRequest {
            session_id: 7,
            monitor_id: 1,
            restore_main: true,
            reply,
        });
        region.x = 2;
        region.y = 1;
        region.width = 10;
        region.height = 8;
        let selected = recording_region(&state, &region).unwrap();
        assert_eq!((selected.width, selected.height), (10, 8));
        assert_eq!(selected.crop.x, 2.0 / 12.0);
        assert_eq!(selected.crop.y, 0.1);
        assert_eq!(selected.crop.width, 10.0 / 12.0);
        assert_eq!(selected.crop.height, 0.8);
        assert_eq!(state.snapshots.lock().len(), 1);

        region.session_id = 6;
        assert!(recording_region(&state, &region).is_err());
        region.session_id = 7;
        region.monitor_id = 2;
        assert!(recording_region(&state, &region).is_err());
        region.monitor_id = 1;
        region.width = 7;
        assert!(recording_region(&state, &region).is_err());
        region.width = 11;
        assert!(recording_region(&state, &region).is_err());
        region.x = u32::MAX;
        assert!(recording_region(&state, &region).is_err());
        state.recording_selection.lock().take();
        assert!(recording_region(&state, &region).is_err());
        assert_eq!(state.snapshots.lock().len(), 1);
    }
}
