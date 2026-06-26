# ScreenShot 工程说明与对话接手指南

更新时间：2026-06-23

## 1. 产品目标

ScreenShot 是一个 Windows + macOS 独立桌面工具，用于截取任意应用显示的内容。用户按全局快捷键后可矩形框选，选择普通截图或手动滚动长截图；截图完成后进入标注预览，确认时自动将 PNG 写入剪贴板。

产品默认完全离线，不上传截图，也不维护截图历史。

## 2. 已确认需求

- 平台：Windows、macOS。
- 截图对象：整个桌面上的任意应用。
- 普通截图：矩形框选。
- 长截图：用户手动滚动，程序持续捕获并进行视觉重叠匹配与拼接。
- 入口：全局快捷键，当前默认 `Ctrl/Cmd + Shift + X`。
- 标注：矩形、箭头、自由画笔、马赛克；支持撤销与重做。
- 预览：鼠标滚轮以指针位置为中心缩放；支持拖拽平移和适配窗口。
- 输出：确认后自动复制 PNG，并提供另存为。
- 多屏：可在任意一块屏幕截图，单次框选暂不跨屏。
- macOS：先完成共享代码和平台适配，之后在真实 Mac 上验证权限、Retina 与打包。

## 3. 技术栈

- Tauri 2：桌面窗口、托盘、IPC 和打包。
- Rust：屏幕捕获、区域裁剪、滚动拼接、标注渲染和 PNG 编码。
- React 19 + TypeScript + Vite：框选覆盖层、标注预览和设置界面。
- `xcap 0.9.6`：Windows/macOS 屏幕捕获；Windows 启用 WGC。
- Tauri 插件：global-shortcut、clipboard-manager、dialog。
- `image`：PNG 与像素处理。

## 4. 架构

### Rust

- `src-tauri/src/capture.rs`
  - 捕获所有显示器的冻结画面。
  - 为每块显示器创建 `overlay-*` 框选窗口。
  - 普通区域裁剪。
  - 长截图后台采样与生命周期。
- `src-tauri/src/stitch.rs`
  - 通过行特征粗匹配和像素采样复核，估算向下滚动位移。
  - 只追加新出现的底部区域。
  - 当前限制：最大高度 40,000 像素、最大 8,000 万像素。
- `src-tauri/src/annotate.rs`
  - 在 Rust 中把 SVG 预览对应的标注数据真正绘制到 PNG。
  - 马赛克以块平均色实现。
- `src-tauri/src/image_utils.rs`
  - `RgbaImage` 与 PNG Data URL 互转。
- `src-tauri/src/lib.rs`
  - Tauri 初始化、命令注册、快捷键和托盘。

### 前端

- `src/main.tsx` 根据 URL 查询参数渲染主窗口或框选覆盖层。
- `src/OverlayApp.tsx` 负责冻结屏幕上的矩形框选和普通/长截图分流。
- `src/App.tsx` 负责首页、事件接收和标注预览。
- `src/components/AnnotationEditor.tsx` 使用原图加 SVG 标注层，避免超长图片依赖浏览器大尺寸 Canvas。
- `src/types.ts` 是 IPC 数据和标注类型的共享定义。

## 5. 关键交互

1. 快捷键或首页按钮调用 `begin_capture`。
2. 主窗口隐藏，Rust 等待短暂时间后捕获所有显示器。
3. 每块显示器显示冻结画面的覆盖窗口。
4. 用户框选后选择普通截图或长截图。
5. 普通截图直接裁剪并发送 `capture-ready`。
6. 长截图关闭覆盖窗口，用户缓慢向下滚动，再按相同快捷键停止。
7. Rust 拼接完成后发送 `capture-ready`，主窗口进入编辑器。
8. 前端维护矢量标注；完成时调用 `render_annotations`。
9. 前端把返回的 PNG 写入系统剪贴板。

## 6. 长截图限制与后续验证重点

- 第一版只识别向下滚动。
- 页面有视频、动画、大面积重复纹理或持续刷新区域时，匹配可能失败。
- 固定页头通过忽略重叠区顶部的一部分来降低干扰。
- Windows 必测：多屏负坐标、100%/125%/150% 缩放、不同屏幕缩放混用。
- macOS 必测：屏幕录制权限首次授权、Retina 像素比、多屏、应用签名后权限是否保留。
- CI 只能验证 macOS 编译，无法替代真实屏幕捕获测试。

