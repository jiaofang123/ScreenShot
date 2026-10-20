# 视频制作模块来源与运行依赖

视频制作工作区移植自同一作者的 [Video-Narration-Studio](https://github.com/jiaofang123/Video-Narration-Studio)，来源提交 `41f55c870f0d79b4cf1ac6e250ef14885fdbf1bd`。保留其素材、文字稿、语音、文字叠加、合成、合并、项目打包结构，以及重新生成覆盖原语音和合成结果的行为。Electron 窗口、IPC 和录屏接口已改接 ScreenShot。

- `public/studio/`：原编辑器界面、交互及 ScreenShot 深色主题适配。
- `src-tauri/studio/worker.mjs`：提取的文件、语音与 FFmpeg 任务，通过标准输入输出和 Tauri 通信；按需启动。
- `src-tauri/native/Recorder.swift`：新增 macOS ScreenCaptureKit / AVFoundation 录屏组件。

媒体运行时在打包时准备，用户无需安装 Node、FFmpeg 或 Swift。当前依赖包括 Node.js（含其第三方许可证）、`@andresaya/edge-tts`（GPL-3.0-only）、`ffmpeg-static`（依赖包许可证及所分发 FFmpeg 二进制对应许可证）。完整依赖版本在 `src-tauri/studio/pnpm-lock.yaml` 中，依赖自带的许可证随运行时保留。

Edge TTS 使用在线服务，文字稿会发往语音服务；视频合成在本机执行。本机语音选项不调用在线服务。
