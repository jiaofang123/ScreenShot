# ScreenShot

一个本地优先的 Windows / macOS 桌面截图工具，目标是提供快速框选、手动滚动长截图、简单标注和自动复制。

## 当前能力

- 全局快捷键：`Ctrl/Cmd + Shift + X`
- 任意桌面内容的矩形框选
- 普通截图与手动滚动长截图
- 箭头、矩形、画笔和马赛克
- 预览图鼠标滚轮缩放、指针中心缩放和拖拽平移
- 完成后用系统原生剪贴板复制 PNG，也可以另存为文件
- 编辑器快捷键：`Ctrl/Cmd + Enter` 完成并复制，`Ctrl/Cmd + S` 另存为
- 系统托盘常驻

## 开发

```powershell
npm install
npm run tauri dev
```

只检查前端：

```powershell
npm run build
```

检查 Rust：

```powershell
cd src-tauri
cargo test
cargo check
```

## Windows 打包

```powershell
npm run tauri build -- --bundles nsis
```

生成产物：

- `src-tauri\target\release\screenshot-desktop.exe`
- `src-tauri\target\release\bundle\nsis\ScreenShot_0.1.0_x64-setup.exe`

说明：当前工程路径包含中文和 WPS 云盘目录，WiX MSI 打包可能报 `LGHT0001 / 0x8007007B`；NSIS 安装包已验证可生成。

完整项目背景、架构与接手顺序见 [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md)。