## 7. 新对话接手顺序

1. 完整阅读本文件。
2. 先确认工程路径：`C:\Users\Amamda\Documents\WPS Cloud Files\WPSDrive\218773289\WPS云盘\obsidian\my_tools\ScreenShot`。
3. 当前目录不是 Git 仓库；如果以后初始化 Git，再运行 `git status --short`，不要覆盖用户已有改动。
4. 运行 `npm install`，确保 `node_modules/.bin` 里的 Tauri CLI shim 存在。
5. 运行 `npm run build`。
6. 在 `src-tauri` 运行 `cargo test`。
7. 如需 Windows 安装包，运行 `npm run tauri build -- --bundles nsis`。
8. 修改功能后同步更新本文件的“当前状态”和相关设计说明。

## 8. 当前状态

- 已完成第一版可运行实现：主窗口、托盘、全局快捷键、冻结屏幕覆盖层、矩形框选、普通截图、手动滚动长截图后台拼接、标注预览、鼠标滚轮缩放、平移、箭头/矩形/画笔/马赛克、撤销/重做、完成并复制 PNG、另存为。
- Windows 实机已验证：
  - 主窗口可打开，默认快捷键显示为 `Ctrl/Cmd + Shift + X`。
  - 全局快捷键可隐藏主窗口并显示冻结遮罩。
  - 冻结阶段不再显示全黑 `正在冻结屏幕…` loading：覆盖窗口创建时保持隐藏，前端拿到冻结图数据后调用 Rust `show_overlay_window` 显示并聚焦。
  - 矩形框选后工具条可见，可进入标注预览。
  - 标注预览鼠标滚轮缩放已验证，倍率从 100% 变为 135%。
  - 默认窗口宽度已从 1120 调整为 960，并允许编辑器头部响应式压缩/隐藏部分缩放按钮，确保“另存为”和“完成并复制”在窄窗口下始终可见。
  - Windows 原生剪贴板底层验证通过：Rust `arboard` 写入图片后，系统剪贴板可识别 `PNG`、`Bitmap`、`DeviceIndependentBitmap` 等格式。
- 2026-06-23 修复记录：
  - 去掉冻结屏幕黑色 loading，冻结准备过程静默执行。
  - 优化长截图拼接：匹配更偏向文字/边缘细节行，并在接缝处做 10px 重叠羽化，降低白线/硬切缝。
  - 导出链路调整：编辑器内 toast 可见；“另存为”先弹保存路径再渲染；“完成并复制”改为 Rust 侧原生写剪贴板。
  - 增加编辑器快捷键：`Ctrl/Cmd + Enter` 完成并复制，`Ctrl/Cmd + S` 另存为。
- 构建验证：
  - `npm run build` 通过。
  - `cargo test` 通过，`stitch::tests::stitches_scrolled_views` 通过。
  - `npm run tauri build -- --bundles nsis` 通过。
- Windows 产物：
  - Release 可执行文件：`src-tauri\target\release\screenshot-desktop.exe`
  - NSIS 安装包：`src-tauri\target\release\bundle\nsis\ScreenShot_0.1.0_x64-setup.exe`
- macOS 代码路径已按跨平台思路实现，但尚未在真实 Mac 上验证权限、Retina、多屏和打包。

## 9. 已知限制与注意事项

- MSI 打包：`npm run tauri build` 默认尝试 WiX MSI；在当前包含中文和 WPS 云盘的路径下，WiX 3.14 的 `light.exe` 会失败：
  - `LGHT0001: 文件名、目录名或卷标语法不正确。 (HRESULT:0x8007007B)`
  - 解决方式：当前使用 `npm run tauri build -- --bundles nsis` 生成 NSIS 安装包；或把工程复制到纯英文短路径后再尝试 MSI。
- 长截图第一版仅识别向下滚动；页面有视频、动画、大面积重复纹理或持续刷新区域时，拼接可能失败。
- 如果截取区域内有固定悬浮按钮/浮层，它仍可能在长截图里重复出现；当前修复主要降低接缝白线和错位硬切。
- 单次框选暂不跨屏。
- 当前没有截图历史、云同步和 OCR，符合“完全本地处理”的第一版边界。
