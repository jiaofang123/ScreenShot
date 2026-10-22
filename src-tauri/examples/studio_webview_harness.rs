//! Runs the actual embedded macOS editor/IPC against an owned test project.
use std::path::PathBuf;
#[path = "../src/studio.rs"]
#[allow(dead_code)]
mod studio;

struct ResultFile(PathBuf);
#[tauri::command]
fn qa_done(app: tauri::AppHandle, state: tauri::State<'_, ResultFile>, result: serde_json::Value) {
    std::fs::write(&state.0, serde_json::to_vec_pretty(&result).unwrap()).unwrap();
    app.exit(if result["ok"] == true { 0 } else { 1 });
}
#[tauri::command]
fn default_shortcut() -> &'static str {
    "CommandOrControl+Shift+X"
}
#[tauri::command]
fn native_recording_available() -> bool {
    false
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let driver = std::fs::read_to_string(&args[1]).expect("QA script");
    let output = PathBuf::from(&args[2]);
    let project = &args[3];
    let script = format!(
        "window.__STUDIO_QA = {};\n{}",
        serde_json::json!({"projectRoot":project}),
        driver
    );
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = format!("com.screenshot.qa.studio.{}", std::process::id());
    let timeout_path = output.clone();
    tauri::Builder::default()
        .manage(studio::StudioState::default())
        .manage(ResultFile(output.clone()))
        .invoke_handler(tauri::generate_handler![
            studio::studio_call,
            qa_done,
            default_shortcut,
            native_recording_available,
            studio::switch_workspace
        ])
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("ScreenShot Studio QA")
            .inner_size(1440.0, 940.0)
            .data_directory(output.parent().unwrap().join("webview-data"))
                .incognito(true)
            .initialization_script(&script)
                .on_page_load(|_, payload| { eprintln!("QA page: {}", payload.url()); })
                .visible(true)
                .focused(false)
                .skip_taskbar(true)
            .build()?;
            let app = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(45));
                if !timeout_path.exists() {
                    let _ = std::fs::write(
                        timeout_path,
                        r#"{"ok":false,"error":"Native editor test timed out"}"#,
                    );
                    app.exit(1);
                }
            });
            Ok(())
        })
        .run(context)
        .expect("embedded studio QA");
}
