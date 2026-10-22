// Real Rust session server + browser WebSocket/MediaRecorder. No desktop capture.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'ScreenShot-recording-lifecycle-'));
const options = { mode:'tab', fps:30, audio:false, originalResolution:false };
const child = spawn(join(root,'src-tauri/target/debug/examples/recording_harness'),[join(directory,'initial.mp4'),JSON.stringify(options)],{stdio:['pipe','pipe','pipe']});
let stderr = '', ready;
child.stderr.on('data', bytes => stderr += bytes);
const pending = [], lines = createInterface({input:child.stdout});
const initial = new Promise(resolve => { ready = resolve; });
lines.on('line', line => { const value = JSON.parse(line); if (ready) { ready(value); ready = null; } else pending.shift()?.(value); });
const command = value => Promise.race([
  new Promise(resolve => { pending.push(resolve); child.stdin.write((typeof value==='string'?value:JSON.stringify(value))+'\n'); }),
  new Promise((_,reject) => { const timer=setTimeout(()=>reject(Error('Harness timeout: '+stderr)),8000);timer.unref(); }),
]);
const prepare = name => command({path:join(directory,name+'.mp4'),options});
const config = async url => { const response=await fetch(new URL('config',url),{signal:AbortSignal.timeout(3000)});assert.equal(response.status,200);return response.json(); };
const waitPhase = async (url, phase) => {
  const until=Date.now()+5000;
  while(Date.now()<until){const value=(await config(url)).status;if(value.phase===phase)return value;await new Promise(resolve=>setTimeout(resolve,40));}
  throw Error('Did not reach '+phase+': '+JSON.stringify(await config(url)));
};
const cpuMs = () => {
  if(process.platform==='win32') return null;
  const value=execFileSync('/bin/ps',['-o','time=','-p',String(child.pid)],{encoding:'utf8'}).trim().split(':').map(Number);
  return value.reduce((total,part)=>total*60+part,0)*1000;
};
const browser=await chromium.launch();
const context=await browser.newContext();
await context.addInitScript(()=>{
  if(!navigator.mediaDevices) return;
  navigator.mediaDevices.getDisplayMedia=async()=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
    const ctx=canvas.getContext('2d');let tick=0;
    const paint=()=>{ctx.fillStyle='#1645d1';ctx.fillRect(0,0,640,360);ctx.fillStyle='#19b34a';ctx.fillRect(tick++%200,0,200,360);};
    paint();const timer=setInterval(paint,50);const stream=canvas.captureStream(20),track=stream.getVideoTracks()[0];
    const original=track.getSettings.bind(track);track.getSettings=()=>({...original(),displaySurface:'browser'});
    track.addEventListener('ended',()=>clearInterval(timer));return stream;
  };
});
const errors=[];
context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
let page=await context.newPage();
page.setDefaultTimeout(6000);
try {
  const first=await initial;
  await page.goto(first.url);await page.waitForFunction(()=>!document.getElementById('choose').disabled);
  const before=cpuMs();await page.waitForTimeout(1500);const idleCpuMs=before===null?null:cpuMs()-before;
  if(idleCpuMs!==null) assert.ok(idleCpuMs<400,`Idle controller consumed ${idleCpuMs} ms CPU in 1500 ms (busy loop)`);
  const second=await prepare('replacement');assert.equal(second.ok,true,JSON.stringify(second));assert.equal(second.reusedController,true);
  await page.waitForURL(second.url);await page.waitForFunction(()=>!document.getElementById('choose').disabled);
  assert.equal(context.pages().length,1);assert.notEqual(first.status.id,second.status.id);
  const stale=await fetch(new URL('control',second.url),{method:'POST',headers:{'X-Recording-Id':first.status.id},body:JSON.stringify({action:'stop'})});
  assert.equal(stale.status,409);
  await page.locator('#choose').click();const recording=await waitPhase(second.url,'recording');
  assert.equal(recording.controllerId,second.status.controllerId);
  const refused=await prepare('must-not-replace');assert.equal(refused.ok,false);assert.match(refused.error,/正在录屏/);
  assert.equal((await config(second.url)).status.id,recording.id);
  // Opening the same URL again must not report an initialization error into the
  // original live recording and stop it.
  const duplicate=await context.newPage();await duplicate.goto(second.url);
  await duplicate.locator('#notice').getByText(/已在其他页面开始/).waitFor();
  assert.equal((await config(second.url)).status.phase,'recording');await duplicate.close();
  await page.waitForTimeout(1200);await command('stop');
  const saved=await waitPhase(second.url,'saved');const savedBytes=await readFile(saved.filePath);
  assert.ok(savedBytes.length>1000);
  execFileSync(join(root,'src-tauri/studio/node_modules/ffmpeg-static',process.platform==='win32'?'ffmpeg.exe':'ffmpeg'),['-v','error','-xerror','-i',saved.filePath,'-map','0:v:0','-fps_mode','passthrough','-enc_time_base:v','-1','-f','null','-'],{stdio:'pipe'});
  const third=await prepare('closed-settings');assert.equal(third.ok,true);assert.equal(third.reusedController,true);
  await page.waitForURL(third.url);await page.waitForFunction(()=>!document.getElementById('choose').disabled);await page.close();
  await waitPhase(third.url,'error');
  const fourth=await prepare('cancel-selection');assert.equal(fourth.ok,true);assert.equal(fourth.reusedController,false);
  const selecting=await fetch(new URL('selecting',fourth.url),{method:'POST',headers:{'X-Recording-Id':fourth.status.id},body:'{}'});assert.equal(selecting.status,200);
  const stopAt=Date.now();await command('stop');await waitPhase(fourth.url,'cancelled');const cancelMs=Date.now()-stopAt;assert.ok(cancelMs<1500);
  const sixth=await command({path:join(directory,'failed-native-setup.mp4'),options:{...options,mode:'window'}});assert.equal(sixth.ok,true);
  page=await context.newPage();
  await page.route('**/config',async route=>{const response=await route.fetch();const data=await response.json();data.nativeCapture=true;await route.fulfill({response,json:data});});
  await page.goto(sixth.url);await page.locator('#notice').getByText(/不支持本机来源选择/).waitFor();await waitPhase(sixth.url,'error');
  const final=await prepare('ready-again');assert.equal(final.ok,true,JSON.stringify(final));
  assert.deepEqual(await readFile(saved.filePath),savedBytes);assert.deepEqual(errors,[]);
  const result={result:'PASS',directory,idleCpuMs,cancelMs,sameWindowReuse:true,activeRecordingProtected:true,duplicatePageSafe:true,closedControllerReleased:true,setupFailureReleased:true,savedVideoDecoded:true};
  await writeFile(join(directory,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {
  await browser.close();child.stdin.end('quit\n');lines.close();
  await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);
  if(child.exitCode===null)child.kill();
}
