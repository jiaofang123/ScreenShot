import { invoke } from "@tauri-apps/api/core";

export function recordingDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function recordingPath(projectRoot?: string) {
  return invoke<string>("default_recording_path", { projectRoot: projectRoot || null, date: recordingDate() });
}
