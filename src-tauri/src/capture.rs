use std::{
    collections::HashMap,
    ffi::c_void,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use image::{imageops, RgbaImage};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{
    async_runtime, AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size,
    State, WebviewUrl, WebviewWindowBuilder,
};
use xcap::Monitor;

use crate::{
    image_utils::{image_to_data_url, image_to_preview_data_url},
    stitch::{ScrollStitcher, StitchOutcome},
};

const CURSOR_HIDE_SETTLE: Duration = Duration::from_millis(250);

#[derive(Default)]
pub struct AppState {
    snapshots: Mutex<HashMap<u32, MonitorSnapshot>>,
    long_capture_cancel: Mutex<Option<Arc<AtomicBool>>>,
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
    monitor_id: u32,
    name: String,
    width: u32,
    height: u32,
    scale_factor: f32,
    data_url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapturePayload {
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
    if app.state::<AppState>().long_capture_cancel.lock().is_some() {
        return Err("长截图正在进行，请先按快捷键停止".to_string());
    }

    close_overlay_windows(&app);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }

    let snapshots = async_runtime::spawn_blocking(capture_all_monitors)
        .await
        .map_err(|error| format!("截图任务异常：{error}"))??;

    let window_specs: Vec<(u32, i32, i32, u32, u32)> = snapshots
        .values()
        .map(|snapshot| {
            (
                snapshot.id,
                snapshot.x,
                snapshot.y,
                snapshot.width,
                snapshot.height,
            )
        })
        .collect();
    *app.state::<AppState>().snapshots.lock() = snapshots;

    for (id, x, y, width, height) in window_specs {
        let label = format!("overlay-{id}");
        let url = WebviewUrl::App(
            format!("index.html?mode=overlay&monitorId={id}")
                .parse()
                .map_err(|error| format!("无法创建框选页面地址：{error}"))?,
        );
        let window = WebviewWindowBuilder::new(&app, &label, url)
            .title("ScreenShot Capture")
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .build()
            .map_err(|error| format!("无法创建框选窗口：{error}"))?;
        window
            .set_position(Position::Physical(PhysicalPosition::new(x, y)))
            .map_err(|error| format!("无法定位框选窗口：{error}"))?;
        window
            .set_size(Size::Physical(PhysicalSize::new(width, height)))
            .map_err(|error| format!("无法调整框选窗口：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_overlay_snapshot(
    state: State<'_, AppState>,
    monitor_id: u32,
) -> Result<OverlaySnapshot, String> {
    let snapshots = state.snapshots.lock();
    let snapshot = snapshots
        .get(&monitor_id)
        .ok_or_else(|| "截图会话已失效，请重新截图".to_string())?;
    Ok(OverlaySnapshot {
        monitor_id: snapshot.id,
        name: snapshot.name.clone(),
        width: snapshot.width,
        height: snapshot.height,
        scale_factor: snapshot.scale_factor,
        data_url: snapshot.preview_data_url.clone(),
    })
}

#[tauri::command]
pub fn show_overlay_window(app: AppHandle, monitor_id: u32) -> Result<(), String> {
    let label = format!("overlay-{monitor_id}");
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "框选窗口已关闭，请重新截图".to_string())?;
    window
        .show()
        .map_err(|error| format!("无法显示框选窗口：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("无法聚焦框选窗口：{error}"))?;
    Ok(())
}

#[tauri::command]
pub fn finish_region_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    region: CaptureRegion,
) -> Result<(), String> {
    let image = crop_snapshot(&state, &region)?;
    state.snapshots.lock().clear();
    deliver_image(&app, image, "normal")?;
    close_overlay_windows(&app);
    Ok(())
}

#[tauri::command]
pub fn start_long_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    region: CaptureRegion,
) -> Result<(), String> {
    if state.long_capture_cancel.lock().is_some() {
        return Err("已有长截图任务正在运行".to_string());
    }

    let first_frame = crop_snapshot(&state, &region)?;
    state.snapshots.lock().clear();
    close_overlay_windows(&app);

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
    state.snapshots.lock().clear();
    close_overlay_windows(&app);
    show_main_window(&app);
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
        .map_err(|error| format!("无法捕获屏幕：{error}"))?;
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

fn capture_all_monitors() -> Result<HashMap<u32, MonitorSnapshot>, String> {
    let monitors = Monitor::all().map_err(|error| format!("无法读取显示器：{error}"))?;
    let _cursor_guard = hide_cursor_for_monitors(&monitors);
    let _cursor_position_guard = move_cursor_to_safe_edge(&monitors);
    wait_for_cursor_hide();
    let mut snapshots = HashMap::new();
    for monitor in monitors {
        let id = monitor.id().map_err(|error| error.to_string())?;
        let image = monitor
            .capture_image()
            .map_err(|error| format!("无法捕获显示器 {id}：{error}"))?;
        let scale_factor = monitor.scale_factor().unwrap_or(1.0);
        let preview_data_url = image_to_preview_data_url(&image, scale_factor)?;
        snapshots.insert(
            id,
            MonitorSnapshot {
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
                preview_data_url,
                image,
            },
        );
    }
    if snapshots.is_empty() {
        Err("未找到可截图的显示器".to_string())
    } else {
        Ok(snapshots)
    }
}

fn crop_snapshot(state: &AppState, region: &CaptureRegion) -> Result<RgbaImage, String> {
    if region.width < 2 || region.height < 2 {
        return Err("框选区域太小".to_string());
    }
    let snapshots = state.snapshots.lock();
    let snapshot = snapshots
        .get(&region.monitor_id)
        .ok_or_else(|| "截图会话已失效，请重新截图".to_string())?;
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
    let payload = CapturePayload {
        width: image.width(),
        height: image.height(),
        data_url: image_to_data_url(&image)?,
        capture_kind: capture_kind.to_string(),
    };
    show_main_window(app);
    app.emit_to("main", "capture-ready", payload)
        .map_err(|error| format!("无法打开标注预览：{error}"))
}

fn show_main_window(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

fn close_overlay_windows(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("overlay-") {
            let _ = window.close();
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
