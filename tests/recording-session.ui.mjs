// Regression: opening the recorder must not import an earlier session's saved/deleted file.
import assert from 'node:assert/strict';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await (process.env.TEST_BROWSER === 'webkit' ? webkit : chromium).launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
page.setDefaultTimeout(5000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  let next = 1;
  const callbacks = new Map(), listeners = new Map();
  window.calls = []; window.cancelSave = false;
  window.previousRecording = { id: 'previous-recording', mode: 'window', phase: 'saved', message: '录屏已保存', filePath: '/tmp/ScreenShot-deleted-previous.mp4', elapsedMs: 1000, bytesWritten: 1000, width: 640, height: 360 };
  window.recordStatus = window.previousRecording;
  window.statusEvent = value => {
    window.recordStatus = value;
    for (const id of listeners.get('recording-status') || []) callbacks.get(id)?.({ payload: value });
  };
  window.__TAURI_INTERNALS__ = {
    transformCallback(callback) { const id = next++; callbacks.set(id, callback); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc() { return ''; },
    async invoke(cmd, args = {}) {
      window.calls.push({ cmd, args });
      if (cmd === 'plugin:event|listen') { if (!listeners.has(args.event)) listeners.set(args.event, new Set()); listeners.get(args.event).add(args.handler); return args.handler; }
      if (cmd === 'default_shortcut') return 'CommandOrControl+Shift+X';
      if (cmd === 'native_recording_available') return true;
      if (cmd === 'native_capture_sources') return [{ id: 2, kind: 'window', name: '测试窗口', width: 640, height: 360 }];
      if (cmd === 'get_recording_status') return window.recordStatus;
      if (cmd === 'get_recording_browsers') return [{ id: 'chrome', name: 'Google Chrome' }];
      if (cmd === 'plugin:dialog|save') return window.cancelSave ? null : '/tmp/ScreenShot-current.mp4';
      if (cmd === 'studio_call') {
        if (args.method === 'app:getStatus') return { ffmpeg: { ok: true }, tts: { ok: true } };
        if (args.method === 'project:create') return { id: 'project', rootDir: '/tmp/test-project', assets: [], exports: [], mergeQueue: [] };
        if (args.method === 'project:save') return args.payload;
        if (args.method === 'project:importVideos') {
          if (args.payload.paths.includes(window.previousRecording.filePath)) throw new Error('ENOENT: no such file or directory, copyfile ' + window.previousRecording.filePath);
          return [{ id: `asset-${next++}`, name: '新录屏.mp4', duration: 3, path: null, segments: [] }];
        }
      }
      if (cmd === 'start_native_recording' || cmd === 'start_recording_session') {
        const value = { id: `new-recording-${next++}`, mode: args.options.mode, phase: cmd === 'start_native_recording' ? 'recording' : 'waiting', browser: 'Google Chrome', message: '本次录屏已开始', elapsedMs: 0, bytesWritten: 0, width: 640, height: 360, filePath: null };
        if(cmd === 'start_recording_session')value.controllerId=value.id;
        window.statusEvent(value);
        if (window.completeBeforeReturn) window.statusEvent({ ...value, phase: 'saved', message: '录屏已保存', filePath: '/tmp/ScreenShot-current.mp4' });
        return value;
      }
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(event, id) { listeners.get(event)?.delete(id); callbacks.delete(id); } };
});
const importedPaths = () => page.evaluate(() => window.calls.filter(call => call.cmd === 'studio_call' && call.args.method === 'project:importVideos').flatMap(call => call.args.payload.paths));
const settle = () => page.waitForTimeout(150);
const assertRecorder = async () => assert.equal(await page.locator('.mode-tabs button.selected').innerText(), '录屏');
try {
  await page.goto('http://127.0.0.1:1420');
  await page.getByRole('button', { name: '视频制作', exact: true }).click();
  const editor = page.frameLocator('iframe[title="视频制作"]');
  await editor.locator('#mediaStatus').getByText('媒体组件已就绪').waitFor();
  await editor.locator('#recordBtn').click();
  await page.waitForFunction(() => window.calls.some(call => call.cmd === 'get_recording_status'));
  await settle();
  await assertRecorder(); assert.deepEqual(await importedPaths(), []);
  // A repeated old completion event must also be ignored before starting a new session.
  await page.evaluate(() => window.statusEvent(window.previousRecording)); await settle();
  await assertRecorder(); assert.deepEqual(await importedPaths(), []);
  // Cancelling the save dialog does not authorize importing an earlier recording either.
  await page.evaluate(() => { window.cancelSave = true; });
  await page.getByRole('button', { name: '开始录屏', exact: true }).click();
  await page.evaluate(() => window.statusEvent(window.previousRecording)); await settle();
  await assertRecorder(); assert.deepEqual(await importedPaths(), []);
  await page.evaluate(() => { window.cancelSave = false; });
  await page.getByRole('button', { name: '开始录屏', exact: true }).click();
  await page.getByText('本次录屏已开始', { exact: true }).waitFor({ timeout: 10000 });
  const current = await page.evaluate(() => ({ ...window.recordStatus }));
  await page.evaluate(() => window.statusEvent(window.previousRecording)); await settle();
  await assertRecorder(); assert.deepEqual(await importedPaths(), []);
  await page.evaluate(current => window.statusEvent({ ...current, phase: 'saved', message: '录屏已保存', filePath: '/tmp/ScreenShot-current.mp4' }), current);
  await editor.locator('#assetCount').getByText('1', { exact: true }).waitFor();
  assert.deepEqual(await importedPaths(), ['/tmp/ScreenShot-current.mp4']);
  // Reopening after a successful capture must not import that capture a second time.
  await editor.locator('#recordBtn').click(); await settle(); await assertRecorder();
  assert.deepEqual(await importedPaths(), ['/tmp/ScreenShot-current.mp4']);
  await page.getByRole('radio', { name: /浏览器页签/ }).check();
  await page.getByRole('button', { name: '开始录屏', exact: true }).click();
  await page.getByRole('button', { name: '取消录屏', exact: true }).waitFor();
  const tab = await page.evaluate(() => ({ ...window.recordStatus }));
  await page.evaluate(() => window.statusEvent(window.previousRecording)); await settle(); await assertRecorder();
  await page.evaluate(tab => window.statusEvent({ ...tab, phase: 'saved', message: '录屏已保存', filePath: '/tmp/ScreenShot-new-tab.mp4' }), tab);
  await editor.locator('#assetCount').getByText('2', { exact: true }).waitFor();
  assert.deepEqual(await importedPaths(), ['/tmp/ScreenShot-current.mp4', '/tmp/ScreenShot-new-tab.mp4']);
  // A very short recording may finish before its start RPC resolves, and may reuse a saved path.
  await editor.locator('#recordBtn').click(); await settle(); await assertRecorder();
  await page.evaluate(() => { window.completeBeforeReturn = true; });
  await page.getByRole('button', { name: '开始录屏', exact: true }).click();
  await editor.locator('#assetCount').getByText('3', { exact: true }).waitFor({ timeout: 10000 });
  assert.deepEqual(await importedPaths(), ['/tmp/ScreenShot-current.mp4', '/tmp/ScreenShot-new-tab.mp4', '/tmp/ScreenShot-current.mp4']);
  // Repeated rounds from an owned browser controller can use new recording IDs.
  await page.getByRole('button',{name:'录屏',exact:true}).click();
  await page.getByRole('radio',{name:/浏览器页签/}).check();
  await page.evaluate(()=>{window.completeBeforeReturn=false;});
  await page.getByRole('button',{name:'开始录屏',exact:true}).click();
  await page.getByRole('button',{name:'取消录屏',exact:true}).waitFor();
  const root=await page.evaluate(()=>({...window.recordStatus}));
  await page.evaluate(root=>window.statusEvent({...root,phase:'saved',message:'第一段已保存',filePath:'/tmp/controller-first.mp4'}),root);
  await page.getByText('第一段已保存',{exact:true}).waitFor();
  const next={...root,id:'controller-second',controllerId:root.id,phase:'recording',message:'正在录制第二段'};
  await page.evaluate(next=>window.statusEvent(next),next);
  await page.getByText('正在录制第二段',{exact:true}).waitFor();
  await page.evaluate(()=>window.statusEvent(window.previousRecording));await settle();
  await page.getByText('正在录制第二段',{exact:true}).waitFor();
  await page.evaluate(next=>window.statusEvent({...next,phase:'saved',message:'第二段已保存',filePath:'/tmp/controller-second.mp4'}),next);
  await page.getByText('第二段已保存',{exact:true}).waitFor();
  assert.deepEqual(await importedPaths(), ['/tmp/ScreenShot-current.mp4', '/tmp/ScreenShot-new-tab.mp4', '/tmp/ScreenShot-current.mp4']);
  assert.deepEqual(errors, []);
  console.log('PASS: stale/deleted snapshot, stale events, cancelled start, native/tab ownership, fast completion, repeated file path, controller continuation, single import per recording');
} finally { await browser.close(); }
