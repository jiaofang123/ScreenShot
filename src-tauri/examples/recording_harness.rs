//! Local recording integration harness. Does not capture a screen or launch a browser.
use std::{
    io::{self, BufRead},
    path::PathBuf,
    sync::Arc,
};

#[path = "../src/recording.rs"]
#[allow(dead_code)]
mod recording;
#[path = "../src/studio.rs"]
#[allow(dead_code)]
mod studio;
mod capture {
    pub fn show_main_window(_: &tauri::AppHandle) {}
    pub async fn select_recording_region(
        _: tauri::AppHandle,
        _: u32,
        _: Option<bool>,
    ) -> Result<Option<serde_json::Value>, String> {
        Err("Synthetic test does not capture the desktop".into())
    }
}
#[path = "../src/image_utils.rs"]
#[allow(dead_code)]
mod image_utils;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = PathBuf::from(args.next().expect("output video path"));
    let options: recording::RecordingOptions =
        serde_json::from_str(&args.next().expect("options JSON")).unwrap();
    let manager = recording::RecordingManager::default();
    let prepared = manager
        .prepare(options, path, "integration test".into(), Arc::new(|_| {}))
        .unwrap();
    println!(
        "{}",
        serde_json::json!({"url":prepared.url,"status":prepared.status})
    );
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if line == "quit" {
            break;
        }
        let result = if line == "status" {
            Ok(())
        } else {
            manager.control(&line)
        };
        println!(
            "{}",
            serde_json::json!({"command":line,"ok":result.is_ok(),"status":manager.status()})
        );
    }
}
