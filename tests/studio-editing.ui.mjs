// Real editor + media worker + generated fixtures. Window/dialog IPC is mocked;
// pointer sorting, speech deletion and FFmpeg exports execute production code.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const {chromium,webkit}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'ScreenShot-editing-ui-'));
const ffmpeg=process.env.STUDIO_FFMPEG||join(root,'src-tauri/studio/node_modules/ffmpeg-static/ffmpeg');
const worker=spawn(process.execPath,[process.env.STUDIO_WORKER||join(root,'src-tauri/studio/worker.mjs')],{stdio:['pipe','pipe','inherit'],env:{...process.env,SCREENSHOT_STUDIO_WORKSPACE:directory}});
const pending=[],lines=createInterface({input:worker.stdout});
lines.on('line',line=>{const value=JSON.parse(line),next=pending.shift();value.ok?next.resolve(value.result):next.reject(Error(value.error));});
const call=(method,payload={})=>new Promise((resolve,reject)=>{pending.push({resolve,reject});worker.stdin.write(JSON.stringify({method,payload})+'\n');});
const run=args=>execFileSync(ffmpeg,['-v','error','-xerror',...args],{maxBuffer:40*1024*1024});
const project=await call('project:create',{name:'编辑交互验收'});
const colors=['red','green','blue','yellow','cyan','magenta','white','black'];
for(const [i,color] of colors.entries()){
  const file=join(directory,`fixture-${i+1}.mp4`);
  run(['-f','lavfi','-i',`color=${color}:s=320x180:r=15:d=3`,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',file]);
  const [asset]=await call('project:importVideos',{projectRoot:project.rootDir,paths:[file]});
  asset.id=`a${i+1}`;asset.name=`素材 ${i+1}`;asset.duration=3;asset.segmentsInitialized=true;asset.segments=[];
  const path=join(project.rootDir,'renders',`r${i+1}.mp4`);await copyFile(file,path);
  asset.renderVersions=[{id:`r${i+1}`,path,assetId:asset.id,createdAt:new Date(2026,9,21,1,0,i).toISOString()}];
  project.assets.push(asset);
}
const voiceFiles=[];
for(let i=1;i<=2;i++){
  const path=join(project.rootDir,'voices',`s${i}`);await mkdir(path);
  const audio=join(path,`v${i}.wav`),text=join(path,`v${i}.txt`);
  run(['-f','lavfi','-i','sine=frequency=440:duration=2','-c:a','pcm_s16le',audio]);await writeFile(text,`文字稿 ${i}`);
  if(i===1){await writeFile(join(path,'v1.aiff'),'intermediate');await copyFile(audio,join(path,'v1.preview.wav'));}
  voiceFiles.push(audio,text);
  project.assets[0].segments.push({id:`s${i}`,title:`文字稿 ${i}`,text:`旁白 ${i}`,start:i-1,end:i,speed:'normal',activeVoiceId:`v${i}`,voiceVersions:[{id:`v${i}`,path:audio,textPath:text,duration:.8}]});
}
project.mergeQueue=project.assets.slice(0,3).map(asset=>({...asset.renderVersions[0],label:asset.name}));
await call('project:save',project);
const browser=await(process.env.TEST_BROWSER==='webkit'?webkit:chromium).launch();
const page=await browser.newPage({viewport:{width:1440,height:940}});page.setDefaultTimeout(10000);
const errors=[],calls=[];let slowSave=false,lastMerge=null,dismissNext=false;
page.on('pageerror',error=>errors.push(error.message));
page.on('dialog',dialog=>{if(dismissNext){dismissNext=false;void dialog.dismiss();}else void dialog.accept();});
await page.exposeFunction('mediaCall',async({method,payload})=>{
  calls.push({method,payload});const result=await call(method,payload);
  if(method==='media:mergeVideos')lastMerge=result;
  if(method==='project:save'&&slowSave)await new Promise(resolve=>setTimeout(resolve,600));
  return result;
});
await page.route('**/__test_media/**',async route=>{
  const file=decodeURIComponent(new URL(route.request().url()).pathname.split('/__test_media/')[1]);
  const bytes=await readFile(file),range=route.request().headers().range;
  const mime=file.endsWith('.wav')?'audio/wav':'video/mp4';
  if(range){const match=range.match(/bytes=(\d+)-(\d*)/),start=Number(match[1]),end=Math.min(bytes.length-1,match[2]?Number(match[2]):bytes.length-1);
    await route.fulfill({status:206,headers:{'Content-Type':mime,'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${bytes.length}`},body:bytes.subarray(start,end+1)});
  }else await route.fulfill({contentType:mime,body:bytes});
});
await page.addInitScript(projectRoot=>{
  window.audioEvents=[];
  const OriginalAudio=window.Audio;
  window.Audio=function(...args){const audio=new OriginalAudio(...args);for(const name of ['loadstart','loadedmetadata','playing','pause','ended','error','emptied'])audio.addEventListener(name,()=>window.audioEvents.push({name,src:audio.src,time:audio.currentTime,error:audio.error?.code,message:audio.error?.message}));return audio;};
  localStorage.setItem('screenshot-studio-last-project',projectRoot);
  let next=1;const callbacks=new Map();
  window.__TAURI_INTERNALS__={transformCallback(fn){const id=next++;callbacks.set(id,fn);return id;},unregisterCallback(id){callbacks.delete(id);},
    convertFileSrc(file){return `http://127.0.0.1:1420/__test_media/${encodeURIComponent(file)}`;},
    async invoke(cmd,args={}){if(cmd==='studio_call')return window.mediaCall(args);if(cmd==='default_shortcut')return 'CommandOrControl+Shift+X';if(cmd==='plugin:event|listen')return args.handler;}
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
},project.rootDir);
let editor;
async function open(){await page.goto('http://127.0.0.1:1420');await page.getByRole('button',{name:'视频制作',exact:true}).click();editor=page.frameLocator('iframe[title="视频制作"]');await editor.locator('[data-asset-id="a1"]').waitFor();}
const saved=async()=>JSON.parse(await readFile(join(project.rootDir,'project.json'),'utf8'));
async function waitSaved(predicate){const end=Date.now()+20000;while(Date.now()<end){const data=await saved();if(predicate(data))return data;await page.waitForTimeout(80);}throw Error('Saved project did not match expected state: '+JSON.stringify(await saved()));}
const assetOrder=()=>editor.locator('[data-asset-id]').evaluateAll(cards=>cards.map(card=>card.dataset.assetId));
const queueOrder=()=>editor.locator('[data-queue-id]').evaluateAll(cards=>cards.map(card=>card.dataset.queueId));
const numbers=()=>editor.locator('[data-queue-id]').evaluateAll(cards=>Object.fromEntries(cards.map(card=>[card.dataset.queueId,card.querySelector('.queue-number').textContent])));
async function drag(source,target,after=false){
  await source.scrollIntoViewIfNeeded();const a=await source.boundingBox(),b=await target.boundingBox();
  await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();
  await page.mouse.move(a.x+a.width/2,a.y+a.height/2+8);
  await page.mouse.move(b.x+b.width/2,after?b.y+b.height-2:b.y+2,{steps:3});
  await editor.locator('.sort-placeholder').waitFor();await page.mouse.up();
  await editor.locator('.sort-placeholder').waitFor({state:'detached'});
}
async function dragToTop(source,container){
  await source.scrollIntoViewIfNeeded();const a=await source.boundingBox(),b=await container.boundingBox();
  await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();
  await page.mouse.move(a.x+a.width/2,a.y+a.height/2+8);
  await page.mouse.move(b.x+b.width/2,b.y+2,{steps:3});await page.waitForTimeout(1600);await page.mouse.up();
}
const decode=path=>run(['-i',path,'-map','0:v:0','-map','0:a?','-fps_mode','passthrough','-enc_time_base:v','-1','-f','null','-']);
function pixel(path,time,x=.5,y=.5){return [...run(['-ss',String(time),'-i',path,'-frames:v','1','-vf',`crop=2:2:iw*${x}:ih*${y}`,'-pix_fmt','rgb24','-f','rawvideo','pipe:1']).subarray(0,3)];}
try{
  await open();await waitSaved(data=>data.assets.every(asset=>asset.renderVersions[0].displayNumber));
  const originalNumbers=await numbers();
  await drag(editor.locator('[data-asset-id="a1"] [data-sort-handle]'),editor.locator('[data-asset-id="a3"]'),true);
  await waitSaved(data=>data.assets.slice(0,3).map(asset=>asset.id).join(',')==='a2,a3,a1');
  assert.equal(await editor.locator('[data-asset-id].active').getAttribute('data-asset-id'),'a1');
  const beforeCancel=await assetOrder(),source=editor.locator('[data-asset-id="a2"] [data-sort-handle]');
  const box=await source.boundingBox();await page.mouse.move(box.x+10,box.y+10);await page.mouse.down();await page.mouse.move(box.x+10,box.y+100);
  await editor.locator('.sort-placeholder').waitFor();await page.keyboard.press('Escape');await page.mouse.up();assert.deepEqual(await assetOrder(),beforeCancel);
  await dragToTop(editor.locator('[data-asset-id="a8"] [data-sort-handle]'),editor.locator('#assetList'));
  await waitSaved(data=>data.assets[0].id==='a8');
  slowSave=true;
  await editor.locator('[data-asset-title-id="a1"]').fill('重命名素材 A');await page.waitForTimeout(320);
  const keyOrder=await assetOrder(),keyIndex=keyOrder.indexOf('a2');[keyOrder[keyIndex],keyOrder[keyIndex+1]]=[keyOrder[keyIndex+1],keyOrder[keyIndex]];
  await editor.locator('[data-asset-id="a2"] [data-sort-handle]').press('ArrowDown');
  assert.deepEqual(await assetOrder(),keyOrder);
  const renamedOrder=await assetOrder();await waitSaved(data=>data.assets.map(asset=>asset.id).join(',')===renamedOrder.join(',')&&data.assets.find(asset=>asset.id==='a1').name==='重命名素材 A');
  await page.waitForTimeout(700);assert.equal(await editor.locator('[data-asset-title-id="a1"]').inputValue(),'重命名素材 A');slowSave=false;
  console.log('PASS: asset quick pointer sorting, cancel, autoscroll, keyboard, selection retained, delayed save keeps newer edits');
  await dragToTop(editor.locator('[data-queue-id="r8"] [data-sort-handle]'),editor.locator('#mergeQueue'));
  await waitSaved(data=>data.renderOrder?.[0]==='r8');
  assert.equal(await editor.locator('[data-merge-render-id="r8"]').isChecked(),false);
  await editor.locator('[data-merge-render-id="r8"]').check();
  await editor.locator('[data-merge-render-id="r1"]').uncheck();await editor.locator('[data-merge-render-id="r3"]').uncheck();
  await drag(editor.locator('[data-queue-id="r2"] .item-meta'),editor.locator('[data-queue-id="r8"]'));
  await waitSaved(data=>data.mergeQueue.map(item=>item.id).join(',')==='r2,r8');
  assert.deepEqual(await numbers(),originalNumbers);
  const ordered=await queueOrder();await open();assert.deepEqual(await queueOrder(),ordered);assert.deepEqual(await numbers(),originalNumbers);
  await editor.locator('#mergePreviewBtn').click();await editor.locator('#toast').getByText('合并预览已生成').waitFor({timeout:60000});
  assert.deepEqual(calls.findLast(call=>call.method==='media:mergeVideos').payload.items.map(item=>item.id),['r2','r8']);
  decode(lastMerge.path);const green=pixel(lastMerge.path,.5),black=pixel(lastMerge.path,3.5);
  assert.ok(green[1]>80&&green[0]<20);assert.ok(black.every(value=>value<20));
  console.log('PASS: full-card merge drag, unchecked-card sorting, fixed IDs through reload, real merge matches visual selected order');
  await editor.locator('[data-asset-id="a1"] .item-meta').click();
  const frame=page.frames().find(frame=>frame.url().endsWith('/studio/index.html'));
  await frame.waitForFunction(()=>document.getElementById('videoPreview').readyState>=2&&document.getElementById('videoPreview').duration===3);
  await editor.locator('#insertTextBtn').click();await editor.locator('.text-overlay-content').fill('时间设置验证');
  await editor.locator('#textDuration').fill('0.7');await editor.locator('#textDuration').press('Tab');
  await editor.locator('#textStartTime').fill('1.2');await editor.locator('#textStartTime').press('Tab');
  await waitSaved(data=>data.assets.find(asset=>asset.id==='a1').textOverlays?.[0]?.end===1.9);
  await editor.locator('#textStartTime').fill('2.8');await editor.locator('#textStartTime').press('Tab');await page.waitForTimeout(300);
  assert.equal((await saved()).assets.find(asset=>asset.id==='a1').textOverlays[0].start,1.2);
  await editor.locator('#textStartTime').fill('1.5');await editor.locator('#textStartTime').press('Tab');
  await editor.locator('#textDuration').fill('1');await editor.locator('#textDuration').press('Tab');
  await waitSaved(data=>data.assets.find(asset=>asset.id==='a1').textOverlays?.[0]?.end===2.5);
  assert.equal((await saved()).assets.find(asset=>asset.id==='a1').textOverlays[0].text,'时间设置验证');
  await editor.locator('#videoPreview').evaluate(video=>{video.currentTime=.5;});await page.waitForTimeout(200);
  assert.equal(await editor.locator('.text-overlay-box').count(),0);assert.equal(await editor.locator('#textTimingPanel').isVisible(),true);
  await editor.locator('[data-text-overlay-list-id]').click();await editor.locator('.text-overlay-box').waitFor();
  await page.screenshot({path:join(directory,`editing-${process.env.TEST_BROWSER||'chromium'}.png`)});
  await editor.locator('#synthesizeBtn').click();await editor.locator('#toast').getByText('合成视频已覆盖并加入音视频合并列表').waitFor({timeout:60000});
  const rendered=(await saved()).assets.find(asset=>asset.id==='a1').renderVersions[0];
  assert.equal(rendered.id,'r1');assert.equal(rendered.displayNumber,Number(originalNumbers.r1.replace('.','')));decode(rendered.path);
  const before=pixel(rendered.path,.5,.39,.23),during=pixel(rendered.path,2,.39,.23),after=pixel(rendered.path,2.8,.39,.23);
  assert.ok(before[0]>220&&after[0]>220&&during[0]<before[0]*.8,JSON.stringify({before,during,after}));
  assert.ok(pixel(rendered.path,1.5,.39,.23)[0]<before[0]*.8);assert.ok(pixel(rendered.path,2.5,.39,.23)[0]>220);
  console.log('PASS: text start/duration edit, invalid range rejected, timing inspector outside visible interval, real export appears only at 1.5–2.5s, regeneration keeps ID/number');
  await editor.locator('[data-asset-id="a1"] .item-meta').click();
  dismissNext=true;await editor.locator('[data-delete-segment-id="s1"]').click();assert.ok((await stat(voiceFiles[0])).isFile());
  await editor.locator('[data-segment-title-id="s1"]').fill('删除中的卡片');
  await editor.locator('#previewVoiceBtn').click();
  await editor.getByRole('button',{name:'停止',exact:true}).waitFor({timeout:5000});
  await frame.waitForFunction(()=>window.audioEvents.some(event=>event.name==='playing'));
  await editor.locator('[data-delete-segment-id="s1"]').click();await editor.locator('[data-segment-id="s1"]').waitFor({state:'detached'});
  await editor.locator('#versionCount').getByText('1',{exact:true}).waitFor();
  await frame.waitForFunction(()=>window.audioEvents.some(event=>event.name==='emptied'));
  for(const path of voiceFiles.slice(0,2))assert.equal(await stat(path).then(()=>true,()=>false),false);
  for(const path of voiceFiles.slice(2))assert.equal(await stat(path).then(()=>true,()=>false),true);
  await editor.locator('[data-delete-segment-id="s2"]').click();await editor.locator('#segmentList .segment-list-item').waitFor({state:'detached'});
  assert.equal(await editor.locator('#scriptText').isDisabled(),true);
  await open();await editor.locator('[data-asset-id="a1"] .item-meta').click();assert.equal(await editor.locator('#segmentList .segment-list-item').count(),0);
  await editor.locator('#addSegmentBtn').click();await editor.locator('#segmentList .segment-list-item').waitFor();assert.equal(await editor.locator('#scriptText').isEnabled(),true);
  assert.deepEqual(errors,[]);
  const report={result:'PASS',browser:process.env.TEST_BROWSER||'chromium',directory,projectRoot:project.rootDir,render:rendered.path,merge:lastMerge.path,cases:['asset/merge pointer and keyboard sorting','autoscroll and cancel','stable numbers and reload','async save race','real speech file deletion while playing','delete last card and explicit add','text timing preview/export and exact endpoints','overwrite existing render']};
  await writeFile(join(directory,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await page.screenshot({path:join(directory,'failure.png')});console.error({directory,errors});throw error;}
finally{await browser.close();worker.stdin.end();lines.close();worker.kill();}
