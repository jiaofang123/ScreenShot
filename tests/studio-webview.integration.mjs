// Native WKWebView + production IPC. Uses an isolated data store and owned files.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,stat} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'ScreenShot-native-editor-'));
const worker=spawn(process.execPath,[join(root,'src-tauri/studio/worker.mjs')],{stdio:['pipe','pipe','inherit']});
const lines=createInterface({input:worker.stdout}),pending=[];
lines.on('line',line=>{const value=JSON.parse(line),next=pending.shift();value.ok?next.resolve(value.result):next.reject(Error(value.error));});
const call=(method,payload={})=>new Promise((resolve,reject)=>{pending.push({resolve,reject});worker.stdin.write(JSON.stringify({method,payload})+'\n');});
try{
  const project=await call('project:create',{targetRoot:join(directory,'project')});
  const ffmpeg=join(root,'src-tauri/studio/node_modules/ffmpeg-static/ffmpeg');
  const video=join(project.rootDir,'assets','fixture.mp4'),voice=join(project.rootDir,'voices','voice.wav');
  execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=red:s=320x180:r=30:d=3','-c:v','libx264',video]);
  execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','pcm_s16le',voice]);
  project.assets=[{id:'native-asset',path:video,name:'Native editor fixture',duration:3,segmentsInitialized:true,segments:[{id:'native-segment',text:'QA transcript',start:0,end:1,activeVoiceId:'native-voice',voiceVersions:[{id:'native-voice',path:voice}]}],renderVersions:[],textOverlays:[{id:'native-text',text:'原文字',start:1,end:2,x:.1,y:.1,width:.3,height:.2,fontSize:16}]}];
  await call('project:save',project);
  const resultPath=join(directory,'native-result.json');
  const child=spawn(join(root,'src-tauri/target/debug/examples/studio_webview_harness'),[join(root,'tests/studio-webview.driver.js'),resultPath,project.rootDir],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);
  const code=await new Promise(resolve=>child.once('exit',resolve));
  const result=JSON.parse(await readFile(resultPath,'utf8'));
  assert.equal(code,0,JSON.stringify({result,stderr}));assert.equal(result.ok,true,JSON.stringify({result,stderr}));
  assert.equal(result.nativeConfirm,false,'Regression should reproduce unavailable native JS confirmation');
  assert.equal(await stat(voice).then(()=>true,()=>false),false);
  result.voiceFileRemoved=true;result.directory=directory;
  await writeFile(resultPath,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{worker.stdin.end();lines.close();worker.kill();}
