# ScreenShot

一个本地优先的 Windows / macOS 桌面截图工具，目标是提供快速框选、手动滚动长截图、简单标注和自动复制。

## 当前能力

- 全局快捷键：`Ctrl/Cmd + Shift + X`
- 任意桌面内容的矩形框选
- 普通截图与手动滚动长截图
- 框选后“完成并复制”直接复制截图，“编辑截图”进入标注界面
- 箭头、矩形、画笔、文字和马赛克
- 文字标注支持中文、多行、颜色和字号调整，以及撤销/重做
- 预览图鼠标滚轮缩放、指针中心缩放和拖拽平移
- 完成后用系统原生剪贴板复制 PNG，也可以另存为文件
- 编辑器快捷键：`Ctrl/Cmd + Enter` 完成并复制，`Ctrl/Cmd + S` 另存为
- 系统托盘常驻

## 添加文字

1. 框选后选择 **编辑截图**，在左侧工具栏选择 **文字**，点击截图中的位置。
2. 输入文字，按 `Enter` 换行；使用颜色选择器和字号滑块调整样式（12–96px）。
3. 点击 **添加文字** 确认，或按 `Esc` / 点击 **取消** 放弃当前输入。点击截图其他位置可继续添加，切换工具会确认当前文字。
4. 点击 **完成并复制** 或 **另存为**，文字会随截图一起导出；仍在输入中的文字也会自动确认。

输入框中的空格、换行和 `Ctrl/Cmd + Z` 保留正常的文字编辑行为。确认后的文字可与其他标注一起撤销/重做；文字超出截图边缘的部分会被裁切。

## 直接完成截图

1. 按 `Ctrl/Cmd + Shift + X` 冻结屏幕，拖动鼠标框选区域。
2. 点击 **完成并复制**，或在未聚焦工具条按钮时按 `Enter`，直接复制选区原始像素并收起冻结窗口，可回到原来的应用粘贴。
3. 需要添加文字、箭头、马赛克等标注时，点击 **编辑截图**；需要拼接长图时，选择 **滚动长截图**。

直接复制不打开编辑器，也不执行用于编辑器预览的 PNG 编码。如果剪贴板写入失败，冻结窗口保留选区并显示错误，可重试复制或改为编辑截图。复制过程中会禁用重复提交和取消操作，避免重复写入。

## 响应速度

- 启动时预先创建隐藏的框选窗口，后续截图复用窗口；取消或完成时清空画面和框选状态。
- Rust 缓存当前截图的原始像素。复制和保存只传递截图编号及标注，直接在后台合成并输出，避免整张图片反复进行 Base64 传输和 PNG 编解码。
- PNG 使用快速无损编码，导出的原始像素和透明度不变。减少冻结前的固定等待，在图片加载后立即显示覆盖层。
- 安装使用 Release 构建。Debug 构建的图像处理明显更慢，适合开发调试。

本机 2560×1440 合成图的单次处理基准：预览由旧 Debug 版约 1551ms 降至 Release 版约 98ms；截图 PNG 由约 2757ms 降至约 56ms。新复制路径不再进行整图 PNG 往返，带矩形标注的合成约 3ms。这些数值不包含屏幕捕获、窗口显示和系统剪贴板耗时，完整操作耗时取决于显示器及系统环境。

复现图像处理基准（不访问屏幕或剪贴板）：

```sh
cd src-tauri
cargo run --release --example latency
```

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

## macOS 打包

```sh
npm run tauri build -- --bundles app
```

生成 `src-tauri/target/release/bundle/macos/ScreenShot.app`。复制到 `/Applications` 后启动；首次使用需授予屏幕录制权限。

完整项目背景、架构与接手顺序见 [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md)。
