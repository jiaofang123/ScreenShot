mod annotate;
mod capture;
mod image_utils;
mod stitch;

use std::{borrow::Cow, fs};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use capture::{begin_capture_impl, stop_long_capture_impl, AppState};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::ShortcutState;

const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+X";

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
        .with_handler(|app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
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
        .plugin(shortcut_plugin)
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("ScreenShot");
                let window_for_close = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_for_close.hide();
                    }
                });
            }

            let capture_item = MenuItem::with_id(app, "capture", "开始截图", true, None::<&str>)?;
            let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let stop_item = MenuItem::with_id(app, "stop", "停止长截图", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&capture_item, &stop_item, &show_item, &quit_item])?;
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
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.build(app)?;
            capture::request_screen_capture_permission_at_launch(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture::begin_capture,
            capture::get_overlay_snapshot,
            capture::show_overlay_window,
            capture::finish_region_capture,
            capture::start_long_capture,
            capture::stop_long_capture,
            capture::cancel_capture,
            capture::is_long_capture_active,
            annotate::render_annotations,
            save_png,
            copy_png_to_clipboard,
            default_shortcut,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ScreenShot");
}
