# Windows 兼容性检查

检查日期：2026-10-22。结论：通用功能保留 Windows 代码路径，当前整合版本尚不能认定为两端全部功能等效、全部通过 Windows 验收。

| 功能 | Windows 代码情况 | 本次验证与边界 |
| --- | --- | --- |
| 截图、四角调整、直接复制、文字标注、长截图 | 使用 xcap、Rust 图像处理及 Tauri 接口；macOS 特殊处理有条件编译隔离 | 已检查平台分支；仍需 Windows 真机验证权限、快捷键、剪贴板及多屏 DPI |
| 视频制作、文字稿删除、语音覆盖生成、项目保存恢复 | 共用前端及 Node Worker；本机配音有 Windows System.Speech 分支 | 实际媒体回归在 Mac 执行；Windows 需要可用的系统语音及对应语言包 |
| 视频文字、时间范围、合并预览和比例修复 | 共用 FFmpeg 处理，Windows 包使用 ffmpeg.exe | 修正合并清单路径分隔符、Windows 系统字体目录及 Rust FFmpeg 文件名；尚需 Windows 编码及中文字体真机验证 |
| 顶部折叠、列表拖拽、固定编号、分割线、文字卡片浮层 | 共用 DOM、CSS、Pointer Events、ResizeObserver、localStorage | Chromium/WebKit 验证交互；未代替 Windows WebView2 的实际运行 |
| 窗口、桌面、区域、标签页录屏、2K、继续录制 | Windows 使用 Chrome/Edge 浏览器兼容录屏；有 Windows 浏览器发现及启动分支 | 需浏览器授权；共享声音受浏览器和所选来源限制。窗口/屏幕通过系统共享面板选择，区域在共享预览中框选 |
| 原生鼠标、点击效果和麦克风选项 | 开关目前接入 macOS 原生录制 | Windows 浏览器录屏没有同等的可控指针、点击效果和麦克风录入功能；不能声称已适配 |
| 排除 ScreenShot 和录屏控制窗口 | Windows 为 Tauri 工具及截图窗口设置内容保护；浏览器录制排除控制标签页 | Windows 整屏录制不能获得 macOS 按应用/窗口过滤的同等保证，独立 Chrome/Edge 控制窗口也没有相同的原生排除实现 |
| 程序坞重新唤起 | 属于 macOS Reopen 事件 | Windows 使用任务栏/托盘入口，需实机验证最小化、隐藏和恢复 |
| 安装包 | 有 NSIS 打包配置、Windows Node/FFmpeg 运行时准备分支 | 当前整合版尚未在 Windows 重新构建和安装验收；Mac 的 .app 不能用于 Windows |

## 本次编译检查

已安装 `x86_64-pc-windows-msvc` Rust 目标并执行 `cargo check --locked --lib --target x86_64-pc-windows-msvc`。Windows 依赖检查推进到本项目构建脚本时，因当前 Mac 缺少 Windows 资源编译器 `llvm-rc` 而停止；因此不计为 Windows 编译通过，也未产生 Windows 安装包。

本次改动仅修正可明确判断的跨平台路径及说明，不把平台缺失的录屏能力当作已经实现。

## Windows 后续验收入口

在 Windows 安装 Node、Rust MSVC 工具链、Visual Studio C++ Build Tools 和 Windows SDK 后，在 Windows 本机执行（不要复用 Mac 的 node_modules 或 resources/runtime）：

```powershell
npm ci
npm ci --prefix src-tauri/studio --omit=dev
npm run media:prepare
npm run build
cd src-tauri
cargo test --locked --lib
cd ..
npm run tauri build -- --bundles nsis
```

安装 NSIS 产物后，验收截图与中文标注、快捷键、125%/150%/混合 DPI、多屏、四种录屏来源、系统声音、2K、连续录制、导入录屏、中文配音、文字浮层、固定编号、比例合并及项目重开。Windows 专用录屏过滤与点击效果需要补充对应实现及实机验证，以上构建命令本身不会补齐这些功能。
