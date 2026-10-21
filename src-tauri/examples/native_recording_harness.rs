//! Explicit opt-in macOS hardware test. Runs the production manager and native
//! capture helper with a hidden Tauri window and the real browser controller.
use std::{
    io::{self, BufRead},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::Manager;

#[path = "../src/image_utils.rs"]
#[allow(dead_code)]
mod image_utils;
#[path = "../src/recording.rs"]
#[allow(dead_code)]
mod recording;
#[path = "../src/studio.rs"]
#[allow(dead_code)]
mod studio;
mod capture {
    pub fn show_main_window(_: &tauri::AppHandle) {}
    // The live test supplies a known rectangle inside its own fixture window.
    // Overlay pointer handling is exercised by recording-region.ui.mjs.
    pub async fn select_recording_region(
        _: tauri::AppHandle,
        _: u32,
        _: Option<bool>,
    ) -> Result<Option<serde_json::Value>, String> {
        Ok(Some(
            serde_json::json!({"crop":{"x":0.15,"y":0.2,"width":0.6,"height":0.6},"width":1075,"height":672}),
        ))
    }
}

fn main() {
    assert_eq!(
        std::env::var("SCREENSHOT_REAL_CAPTURE").as_deref(),
        Ok("1"),
        "Set SCREENSHOT_REAL_CAPTURE=1 to run the real screen test"
    );
    let destination = PathBuf::from(std::env::args().nth(1).expect("output path"));
    let mut context = tauri::generate_context!();
    for window in &mut context.config_mut().app.windows {
        window.visible = false;
    }
    tauri::Builder::default()
        .manage(recording::RecordingManager::default())
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(app,"native-qa-exclusion",tauri::WebviewUrl::External("about:blank".parse().unwrap()))
                .initialization_script("document.addEventListener('DOMContentLoaded',()=>{document.documentElement.style.background='#ff0055';});").title("ScreenShot QA Exclusion").inner_size(300.0,260.0).position(400.0,400.0)
                .decorations(false).always_on_top(true).skip_taskbar(true).focused(false).build()?;
            let app = app.handle().clone();
            std::thread::spawn(move || {
                let manager = app.state::<recording::RecordingManager>();
                let prepared = manager
                    .prepare_with_app(
                        recording::RecordingOptions {
                            mode: recording::RecordingMode::Window,
                            fps: 30,
                            audio: true,
                            original_resolution: false,
                            browser: Some("chrome".into()),
                        },
                        destination,
                        "Hardware integration".into(),
                        Arc::new(|_| {}),
                        Some(app.clone()),
                    )
                    .unwrap();
                println!(
                    "{}",
                    serde_json::json!({"url":prepared.url,"status":prepared.status})
                );
                for line in io::stdin().lock().lines().map_while(Result::ok) {
                    if line == "quit" {
                        break;
                    }
                    let result = if line.starts_with('{') {
                        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
                        if let Some(destination) = value.get("destination") {
                            recording::default_recording_path(app.clone(), destination["projectRoot"].as_str().map(str::to_owned), destination["date"].as_str().unwrap().into())
                                .map(|path| serde_json::json!({"path":path}))
                        } else if value["prepare"] == true {
                            manager.prepare_with_app(
                                serde_json::from_value(value["options"].clone()).unwrap(),
                                PathBuf::from(value["path"].as_str().unwrap()),
                                "Hardware integration".into(), Arc::new(|_| {}), Some(app.clone()),
                            ).map(|value| serde_json::json!({"url":value.url,"status":value.status}))
                        } else { manager
                            .start_native(
                                app.clone(),
                                serde_json::from_value(value["options"].clone()).unwrap(),
                                value["source"].clone(),
                                PathBuf::from(value["path"].as_str().unwrap()),
                            )
                            .map(|status| serde_json::json!(status)) }
                    } else {
                        manager
                            .control(&line)
                            .map(|_| serde_json::json!(manager.status()))
                    };
                    println!(
                        "{}",
                        match result {
                            Ok(status) => serde_json::json!({"ok":true,"status":status}),
                            Err(error) => serde_json::json!({"ok":false,"error":error}),
                        }
                    );
                }
                let _ = manager.control("stop");
                let since = Instant::now();
                while manager.is_active() && since.elapsed() < Duration::from_secs(15) {
                    std::thread::sleep(Duration::from_millis(50));
                }
                app.exit(0);
            });
            Ok(())
        })
        .run(context)
        .expect("native capture test application");
}
