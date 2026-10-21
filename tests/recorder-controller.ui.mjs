// Real controller assets with mocked native capture and WebSocket status. No desktop is read.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assets = new URL('../src-tauri/recorder/', import.meta.url);
const options = { mode:'window',fps:30,audio:false,originalResolution:false,browser:'chrome' };
let status = {id:'first',controllerId:'controller',options,mode:'window',phase:'waiting',message:'等待选择',elapsedMs:0,bytesWritten:0,filePath:null,width:0,height:0};
let round = 0, regionCancelled = true, page;
const requests = [], errors = [];
const server = createServer(async (request,response) => {
  const route = request.url.slice(1);
  if (['','index.html','recorder.js','recorder.css'].includes(route)) {
    response.setHeader('Content-Type',route.endsWith('.js')?'text/javascript':route.endsWith('.css')?'text/css':'text/html');
    response.end(await readFile(new URL(route || 'index.html',assets))); return;
  }
  const reply = data => { response.setHeader('Content-Type','application/json');response.end(JSON.stringify(data)); };
  if(route === 'config') { reply({options:status.options,status,nativeCapture:true,webSocketUrl:'ws://127.0.0.1/fake',preferredFormat:'mp4'});return; }
  let text='';for await (const bytes of request) text+=bytes;
  const data=JSON.parse(text||'{}');requests.push({route,data,id:request.headers['x-recording-id']});
  assert.equal(request.headers['x-recording-id'],status.id);
  if(route === 'native-sources') reply([{id:10,kind:'window',name:'测试应用窗口',width:800,height:600},{id:20,kind:'desktop',name:'测试显示器',width:1920,height:1080}]);
  else if(route === 'restart') { status={...status,id:`round-${++round}`,mode:data.mode,options:data,phase:'waiting',filePath:null};reply({status}); }
  else if(route === 'native-region') { reply(regionCancelled ? null : {crop:{x:.1,y:.2,width:.5,height:.4},width:960,height:432});regionCancelled=false; }
  else if(route === 'native-begin') {
    status={...status,phase:'recording',message:'本机录制中',width:800,height:600};reply({status,command:'resume'});
    setTimeout(()=>{void page.evaluate(status=>window.nativeEvent({status,command:'resume'}),status);},20);
  } else if(route === 'control') {
    status={...status,phase:data.action==='stop'?'saved':data.action==='pause'?'paused':'recording',filePath:data.action==='stop'?`/tmp/${status.id}.mp4`:null};reply({status,command:data.action});
  } else { response.statusCode=400;reply({error:'Unexpected route: '+route}); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await (process.env.TEST_BROWSER==='webkit'?webkit:chromium).launch();
page=await browser.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
await page.addInitScript(()=>{
  window.browserCaptureCalls=0;
  window.closedControllers=0;window.close=()=>window.closedControllers++;
  navigator.mediaDevices.getDisplayMedia=async()=>{window.browserCaptureCalls++;throw new Error('Native modes must not use browser desktop capture');};
  window.WebSocket=class {
    static OPEN=1;readyState=1;
    constructor(){window.nativeEvent=data=>this.onmessage?.({data:JSON.stringify(data)});setTimeout(()=>this.onopen?.(),5);}
  };
});
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>!document.getElementById('choose').disabled);
  for(const mode of ['window','desktop','region','window']) {
    await page.locator('#quality').selectOption('2k');
    await page.locator('#mode').selectOption(mode);
    await page.waitForFunction(mode=>document.getElementById('target').value===(mode==='window'?'10':'20'),mode);
    if(mode==='region') {
      await page.locator('#select-region').click();
      await page.waitForFunction(()=>!document.getElementById('settings').disabled);
      assert.equal(await page.locator('#choose').isDisabled(),true);
      await page.locator('#select-region').click();
      await page.getByText('960 × 432 像素',{exact:true}).waitFor();
    }
    await page.locator('#choose').click();
    await page.getByText('录制中',{exact:true}).waitFor({timeout:10000});
    assert.equal(await page.locator('#mode').isDisabled(),true);
    assert.equal(await page.evaluate(()=>window.browserCaptureCalls),0);
    const begin=requests.filter(item=>item.route==='native-begin').at(-1);
    assert.equal(status.options.resolution,'2k');
    assert.equal(begin.data.sourceId,mode==='window'?10:20);
    assert.deepEqual(begin.data.crop,mode==='region'?{x:.1,y:.2,width:.5,height:.4}:null);
    await page.locator('#pause').click();await page.getByText('已暂停',{exact:true}).waitFor();
    await page.locator('#pause').click();await page.getByText('录制中',{exact:true}).waitFor();
    await page.locator('#stop').click();await page.getByRole('heading',{name:'视频已保存',exact:true}).waitFor();
    assert.equal(await page.locator('#choose').textContent(),'继续新录制');
    assert.equal(await page.locator('#mode').isEnabled(),true);
  }
  await page.locator('#mode').selectOption('tab');
  await page.waitForFunction(()=>document.getElementById('native-target').hidden);
  await page.evaluate(()=>window.nativeEvent({controllerClosed:true}));
  assert.equal(await page.evaluate(()=>window.closedControllers),1);
  assert.equal(await page.locator('#choose').isDisabled(),true);
  assert.equal(await page.locator('#settings').evaluate(fieldset=>fieldset.disabled),true);
  assert.equal(await page.locator('#quality').isDisabled(),true);
  assert.equal(await page.title(),'ScreenShot · 录屏设置已结束');
  assert.deepEqual(errors,[]);
  console.log('PASS: Chrome controller native window/desktop/region, region cancellation, range handoff, pause/resume/save, repeated rounds, tab switching');
} finally { await browser.close();server.close(); }
