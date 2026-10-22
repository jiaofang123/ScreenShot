// Opt-in hardware regression. Records only the owned Chrome fixture, plus brief
// desktop/region clips with that fixture covering the display. No fake media.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
assert.equal(process.env.SCREENSHOT_REAL_CAPTURE,'1','Set SCREENSHOT_REAL_CAPTURE=1 to explicitly enable real screen recording');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const helper=process.env.SCREENSHOT_NATIVE_HELPER||join(root,'src-tauri/resources/runtime/screenshot-recorder');
const ffmpeg=join(root,'src-tauri/studio/node_modules/ffmpeg-static/ffmpeg');
const directory=await mkdtemp(join(tmpdir(),'ScreenShot-real-acceptance-'));
const testingHelper=join(directory,'screenshot-recorder-qa'),systemStopFile=join(directory,'system-stop.flag');
execFileSync('/usr/bin/xcrun',['swiftc','-O','-D','SCREENSHOT_TESTING','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macosx13.0`,join(root,'src-tauri/native/Recorder.swift'),'-o',testingHelper],{stdio:'pipe'});
execFileSync('/usr/bin/codesign',['--force','--sign','-',testingHelper],{stdio:'pipe'});
const title=`NativeCapture-QA-${Date.now()}`;
const date=new Date(),day=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const workerPath=process.env.STUDIO_WORKER||join(root,'src-tauri/studio/worker.mjs');
function mediaCall(method,payload={}) {
  const result=JSON.parse(execFileSync(process.execPath,[workerPath],{encoding:'utf8',input:JSON.stringify({method,payload})+'\n'}));
  assert.equal(result.ok,true,JSON.stringify(result));return result.result;
}
const project=mediaCall('project:create',{name:'录屏路径真机验收'});
const browser=await chromium.launch({headless:false,executablePath:process.env.RECORDING_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--window-position=0,25','--window-size=1700,1050',`--auto-select-tab-capture-source-by-title=${title}`]});
let child, lines, stderr='',dockReopens=0;const results=[],responses=[];
const context=await browser.newContext({viewport:null});
const fixture=await context.newPage();
async function command(value){
  const before=responses.length;child.stdin.write((typeof value==='string'?value:JSON.stringify(value))+'\n');
  const deadline=Date.now()+25000;
  while(responses.length===before){assert.ok(child.exitCode===null&&Date.now()<deadline,'Hardware harness command timed out: '+stderr);await new Promise(resolve=>setTimeout(resolve,50));}
  return responses.at(-1);
}
async function config(url){return fetch(new URL('config',url)).then(response=>response.json());}
async function waitStatus(url,phase){
  const until=Date.now()+20000;
  while(Date.now()<until){const value=await config(url);if(value.status.phase===phase)return value.status;if(value.status.phase==='error')throw new Error(value.status.message);await new Promise(resolve=>setTimeout(resolve,100));}
  throw new Error(`Timed out waiting for ${phase}: ${JSON.stringify(await config(url))}`);
}
async function inspect(path){
  assert.ok((await stat(path)).size>1000);
  const info=spawn(ffmpeg,['-hide_banner','-xerror','-i',path,'-map','0:v:0','-map','0:a?','-fps_mode','passthrough','-enc_time_base:v','-1','-f','null','-'],{stdio:['ignore','ignore','pipe']});let log='';info.stderr.on('data',bytes=>log+=bytes);
  assert.equal(await new Promise(resolve=>info.on('close',resolve)),0,log);
  const match=log.match(/Video:.*? (\d{2,5})x(\d{2,5})(?=[\s,\[])/);assert.ok(match,log);
  const width=Number(match[1]),height=Number(match[2]);
  const rgb=execFileSync(ffmpeg,['-v','error','-ss','0.5','-i',path,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{maxBuffer:40*1024*1024});
  const pixel=x=>Array.from(rgb.subarray((Math.floor(height*.55)*width+Math.floor(width*x))*3,(Math.floor(height*.55)*width+Math.floor(width*x))*3+3));
  const left=pixel(.25),right=pixel(.75);
  assert.ok(left[1]>100&&left[1]>left[0]*1.5&&left[1]>left[2]*1.2,`Expected green fixture behind excluded controller: ${JSON.stringify({left,right})}`);
  assert.ok(right[2]>100&&right[2]>right[0]*1.5&&right[2]>right[1]*1.2,`Expected blue fixture: ${JSON.stringify({left,right})}`);
  const audioCodec=log.match(/Audio: (\w+)/)?.[1]||null;
  return {path,width,height,left,right,audio:audioCodec!==null,audioCodec,duration:log.match(/Duration: ([\d:.]+)/)?.[1]};
}
try{
  await fixture.setContent(`<title>${title}</title><style>html,body{margin:0;height:100%;background:linear-gradient(to right,#10b040 50%,#1545d0 50%);color:white;font:32px sans-serif}div{padding:100px}</style><div>Native capture verification</div><script>setInterval(()=>document.querySelector('div').textContent='Native capture verification '+Date.now(),50)</script>`);
  await fixture.bringToFront();await fixture.waitForTimeout(500);
  // Register a separate owned app bundle so `open` exercises a real macOS Dock
  // reopen event without interacting with the user's installed ScreenShot.
  const probeApp=join(directory,'ScreenShot Dock QA.app'),macos=join(probeApp,'Contents','MacOS');
  await mkdir(macos,{recursive:true});
  await copyFile(process.env.SCREENSHOT_NATIVE_HARNESS||join(root,'src-tauri/target/debug/examples/native_recording_harness'),join(macos,'native_recording_harness'));
  await writeFile(join(probeApp,'Contents','Info.plist'),`<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.screenshot.qa.dock.${Date.now()}</string><key>CFBundleExecutable</key><string>native_recording_harness</string><key>CFBundleName</key><string>ScreenShot Dock QA</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  execFileSync('/usr/bin/codesign',['--force','--sign','-',probeApp],{stdio:'pipe'});
  child=spawn(join(macos,'native_recording_harness'),[join(directory,'controller.mp4')],{stdio:['pipe','pipe','pipe'],env:{...process.env,SCREENSHOT_REAL_CAPTURE:'1',SCREENSHOT_QA_HELPER:testingHelper,SCREENSHOT_QA_SYSTEM_STOP_FILE:systemStopFile}});
  child.stderr.on('data',bytes=>stderr+=bytes);
  lines=createInterface({input:child.stdout});let first;
  const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Harness startup timed out: '+stderr)),20000);lines.on('line',line=>{try{const value=JSON.parse(line);if(value.dockReopened){dockReopens++;return;}if(value.url&&!first){first=value;clearTimeout(timer);resolve(value);}else responses.push(value);}catch{}});child.once('exit',code=>{if(!first){clearTimeout(timer);reject(Error('Harness exited '+code+': '+stderr));}});});
  const initial=await ready;
  await command('cancel');await waitStatus(initial.url,'cancelled');
  const destination=await command({destination:{projectRoot:project.rootDir,date:day}});
  assert.equal(destination.ok,true,JSON.stringify(destination));assert.equal(dirname(destination.status.path),join(project.rootDir,'assets'));
  const prepared=await command({prepare:true,path:destination.status.path,options:{mode:'window',fps:30,audio:true,originalResolution:false,browser:'chrome'}});
  assert.equal(prepared.ok,true,JSON.stringify(prepared));const {url}=prepared.status;
  const popup=context.waitForEvent('page');await fixture.evaluate(()=>window.open('about:blank','native-controller','popup,width=650,height=500,left=100,top=200'));
  const page=await popup;page.setDefaultTimeout(10000);
  const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  await page.route('**/recorder.css',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text())+'\nbody,main,.card{background:#f600aa!important}'});});
  await page.goto(url);
  await page.waitForFunction(()=>!document.getElementById('choose').disabled);
  // Live window creation/recording/control/save through the production HTTP bridge.
  for(const mode of ['window','desktop','region','tab','window']){
    await page.locator('#quality').selectOption(mode==='region'?'4k':mode==='window'&&!results.length?'1080p':'2k');
    await page.locator('#mode').selectOption(mode);
    if(mode==='window'){
      assert.equal(await page.locator('#target option').evaluateAll(options=>options.some(option=>option.textContent.includes('ScreenShot QA Exclusion'))),false);
      await page.waitForFunction(title=>[...document.getElementById('target').options].some(option=>option.textContent.includes(title)),title);
      const value=await page.locator('#target option').evaluateAll((options,title)=>options.find(option=>option.textContent.includes(title)).value,title);await page.locator('#target').selectOption(value);
    }
    if(mode==='region'){await page.locator('#select-region').click();await page.locator('#region-size').getByText(/像素/).waitFor();}
    await page.locator('#choose').click();await waitStatus(url,'recording');
    if(!results.length){
      const before=(await config(url)).status;
      const refused=await command({prepare:true,path:join(directory,'must-not-replace.mp4'),options:{mode:'tab',fps:30,audio:false,originalResolution:false,browser:'chrome'}});
      assert.equal(refused.ok,false,JSON.stringify(refused));assert.match(refused.error,/正在录屏/);
      assert.equal((await config(url)).status.id,before.id,'Opening settings must not replace a live native recorder');
    }
    await page.getByText('录制中',{exact:true}).waitFor();await page.waitForTimeout(1200);
    if(mode==='window'){
      await page.getByRole('button',{name:'暂停',exact:true}).click();await waitStatus(url,'paused');await page.waitForTimeout(600);
      await page.getByRole('button',{name:'继续录制',exact:true}).click();await waitStatus(url,'recording');await page.waitForTimeout(700);
    }
    await page.locator('#stop').click();const saved=await waitStatus(url,'saved');
    await page.getByRole('heading',{name:'视频已保存',exact:true}).waitFor();
    const result=await inspect(saved.filePath);
    assert.ok(result.width<=(mode==='region'?3840:mode==='window'&&!results.length?1920:2560));
    assert.ok(result.height<=(mode==='region'?2160:mode==='window'&&!results.length?1080:1440));
    if(mode==='desktop')assert.equal(result.height,1440,'2K desktop must encode above 1080p');
    assert.equal(dirname(saved.filePath),join(project.rootDir,'assets'));
    if(mode!=='tab')assert.equal(result.audio,true);
    assert.equal(result.audio,saved.hasAudio);
    assert.ok(!results.some(previous=>previous.path===result.path));results.push({mode,...result});
    console.log('PASS real capture:',mode,result.width,result.height,result.duration);
  }
  // Starting again from the tool replaces the session/project but keeps its page.
  const existingBytes=await readFile(results.at(-1).path),pageCount=context.pages().length,oldController=(await config(url)).status.controllerId;
  const replacement=await command({prepare:true,path:join(directory,'replacement.mp4'),options:{mode:'window',fps:30,audio:false,resolution:'2k',originalResolution:false,browser:'chrome'}});
  assert.equal(replacement.ok,true,JSON.stringify(replacement));assert.equal(replacement.status.reusedController,true);
  const nextUrl=replacement.status.url;
  await page.waitForURL(nextUrl);await page.waitForFunction(()=>!document.getElementById('choose').disabled);
  assert.equal(context.pages().length,pageCount);assert.equal(await page.locator('#quality').inputValue(),'2k');
  assert.notEqual((await config(nextUrl)).status.controllerId,oldController);
  assert.deepEqual(await readFile(results.at(-1).path),existingBytes);
  // Inject the system's stop delegate into a test-only build after real desktop
  // frames/audio arrive; this does not pretend to click the macOS toolbar.
  await page.locator('#mode').selectOption('desktop');await page.locator('#audio').check();
  await page.locator('#choose').click();await waitStatus(nextUrl,'recording');await page.waitForTimeout(1300);
  assert.equal((await command('window-state')).status.visible,false);
  await writeFile(systemStopFile,'stop');const ended=await waitStatus(nextUrl,'saved');results.push({mode:'system-stop-callback',...await inspect(ended.filePath)});
  // A hidden app must receive applicationShouldHandleReopen and restore/focus.
  assert.equal((await command('hide-main')).status.visible,false);
  execFileSync('/usr/bin/open',[probeApp]);
  const reopenDeadline=Date.now()+10000;while(!dockReopens&&Date.now()<reopenDeadline)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(dockReopens,1,'macOS did not deliver Dock reopen');
  const restored=(await command('window-state')).status;assert.equal(restored.visible,true);assert.equal(restored.minimized,false);assert.equal(restored.focused,true);
  // The main tool's command calls the same manager, not the browser controller.
  const sources=JSON.parse(execFileSync(helper,['list'],{encoding:'utf8'})).sources;
  const target=sources.find(source=>source.kind==='window'&&source.name.includes(title));assert.ok(target);
  const invalidBefore=responses.length;
  child.stdin.write(JSON.stringify({options:{mode:'window',fps:30,audio:false,originalResolution:false},source:{sourceId:4294967295},path:join(directory,'invalid.mp4')})+'\n');
  while(responses.length===invalidBefore){await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(responses.at(-1).ok,false);assert.match(responses.at(-1).error,/窗口已关闭/);
  assert.equal(page.isClosed(),true,'Superseded control window should close');
  assert.equal(await stat(join(directory,'invalid.mp4')).then(()=>true,()=>false),false);
  const daily=await command({destination:{projectRoot:null,date:day}});assert.equal(daily.ok,true,JSON.stringify(daily));
  const directPath=daily.status.path;assert.equal(dirname(directPath),join(homedir(),'screenshot',day));
  const direct=await command({options:{mode:'window',fps:30,audio:true,originalResolution:false},source:{sourceId:target.id,name:target.name,cursor:false},path:directPath});
  assert.equal(direct.ok,true,JSON.stringify(direct));assert.equal(direct.status.phase,'recording');
  await new Promise(resolve=>setTimeout(resolve,1700));child.stdin.write('stop\n');
  for(let tries=0;tries<100;tries++){if(await stat(directPath).catch(()=>null))break;await new Promise(resolve=>setTimeout(resolve,100));}
  results.push({mode:'direct-main-command',...await inspect(directPath)});
  project.assets=mediaCall('project:importVideos',{projectRoot:project.rootDir,paths:results.slice(0,5).map(result=>result.path),recording:true});
  assert.deepEqual(project.assets.map(asset=>asset.path),results.slice(0,5).map(result=>result.path));
  mediaCall('project:save',project);
  // Snapshot backing pixels must match the display dimensions used by region selection.
  const display=sources.find(source=>source.kind==='desktop');const snapshot=join(directory,'desktop-selection.png');
  execFileSync(helper,['snapshot',String(display.id),snapshot,String(child.pid)]);
  const png=await readFile(snapshot);assert.equal(png.readUInt32BE(16),display.width);assert.equal(png.readUInt32BE(20),display.height);
  assert.deepEqual(pageErrors,[]);
  const report={result:'PASS',directory,projectRoot:project.rootDir,results,dockReopens,controllerReused:true,snapshot:{width:display.width,height:display.height}};
  await writeFile(join(directory,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){console.error('Native hardware test failed:',error,'\n',stderr);throw error;}
finally{
  if(child){child.stdin.end('quit\n');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,18000))]);if(child.exitCode===null)child.kill();}
  lines?.close();await browser.close();
}
