// Two webviews with mocked Tauri IPC: desktop selection, cancellation and recording handoff.
// No system screen capture occurs in this test.
import assert from 'node:assert/strict';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await (process.env.TEST_BROWSER === 'webkit' ? webkit : chromium).launch();
const context = await browser.newContext({ viewport: { width: 960, height: 700 } });
const errors = [], calls = [];
let snapshot = null, pending = null, session = 0, failNext = false;
const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1400"><rect width="1920" height="1400" fill="#32597d"/></svg>');
await context.exposeFunction('testInvoke', (cmd, args = {}) => {
  calls.push({ cmd, args });
  if (cmd === 'default_shortcut') return 'CommandOrControl+Shift+X';
  if (cmd === 'native_recording_available') return true;
  if (cmd === 'native_capture_sources') return [
    { id: 1, kind: 'window', name: '测试窗口', width: 640, height: 360 },
    { id: 2, kind: 'desktop', name: '内置屏幕', width: 1920, height: 1400 },
    { id: 3, kind: 'desktop', name: '外接屏幕', width: 1920, height: 1400 },
  ];
  if (cmd === 'select_recording_region') {
    if (failNext) { failNext = false; throw new Error('屏幕不可用，请重新选择'); }
    assert.equal(pending, null);
    snapshot = { sessionId: ++session, monitorId: args.monitorId, name: `录屏屏幕 ${session}`, width: 1920, height: 1400, scaleFactor: 2, dataUrl: image, purpose: 'recording' };
    return new Promise(resolve => { pending = resolve; });
  }
  if (cmd === 'get_overlay_snapshot') {
    if (!snapshot) throw new Error('没有活动框选');
    return snapshot;
  }
  if (cmd === 'finish_recording_region_selection') {
    const { region } = args;
    assert.equal(region.sessionId, snapshot.sessionId);
    assert.equal(region.monitorId, 3);
    const { x, y, width, height } = region;
    pending({ crop: { x: x / 1920, y: y / 1400, width: width / 1920, height: height / 1400 }, width, height });
    pending = null;
  }
  if (cmd === 'cancel_capture') { pending?.(null); pending = null; }
  if (cmd === 'plugin:dialog|save') return '/tmp/ScreenShot-region.mp4';
  if (cmd === 'default_recording_path') return '/tmp/ScreenShot-region.mp4';
  if (cmd === 'start_native_recording') return { id: 'region-recording', mode: 'region', phase: 'recording', message: '区域录屏已开始', filePath: null, elapsedMs: 0, bytesWritten: 0, width: 720, height: 540 };
});
await context.addInitScript(() => {
  let next = 1;
  const callbacks = new Map(), listeners = new Map();
  window.__TAURI_INTERNALS__ = {
    transformCallback(callback) { const id = next++; callbacks.set(id, callback); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(cmd, args = {}) {
      if (cmd === 'plugin:event|listen') { if (!listeners.has(args.event)) listeners.set(args.event, new Set()); listeners.get(args.event).add(args.handler); return args.handler; }
      return window.testInvoke(cmd, args);
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(event, id) { listeners.get(event)?.delete(id); callbacks.delete(id); } };
  window.emit = event => { for (const id of listeners.get(event) || []) callbacks.get(id)?.({ payload: null }); };
});
const page = await context.newPage(), overlay = await context.newPage();
for (const surface of [page, overlay]) { surface.setDefaultTimeout(5000); surface.on('pageerror', error => errors.push(error.message)); }
const start = page.getByRole('button', { name: '开始录屏', exact: true });
async function draw(x1, y1, x2, y2) {
  await overlay.mouse.move(x1, y1); await overlay.mouse.down(); await overlay.mouse.move(x2, y2); await overlay.mouse.up();
}
async function pick() {
  await page.getByRole('button', { name: /^(框选录制区域|重新框选)$/ }).click();
  assert.ok(pending);
  assert.equal(await start.isDisabled(), true);
  assert.equal(await page.getByRole('combobox', { name: '录制目标', exact: true }).isDisabled(), true);
  await overlay.evaluate(() => window.emit('overlay-refresh'));
  await overlay.getByText(`录屏屏幕 ${session}`, { exact: true }).waitFor();
}
try {
  await page.goto('http://127.0.0.1:1420');
  await overlay.goto('http://127.0.0.1:1420/?mode=overlay&monitorId=3');
  await page.getByRole('button', { name: '录屏', exact: true }).click();
  await page.getByRole('radio', { name: /框选区域/ }).check();
  await page.getByRole('combobox', { name: '录制目标', exact: true }).selectOption('3');
  assert.equal(await start.isDisabled(), true);
  assert.equal(await page.locator('.native-region-stage').count(), 0);
  // Initial cancellation keeps Start disabled. The picker works again immediately.
  await pick(); await overlay.keyboard.press('Escape');
  await page.getByRole('button', { name: '框选录制区域', exact: true }).waitFor();
  assert.equal(await start.isDisabled(), true);
  await pick(); await draw(100, 120, 420, 360);
  assert.equal(await overlay.getByRole('button', { name: '完成并复制', exact: true }).count(), 0);
  assert.equal(await overlay.getByRole('button', { name: '编辑截图', exact: true }).count(), 0);
  assert.equal(await overlay.getByRole('button', { name: '滚动长截图', exact: true }).count(), 0);
  const corner = await overlay.getByRole('button', { name: '拖动右下角调整选区', exact: true }).boundingBox();
  await overlay.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2); await overlay.mouse.down();
  await overlay.mouse.move(corner.x + corner.width / 2 + 40, corner.y + corner.height / 2 + 30); await overlay.mouse.up();
  await overlay.keyboard.press('Enter');
  await page.getByText('已选择 720 × 540 像素。可重新框选调整范围。', { exact: true }).waitFor();
  assert.equal(await start.isEnabled(), true);
  assert.deepEqual(calls.find(call => call.cmd === 'finish_recording_region_selection').args.region, { sessionId: 2, monitorId: 3, x: 200, y: 240, width: 720, height: 540 });
  // Cancelling a reselect keeps the previous range. Errors also restore usable controls.
  await pick(); await draw(20, 20, 200, 200); await overlay.getByRole('button', { name: '取消框选', exact: true }).click();
  await page.getByText('已选择 720 × 540 像素。可重新框选调整范围。', { exact: true }).waitFor();
  assert.equal(await start.isEnabled(), true);
  failNext = true;
  await page.getByRole('button', { name: '重新框选', exact: true }).click();
  await page.getByRole('alert').getByText(/屏幕不可用/).waitFor();
  assert.equal(await start.isEnabled(), true);
  // A new confirmed range replaces the earlier one and is passed unchanged to recording.
  await pick(); await draw(200, 200, 600, 500);
  await overlay.getByRole('button', { name: '确认录制区域', exact: true }).click();
  await page.getByText('已选择 800 × 600 像素。可重新框选调整范围。', { exact: true }).waitFor();
  await start.click(); await page.getByText('区域录屏已开始', { exact: true }).waitFor({ timeout: 10000 });
  const recording = calls.find(call => call.cmd === 'start_native_recording');
  assert.deepEqual(recording.args.source.crop, { x: 400 / 1920, y: 400 / 1400, width: 800 / 1920, height: 600 / 1400 });
  assert.equal(recording.args.source.sourceId, 3);
  assert.equal(calls.filter(call => call.cmd === 'native_source_preview').length, 0);
  // A prewarmed picker reused for screenshots must restore its original actions.
  snapshot = { ...snapshot, sessionId: ++session, purpose: 'screenshot', name: '普通截图' };
  await overlay.evaluate(() => window.emit('overlay-refresh'));
  await overlay.getByText('普通截图', { exact: true }).waitFor(); await draw(50, 50, 200, 200);
  assert.equal(await overlay.getByRole('button', { name: '确认录制区域', exact: true }).count(), 0);
  await overlay.keyboard.press('Enter');
  assert.equal(calls.filter(call => call.cmd === 'copy_region_to_clipboard').length, 1);
  assert.deepEqual(errors, []);
  console.log('PASS: desktop picker, target display, four-corner resize, Retina coordinates, confirm/Enter, cancel/reselect, errors, recording handoff, screenshot reuse');
} finally { pending?.(null); await browser.close(); }
