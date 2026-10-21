use tauri::{AppHandle, Manager};

// Used for tray commands and macOS applicationShouldHandleReopen (Dock clicks).
pub(crate) fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}
