mod annotate;
mod capture;
mod capture_cache;
mod image_utils;
mod recording;
mod stitch;
mod studio;

use std::{
    borrow::Cow,
    fs,
    io::{BufWriter, Write},
    time::Instant,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use capture::{begin_capture_impl, stop_long_capture_impl, AppState};
use recording::RecordingManager;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+X";
const STOP_RECORDING_SHORTCUT: &str = "CommandOrControl+Alt+Shift+R";

fn copy_image_to_clipboard(image: &image::RgbaImage) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("无法访问系统剪贴板：{error}"))?;
    clipboard
        .set_image(arboard::ImageData {
            width: image.width() as usize,
            height: image.height() as usize,
            bytes: Cow::Borrowed(image.as_raw()),
        })
        .map_err(|error| format!("写入剪贴板失败：{error}"))
}

#[tauri::command]
async fn copy_capture_to_clipboard(
    app: tauri::AppHandle,
    capture_id: u64,
    annotations: Vec<annotate::Annotation>,
) -> Result<(), String> {
    let source = app.state::<AppState>().images.get(capture_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let image = annotate::render_image(&source, annotations)?;
        copy_image_to_clipboard(&image)?;
        eprintln!(
            "ScreenShot copy: {:.0} ms",
            started.elapsed().as_secs_f64() * 1000.0
        );
        Ok(())
    })
    .await
    .map_err(|error| format!("复制任务异常：{error}"))?
}

#[tauri::command]
async fn save_capture(
    app: tauri::AppHandle,
    capture_id: u64,
    path: String,
    annotations: Vec<annotate::Annotation>,
) -> Result<(), String> {
    let source = app.state::<AppState>().images.get(capture_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let image = annotate::render_image(&source, annotations)?;
        let file = fs::File::create(path).map_err(|error| format!("保存图片失败：{error}"))?;
        let mut writer = BufWriter::new(file);
        image_utils::write_png(&image, &mut writer)?;
        writer
            .flush()
            .map_err(|error| format!("保存图片失败：{error}"))
    })
    .await
    .map_err(|error| format!("保存任务异常：{error}"))?
}

#[tauri::command]
fn release_capture(app: tauri::AppHandle, capture_id: u64) {
    app.state::<AppState>().images.release(capture_id);
}

#[tauri::command]
fn save_png(path: String, data_url: String) -> Result<(), String> {
    let encoded = data_url
        .split_once(',')
        .map(|(_, value)| value)
        .ok_or_else(|| "无效的图片数据".to_string())?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|error| format!("无法解码图片：{error}"))?;
    fs::write(path, bytes).map_err(|error| format!("保存图片失败：{error}"))
}

#[tauri::command]
fn copy_png_to_clipboard(data_url: String) -> Result<(), String> {
    let image = image_utils::data_url_to_image(&data_url)?;
    let (width, height) = image.dimensions();
    let bytes = image.into_raw();
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("无法访问系统剪贴板：{error}"))?;
    clipboard
        .set_image(arboard::ImageData {
            width: width as usize,
            height: height as usize,
            bytes: Cow::Owned(bytes),
        })
        .map_err(|error| format!("写入剪贴板失败：{error}"))
}

#[tauri::command]
fn default_shortcut() -> &'static str {
    DEFAULT_SHORTCUT
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shortcut_plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_shortcut(DEFAULT_SHORTCUT)
        .expect("invalid default shortcut")
        .with_handler(|app, shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            let stop: tauri_plugin_global_shortcut::Shortcut = STOP_RECORDING_SHORTCUT
                .parse()
                .expect("invalid recording shortcut");
            if shortcut == &stop {
                let _ = app.state::<RecordingManager>().control("stop");
                return;
            }

            if stop_long_capture_impl(app) {
                return;
            }

            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = begin_capture_impl(app.clone()).await {
                    capture::report_error(&app, error);
                }
            });
        })
        .build();

    tauri::Builder::default()
        .manage(AppState::default())
        .manage(RecordingManager::default())
        .manage(studio::StudioState::default())
        .plugin(shortcut_plugin)
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_content_protected(true)?;
            }
            studio::restore_layouts(app.handle());
            let recording_shortcut = app
                .global_shortcut()
                .register(STOP_RECORDING_SHORTCUT)
                .is_ok();
            app.state::<RecordingManager>()
                .stop_shortcut_available
                .store(recording_shortcut, std::sync::atomic::Ordering::Release);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("ScreenShot");
                let window_for_close = window.clone();
                let app_for_close = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        studio::remember_layout(&app_for_close);
                        api.prevent_close();
                        let _ = window_for_close.hide();
                    }
                });
            }

            let capture_item = MenuItem::with_id(app, "capture", "开始截图", true, None::<&str>)?;
            let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let stop_item = MenuItem::with_id(app, "stop", "停止长截图", true, None::<&str>)?;
            let stop_recording_item =
                MenuItem::with_id(app, "stop-recording", "停止录屏并保存", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &capture_item,
                    &stop_item,
                    &stop_recording_item,
                    &show_item,
                    &quit_item,
                ],
            )?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("ScreenShot · Ctrl/Cmd + Shift + X")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "capture" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(error) = begin_capture_impl(app.clone()).await {
                                capture::report_error(&app, error);
                            }
                        });
                    }
                    "stop" => {
                        stop_long_capture_impl(app);
                    }
                    "stop-recording" => {
                        let _ = app.state::<RecordingManager>().control("stop");
                    }
                    "show" => {
                        capture::show_main_window(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                        capture::show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.build(app)?;
            capture::prewarm_overlay_windows(app.handle().clone());
            capture::request_screen_capture_permission_at_launch(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture::begin_capture,
            capture::get_overlay_snapshot,
            capture::show_overlay_window,
            capture::select_recording_region,
            capture::finish_recording_region_selection,
            capture::finish_region_capture,
            capture::copy_region_to_clipboard,
            capture::start_long_capture,
            capture::stop_long_capture,
            capture::cancel_capture,
            capture::is_long_capture_active,
            annotate::render_annotations,
            save_png,
            copy_png_to_clipboard,
            copy_capture_to_clipboard,
            save_capture,
            release_capture,
            default_shortcut,
            recording::get_recording_status,
            recording::get_recording_browsers,
            recording::start_recording_session,
            recording::recording_control,
            recording::reopen_recording_browser,
            recording::reveal_recording,
            recording::native_recording_available,
            recording::native_capture_sources,
            recording::native_source_preview,
            recording::start_native_recording,
            studio::studio_call,
            studio::studio_reveal,
            studio::switch_workspace,
            studio::toggle_studio_fullscreen,
        ])
        .build(tauri::generate_context!())
        .expect("error while building ScreenShot")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                studio::remember_layout(app);
                let manager = app.state::<RecordingManager>();
                if manager.is_active() {
                    api.prevent_exit();
                    manager
                        .quit_when_finished
                        .store(true, std::sync::atomic::Ordering::Release);
                    let _ = manager.control("stop");
                }
            }
        });
}
