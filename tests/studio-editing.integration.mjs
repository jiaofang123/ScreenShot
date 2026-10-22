// Real worker/filesystem checks: transcript deletion must clean generated speech
// while preserving other segments, original media and files outside the project.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
const directory=await mkdtemp(join(tmpdir(),'ScreenShot-editing-files-'));
const child=spawn(process.execPath,[process.env.STUDIO_WORKER||new URL('../src-tauri/studio/worker.mjs',import.meta.url).pathname],{stdio:['pipe','pipe','inherit'],env:{...process.env,SCREENSHOT_STUDIO_WORKSPACE:directory}});
const pending=[],lines=createInterface({input:child.stdout});
lines.on('line',line=>{const value=JSON.parse(line),next=pending.shift();value.ok?next.resolve(value.result):next.reject(Error(value.error));});
const call=(method,payload={})=>new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify({method,payload})+'\n');});
const exists=path=>stat(path).then(()=>true,()=>false);
try {
  const project=await call('project:create');
  const own=join(project.rootDir,'voices','one');await mkdir(own);
  for(const name of ['v.wav','v.txt','v.aiff','v.preview.wav','old.mp3'])await writeFile(join(own,name),'owned');
  const shared=join(project.rootDir,'voices','shared.wav');await writeFile(shared,'shared');
  const outside=join(directory,'external.wav');await writeFile(outside,'external');
  const video=join(project.rootDir,'assets','original.mp4');await writeFile(video,'original');
  project.assets=[{id:'asset',path:video,segments:[
    {id:'one',voiceVersions:[{id:'v',path:join(own,'v.wav'),textPath:join(own,'v.txt')},{id:'shared',path:shared},{id:'external',path:outside},{id:'original',path:video}]},
    {id:'two',voiceVersions:[{id:'shared',path:shared}]}
  ],renderVersions:[{id:'render',path:join(project.rootDir,'renders','existing.mp4')}]}];
  await writeFile(project.assets[0].renderVersions[0].path,'existing render');
  await call('project:save',project);
  const deleted=await call('project:deleteSegment',{project,assetId:'asset',segmentId:'one'});
  assert.equal(deleted.deletedFiles,5);assert.ok(deleted.retainedFiles>=3);assert.equal(deleted.cleanupPending,false);
  assert.equal(await exists(own),false);
  for(const file of [shared,outside,video,project.assets[0].renderVersions[0].path])assert.equal(await exists(file),true,file);
  let saved=JSON.parse(await readFile(join(project.rootDir,'project.json'),'utf8'));
  assert.deepEqual(saved.assets[0].segments.map(item=>item.id),['two']);
  assert.equal(saved.assets[0].segmentsInitialized,true);
  await call('project:deleteSegment',{project:saved,assetId:'asset',segmentId:'two'});
  assert.equal(await exists(shared),false);
  saved=JSON.parse(await readFile(join(project.rootDir,'project.json'),'utf8'));
  assert.deepEqual(saved.assets[0].segments,[]);
  assert.deepEqual(await readdir(join(project.rootDir,'tmp')),[]);
  // A symlink must never let card deletion remove external audio or directories.
  const externalDir=join(directory,'external-dir');await mkdir(externalDir);await writeFile(join(externalDir,'keep.wav'),'keep');
  await symlink(externalDir,join(project.rootDir,'voices','linked'),'dir');
  saved.assets[0].segments=[{id:'linked',voiceVersions:[{id:'alias',path:join(project.rootDir,'voices','linked','keep.wav')}]}];
  await call('project:save',saved);
  const alias=await call('project:deleteSegment',{project:saved,assetId:'asset',segmentId:'linked'});
  assert.ok(alias.retainedFiles>0);assert.equal(await readFile(join(externalDir,'keep.wav'),'utf8'),'keep');
  const before=await readFile(join(project.rootDir,'project.json'),'utf8');
  await assert.rejects(call('project:deleteSegment',{project:saved,assetId:'missing',segmentId:'linked'}));
  assert.equal(await readFile(join(project.rootDir,'project.json'),'utf8'),before);
  const ordered=JSON.parse(before);
  ordered.assets[0].renderVersions[0].displayNumber=42;
  ordered.assets.unshift({id:'second',path:video,segments:[],segmentsInitialized:true,renderVersions:[]});
  ordered.renderOrder=['render'];ordered.nextRenderNumber=43;
  const packaged=await call('project:saveAsFolder',{project:ordered,targetRoot:join(directory,'packaged')});
  const restored=await call('project:openFolder',{targetRoot:packaged.rootDir});
  assert.deepEqual(restored.assets.map(asset=>asset.id),['second','asset']);
  assert.equal(restored.assets[1].renderVersions[0].displayNumber,42);
  assert.equal(restored.nextRenderNumber,43);assert.deepEqual(restored.renderOrder,['render']);
  console.log(JSON.stringify({result:'PASS',directory,cases:['all generated voice versions and intermediates removed','other cards/shared audio preserved','original and rendered video preserved','last transcript stays empty','atomic metadata and no temporary leftovers','external/symlink paths protected','invalid card leaves project unchanged']}));
} finally {child.stdin.end();lines.close();child.kill();}
