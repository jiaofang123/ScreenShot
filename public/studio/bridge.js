// Same-app bridge: this editor shares the main Tauri window, no browser tab or Electron app.
if (!window.parent.screenShotStudio) throw new Error('请在 ScreenShot 视频制作工作区打开此页面');
window.studio = window.parent.screenShotStudio;
