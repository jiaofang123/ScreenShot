// UI + real media worker. Tauri dialogs/window IPC are mocked; no desktop capture occurs.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const {chromium,webkit}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'ScreenShot-studio-ui-'));
const fixture=join(directory,'示例视频.mp4');
execFileSync(join(root,'src-tauri/studio/node_modules/ffmpeg-static/ffmpeg'),['-hide_banner','-loglevel','error','-f','lavfi','-i','color=green:size=320x180:duration=3:rate=30','-c:v','libx264','-pix_fmt','yuv420p',fixture]);
const child=spawn(process.execPath,[join(root,'src-tauri/studio/worker.mjs')],{stdio:['pipe','pipe','inherit'],env:{...process.env,SCREENSHOT_STUDIO_WORKSPACE:directory}});
const waiting=[], lines=createInterface({input:child.stdout});
lines.on('line',line=>{const next=waiting.shift(),data=JSON.parse(line);data.ok?next.resolve(data.result):next.reject(new Error(data.error));});
const call=(method,payload)=>new Promise((resolve,reject)=>{waiting.push({resolve,reject});child.stdin.write(JSON.stringify({method,payload})+'\n');});
const browser=await (process.env.TEST_BROWSER==='webkit'?webkit:chromium).launch(process.env.TEST_BROWSER==='webkit'?{}:{executablePath:process.env.RECORDING_CHROME_PATH||undefined});
const page=await browser.newPage({viewport:{width:1440,height:940}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.setDefaultTimeout(15000);
page.on('console',message=>{if(message.type()==='error')console.error('PAGE:',message.text());});
await page.exposeFunction('mediaCall',({method,payload})=>call(method,payload));
await page.route('**/__test_media/**',async route=>{
  const path=decodeURIComponent(new URL(route.request().url()).pathname.split('/__test_media/')[1]);
  const bytes=await readFile(path),range=route.request().headers().range;
  const mime=path.endsWith('.wav')?'audio/wav':path.endsWith('.mp3')?'audio/mpeg':'video/mp4';
  if(range){const match=range.match(/bytes=(\d+)-(\d*)/),start=Number(match[1]),end=Math.min(bytes.length-1,match[2]?Number(match[2]):bytes.length-1);await route.fulfill({status:206,headers:{'Content-Type':mime,'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${bytes.length}`},body:bytes.subarray(start,end+1)});}
  else await route.fulfill({contentType:mime,body:bytes});
});
await page.addInitScript(({fixture,directory})=>{
  let id=1;const callbacks=new Map(),listeners=new Map();window.calls=[];window.recordStatus=null;
  window.__TAURI_INTERNALS__={
    transformCallback(callback){const current=id++;callbacks.set(current,callback);return current;},unregisterCallback(current){callbacks.delete(current);},
    convertFileSrc(path){return `http://127.0.0.1:1420/__test_media/${encodeURIComponent(path)}`;},
    async invoke(cmd,args={}){
      window.calls.push({cmd,args});
      if(cmd==='default_shortcut')return 'CommandOrControl+Shift+X';
      if(cmd==='plugin:event|listen'){if(!listeners.has(args.event))listeners.set(args.event,new Set());listeners.get(args.event).add(args.handler);return args.handler;}
      if(cmd==='switch_workspace')return;
      if(cmd==='studio_call')return window.mediaCall(args);
      if(cmd==='plugin:dialog|open')return args.options?.directory?directory:[fixture];
      if(cmd==='plugin:dialog|save')return `${directory}/录屏.mp4`;
      if(cmd==='default_recording_path')return `${args.projectRoot}/assets/recording-test.mp4`;
      if(cmd==='toggle_studio_fullscreen'){window.studioFullscreen=!window.studioFullscreen;return;}
      if(cmd==='native_recording_available')return true;
      if(cmd==='native_capture_sources')return [{id:1,kind:'desktop',name:'测试桌面',width:640,height:360},{id:2,kind:'window',name:'测试应用窗口',width:640,height:360}];
      if(cmd==='select_recording_region')return {crop:{x:.12,y:.2,width:.48,height:.6},width:307,height:216};
      if(cmd==='get_recording_status')return window.recordStatus;
      if(cmd==='start_native_recording'){window.recordStatus={id:'native-test',mode:args.options.mode,phase:'recording',message:'原生录屏进行中',elapsedMs:0,bytesWritten:0,filePath:null,width:320,height:180,browser:'macOS 原生录屏'};window.statusEvent(window.recordStatus);return window.recordStatus;}
      if(cmd==='start_recording_session'){window.recordStatus={id:'studio-controller',controllerId:'studio-controller',mode:args.options.mode,phase:'waiting',message:'浏览器设置页已打开',filePath:null};window.statusEvent(window.recordStatus);return window.recordStatus;}
      if(cmd==='recording_control'){const phase=args.action==='stop'?'saved':args.action==='pause'?'paused':'recording';window.statusEvent({...window.recordStatus,phase,message:phase==='saved'?'录屏已保存':'录屏进行中',filePath:phase==='saved'?fixture:null});}
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(event,current){listeners.get(event)?.delete(current);callbacks.delete(current);}};
  window.statusEvent=update=>{window.recordStatus=update;for(const current of listeners.get('recording-status')||[])callbacks.get(current)?.({payload:update});};
},{fixture,directory});
try{
  console.log('Opening app'); await page.goto('http://127.0.0.1:1420');
  await page.getByRole('button',{name:'使用帮助',exact:true}).click();await page.getByRole('region',{name:'使用帮助'}).waitFor();
  await page.getByRole('button',{name:'收起帮助',exact:true}).click();
  await page.getByRole('button',{name:'视频制作',exact:true}).click();
  const editor=page.frameLocator('iframe[title="视频制作"]');
  console.log('Opening editor'); await editor.locator('#mediaStatus').getByText('媒体组件已就绪').waitFor();
  console.log('Importing fixture via guided next action'); await editor.locator('#workflowNext').getByText('导入视频',{exact:true}).waitFor();await editor.locator('#workflowNext').click();await editor.locator('#assetCount').getByText('1',{exact:true}).waitFor();
  await editor.locator('#workflowNext').getByText('填写旁白文字',{exact:true}).waitFor();assert.equal(await editor.locator('#toast').getAttribute('role'),'status');await editor.locator('#workflowNext').click();
  await editor.locator('#scriptText').fill('这是整合后的中文旁白。');
  await editor.locator('#voiceProvider').selectOption('local');
  console.log('Generating narration via next action');await editor.locator('#workflowNext').getByText('生成语音',{exact:true}).waitFor();await editor.locator('#workflowNext').click();await editor.locator('#versionCount').getByText('1',{exact:true}).waitFor({timeout:30000});
  console.log('Rendering video via next action');await editor.locator('#workflowNext').getByText('合成音视频',{exact:true}).waitFor();await editor.locator('#workflowNext').click();await editor.locator('.queue-item').waitFor({timeout:60000});
  await editor.locator('#projectSaveStatus').getByText('已自动保存',{exact:true}).waitFor();
  const dialogsBefore=await page.evaluate(()=>window.calls.filter(item=>item.cmd==='plugin:dialog|open'||item.cmd==='plugin:dialog|save').length);
  await editor.locator('#saveProjectBtn').click();await editor.locator('#toast').getByText('项目已保存',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.filter(item=>item.cmd==='plugin:dialog|open'||item.cmd==='plugin:dialog|save').length),dialogsBefore,'Ordinary project save must not open a Save As dialog');
  await editor.locator('#assetList .item-meta').first().click();
  await editor.locator('#scriptText').fill('这是整合后的中文旁白，已经修改。');
  await editor.locator('#workflowNext').getByText('重新生成语音',{exact:true}).waitFor();await editor.locator('#workflowNext').click();
  await editor.locator('#workflowNext').getByText('更新合成视频',{exact:true}).waitFor({timeout:30000});await editor.locator('#workflowNext').click();
  await editor.locator('#toast').getByText('合成视频已覆盖并加入音视频合并列表').waitFor({timeout:60000});
  assert.equal(await editor.locator('.queue-item').count(),1);
  assert.notEqual(await editor.locator('.merge-panel').evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(251, 252, 254)');
  await page.screenshot({path:join(directory,`视频制作-${process.env.TEST_BROWSER||'chromium'}.png`)});
  await page.setViewportSize({width:960,height:720});
  await page.screenshot({path:join(directory,`视频制作-960-${process.env.TEST_BROWSER||'chromium'}.png`)});
  await page.getByRole('button',{name:'截图',exact:true}).click();await page.getByRole('button',{name:'开始截图',exact:true}).waitFor();
  await page.screenshot({path:join(directory,`截图-960-${process.env.TEST_BROWSER||'chromium'}.png`),fullPage:true});
  await page.getByRole('button',{name:'录屏',exact:true}).click();await page.getByRole('button',{name:'开始录屏',exact:true}).waitFor();
  const startBox=await page.getByRole('button',{name:'开始录屏',exact:true}).boundingBox();assert.ok(startBox.y+startBox.height<=720,'Start recording must be visible at the default window size');
  await page.screenshot({path:join(directory,`录屏-960-${process.env.TEST_BROWSER||'chromium'}.png`),fullPage:true});
  await page.setViewportSize({width:1440,height:940});
  await page.getByRole('button',{name:'视频制作',exact:true}).click();assert.equal(await editor.locator('#scriptText').inputValue(),'这是整合后的中文旁白，已经修改。');
  await page.getByRole('button',{name:'全屏 / 退出全屏',exact:true}).click();
  const before=await page.evaluate(()=>window.calls.length);
  await editor.locator('#recordBtn').click();
  await page.waitForFunction(()=>window.calls.some(item=>item.cmd==='start_recording_session'));
  assert.equal(await page.locator('.mode-tabs button.selected').getAttribute('aria-label'),'视频制作');
  assert.equal(await page.evaluate(()=>window.studioFullscreen),true);
  const calls=await page.evaluate(before=>window.calls.slice(before),before);const session=calls.find(item=>item.cmd==='start_recording_session');
  assert.equal(session.args.options.mode,'window');assert.match(session.args.path,/\/projects\/合成视频-.*\/assets\/recording-test.mp4$/);
  assert.equal(calls.filter(item=>['switch_workspace','toggle_studio_fullscreen','plugin:dialog|save','start_native_recording'].includes(item.cmd)).length,0);
  await page.evaluate(fixture=>window.statusEvent({...window.recordStatus,phase:'saved',filePath:fixture}),fixture);
  await editor.locator('#assetCount').getByText('2',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',browser:process.env.TEST_BROWSER||'chromium',directory,cases:['in-app usage help','guided import/voice/render and changed-script regeneration','save without Save As dialog','default-window primary action visibility','same-window editor','real import/voice/render','regenerate overwrites','workspace switch keeps state','studio opens browser directly, keeps fullscreen and project path','recording handed to editor']}));
}catch(error){console.error('UI error:',error);console.error('Body:',await page.locator('body').innerText());console.error('Errors:',errors);await page.screenshot({path:join(directory,'failure.png')});throw error;}finally{await browser.close();lines.close();child.stdin.end();child.kill();}
