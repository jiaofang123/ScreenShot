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
      if(cmd==='native_recording_available')return true;
      if(cmd==='native_capture_sources')return [{id:1,kind:'desktop',name:'测试桌面',width:640,height:360},{id:2,kind:'window',name:'测试应用窗口',width:640,height:360}];
      if(cmd==='native_source_preview')return 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#32597d"/></svg>');
      if(cmd==='get_recording_status')return window.recordStatus;
      if(cmd==='start_native_recording'){window.recordStatus={id:'native-test',mode:args.options.mode,phase:'recording',message:'原生录屏进行中',elapsedMs:0,bytesWritten:0,filePath:null,width:320,height:180,browser:'macOS 原生录屏'};window.statusEvent(window.recordStatus);return window.recordStatus;}
      if(cmd==='recording_control'){const phase=args.action==='stop'?'saved':args.action==='pause'?'paused':'recording';window.statusEvent({...window.recordStatus,phase,message:phase==='saved'?'录屏已保存':'录屏进行中',filePath:phase==='saved'?fixture:null});}
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(event,current){listeners.get(event)?.delete(current);callbacks.delete(current);}};
  window.statusEvent=update=>{window.recordStatus=update;for(const current of listeners.get('recording-status')||[])callbacks.get(current)?.({payload:update});};
},{fixture,directory});
try{
  console.log('Opening app'); await page.goto('http://127.0.0.1:1420');
  await page.getByRole('button',{name:'视频制作',exact:true}).click();
  const editor=page.frameLocator('iframe[title="视频制作"]');
  console.log('Opening editor'); await editor.locator('#mediaStatus').getByText('媒体组件已就绪').waitFor();
  console.log('Importing fixture'); await editor.locator('#importBtn').click();await editor.locator('#assetCount').getByText('1',{exact:true}).waitFor();
  await editor.locator('#scriptText').fill('这是整合后的中文旁白。');
  await editor.locator('#voiceProvider').selectOption('local');
  console.log('Generating narration'); await editor.locator('#generateVoiceBtn').click();await editor.locator('#versionCount').getByText('1',{exact:true}).waitFor({timeout:30000});
  console.log('Rendering video'); await editor.locator('#synthesizeBtn').click();await editor.locator('.queue-item').waitFor({timeout:60000});
  await editor.locator('#assetList .item-meta').first().click();
  await editor.locator('#synthesizeBtn').click();await editor.locator('#toast').getByText('合成视频已覆盖并加入音视频合并列表').waitFor({timeout:60000});
  assert.equal(await editor.locator('.queue-item').count(),1);
  assert.notEqual(await editor.locator('.merge-panel').evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(251, 252, 254)');
  await page.screenshot({path:join(directory,`视频制作-${process.env.TEST_BROWSER||'chromium'}.png`)});
  await page.getByRole('button',{name:'截图',exact:true}).click();await page.getByRole('button',{name:'开始截图',exact:true}).waitFor();
  await page.getByRole('button',{name:'视频制作',exact:true}).click();assert.equal(await editor.locator('#scriptText').inputValue(),'这是整合后的中文旁白。');
  await editor.locator('#recordBtn').click();await page.getByRole('radio',{name:/框选区域/}).check();
  const stage=page.locator('.native-region-stage');await stage.waitFor();const box=await stage.boundingBox();
  await page.mouse.move(box.x+box.width*.1,box.y+box.height*.2);await page.mouse.down();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.8);await page.mouse.up();
  const corner=await page.locator('.region-handle.nw').boundingBox();
  await page.mouse.move(corner.x+7,corner.y+7);await page.mouse.down();await page.mouse.move(corner.x+7+box.width*.02,corner.y+7);await page.mouse.up();
  await page.getByRole('button',{name:'开始录屏',exact:true}).click();await page.getByText('原生录屏进行中',{exact:true}).waitFor({timeout:10000});
  const calls=await page.evaluate(()=>window.calls);const nativeCall=calls.find(item=>item.cmd==='start_native_recording');
  assert.equal(nativeCall.args.options.mode,'region');assert.ok(Math.abs(nativeCall.args.source.crop.width-.48)<.01);
  assert.equal(calls.filter(item=>item.cmd==='start_recording_session').length,0);
  await page.getByRole('button',{name:'停止并保存',exact:true}).click();
  await editor.locator('#assetCount').getByText('2',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',browser:process.env.TEST_BROWSER||'chromium',directory,cases:['same-window editor','real import/voice/render','regenerate overwrites','workspace switch keeps state','native region selection','recording handed to editor']}));
}catch(error){console.error('UI error:',error);console.error('Body:',await page.locator('body').innerText());console.error('Errors:',errors);await page.screenshot({path:join(directory,'failure.png')});throw error;}finally{await browser.close();lines.close();child.stdin.end();child.kill();}
