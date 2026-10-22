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
  window.calls = []; window.failPath = false; window.failStart = false;
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
      if (cmd === 'plugin:dialog|save') return '/tmp/ScreenShot-current.mp4';
      if (cmd === 'default_recording_path') {
        if(window.failPath)throw new Error('测试保存目录不可用');
        return args.projectRoot ? `${args.projectRoot}/assets/current.mp4` : `/Users/test/screenshot/${args.date}/current.mp4`;
      }
      if (cmd === 'toggle_studio_fullscreen') { window.fullscreen = !window.fullscreen; return; }
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
        if(window.failStart)throw new Error('测试录屏启动失败');
        const value = { id: `new-recording-${next++}`, mode: args.options.mode, phase: cmd === 'start_native_recording' ? 'recording' : 'waiting', browser: 'Google Chrome', message: '本次录屏已开始', elapsedMs: 0, bytesWritten: 0, width: 640, height: 360, filePath: null };
        if(cmd === 'start_recording_session')value.controllerId=value.id;
        window.statusEvent(value);
        if (window.completeBeforeReturn) window.statusEvent({ ...value, phase: 'saved', message: '录屏已保存', filePath: '/tmp/ScreenShot-current.mp4' });
        return value;
      }
      if(cmd==='recording_control')window.statusEvent({...window.recordStatus,phase:args.action==='stop'?'saved':args.action==='pause'?'paused':'recording',message:'本次录屏已保存',filePath:args.action==='stop'?'/tmp/ScreenShot-current.mp4':null});
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(event, id) { listeners.get(event)?.delete(id); callbacks.delete(id); } };
});
const importedPaths = () => page.evaluate(() => window.calls.filter(call => call.cmd === 'studio_call' && call.args.method === 'project:importVideos').flatMap(call => call.args.payload.paths));
const settle = () => page.waitForTimeout(150);
const assertStudio = async () => assert.equal(await page.locator('.mode-tabs button.selected').getAttribute('aria-label'), '视频制作');
try {
  await page.goto('http://127.0.0.1:1420');
  await page.getByRole('button', { name: '视频制作', exact: true }).click();
  const editor = page.frameLocator('iframe[title="视频制作"]');
  await editor.locator('#mediaStatus').getByText('媒体组件已就绪').waitFor();
  await page.getByRole('button',{name:'全屏 / 退出全屏',exact:true}).click();
  await assertStudio(); assert.deepEqual(await importedPaths(), []);
  // A repeated old completion event must also be ignored before starting a new session.
  await page.evaluate(() => window.statusEvent(window.previousRecording)); await settle();
  await assertStudio(); assert.deepEqual(await importedPaths(), []);
  // A failed destination must neither switch workspaces nor import an old result.
  await page.evaluate(() => { window.failPath = true; });
  await editor.locator('#recordBtn').click();
  await editor.locator('#toast').getByText('测试保存目录不可用').waitFor();
  await page.evaluate(() => window.statusEvent(window.previousRecording)); await settle();
  await assertStudio(); assert.deepEqual(await importedPaths(), []);
  await page.evaluate(() => { window.failPath = false; });
  const before = await page.evaluate(()=>window.calls.length);
  await editor.locator('#recordBtn').click();
  await page.waitForFunction(()=>window.recordStatus.controllerId);
  const startCalls=await page.evaluate(before=>window.calls.slice(before),before);
  assert.equal(startCalls.filter(call=>['switch_workspace','toggle_studio_fullscreen','plugin:dialog|save','native_capture_sources'].includes(call.cmd)).length,0);
  assert.equal(startCalls.find(call=>call.cmd==='start_recording_session').args.path,'/tmp/test-project/assets/current.mp4');
  assert.equal(await page.evaluate(()=>window.fullscreen),true);
  const current = await page.evaluate(() => ({ ...window.recordStatus }));
  await page.evaluate(() => window.statusEvent(window.previousRecording)); await settle();
  await assertStudio(); assert.deepEqual(await importedPaths(), []);
  await page.evaluate(current => window.statusEvent({ ...current, phase: 'saved', message: '录屏已保存', filePath: '/tmp/ScreenShot-current.mp4' }), current);
  await editor.locator('#assetCount').getByText('1', { exact: true }).waitFor();
  assert.deepEqual(await importedPaths(), ['/tmp/ScreenShot-current.mp4']);
  // Duplicate events and a continued controller round each import at most once.
  await page.evaluate(current=>window.statusEvent({...current,phase:'saved',filePath:'/tmp/ScreenShot-current.mp4'}),current);await settle();
  assert.deepEqual(await importedPaths(), ['/tmp/ScreenShot-current.mp4']);
  const tab = {...current,id:'continued-tab',controllerId:current.id,mode:'tab',phase:'recording'};
  await page.evaluate(tab=>window.statusEvent(tab),tab);
  await page.evaluate(() => window.statusEvent(window.previousRecording)); await settle(); await assertStudio();
  await page.evaluate(tab => window.statusEvent({ ...tab, phase: 'saved', message: '录屏已保存', filePath: '/tmp/ScreenShot-new-tab.mp4' }), tab);
  await editor.locator('#assetCount').getByText('2', { exact: true }).waitFor();
  assert.deepEqual(await importedPaths(), ['/tmp/ScreenShot-current.mp4', '/tmp/ScreenShot-new-tab.mp4']);
  // A very short recording may finish before its start RPC resolves, and may reuse a saved path.
  await page.evaluate(() => { window.completeBeforeReturn = true; });
  await editor.locator('#recordBtn').click();
  await editor.locator('#assetCount').getByText('3', { exact: true }).waitFor({ timeout: 10000 });
  assert.deepEqual(await importedPaths(), ['/tmp/ScreenShot-current.mp4', '/tmp/ScreenShot-new-tab.mp4', '/tmp/ScreenShot-current.mp4']);
  // Cancelled/failed browser setup cannot import an earlier completion.
  await page.evaluate(()=>{window.completeBeforeReturn=false;});
  await editor.locator('#recordBtn').click();await settle();
  await page.evaluate(()=>window.statusEvent({...window.recordStatus,phase:'cancelled',filePath:null}));
  await page.evaluate(()=>{window.failStart=true;});
  await editor.locator('#recordBtn').click();await editor.locator('#toast').getByText('测试录屏启动失败').waitFor();
  await page.evaluate(()=>window.statusEvent(window.previousRecording));await settle();
  assert.equal((await importedPaths()).length,3);await assertStudio();
  await page.evaluate(()=>{window.failStart=false;window.statusEvent({...window.recordStatus,phase:'cancelled',filePath:null});});
  // Standalone native recording uses a daily default, without auto-importing.
  await page.getByRole('button',{name:'录屏',exact:true}).click();
  await page.getByRole('combobox',{name:'录屏画质',exact:true}).selectOption('2k');
  const startsBefore=await page.evaluate(()=>window.calls.filter(call=>call.cmd==='start_native_recording').length);
  await page.getByRole('button',{name:'开始录屏',exact:true}).click();
  await page.getByRole('button',{name:'取消开始',exact:true}).click();
  await page.getByRole('button',{name:'开始录屏',exact:true}).waitFor({timeout:5000});
  assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.cmd==='start_native_recording').length),startsBefore);
  await page.getByRole('button',{name:'开始录屏',exact:true}).click();
  await page.getByText('本次录屏已开始',{exact:true}).waitFor({timeout:10000});
  const native=await page.evaluate(()=>window.calls.findLast(call=>call.cmd==='start_native_recording'));
  assert.equal(native.args.source.cursor,true);assert.equal(native.args.source.clicks,true);assert.equal(native.args.source.microphone,false);
  assert.equal(native.args.options.resolution,'2k');
  assert.match(native.args.path,/^\/Users\/test\/screenshot\/\d{4}-\d{2}-\d{2}\/current.mp4$/);
  await page.getByRole('button',{name:'停止并保存',exact:true}).click();await settle();
  assert.equal(await page.locator('.mode-tabs button.selected').getAttribute('aria-label'),'录屏');
  assert.equal((await importedPaths()).length,3);
  // The compatibility/tab entry carries the same 2K choice through IPC.
  await page.getByRole('radio',{name:/浏览器页签/}).check();
  await page.getByRole('combobox',{name:'录屏画质',exact:true}).selectOption('2k');
  await page.getByRole('button',{name:'开始录屏',exact:true}).click();await settle();
  assert.equal(await page.evaluate(()=>window.calls.findLast(call=>call.cmd==='start_recording_session').args.options.resolution),'2k');
  assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.cmd==='plugin:dialog|save').length),0);
  assert.deepEqual(errors, []);
  console.log('PASS: studio opens controller directly, fullscreen retained, no save dialog, project/daily paths, stale/deleted protection, failed/cancelled start, fast completion, continuation ownership, single import');
} finally { await browser.close(); }
