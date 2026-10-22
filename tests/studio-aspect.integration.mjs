// Mix wide/16:9/4:3 clips and measure real text and square pixels after merging.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'ScreenShot-font-aspect-'));
const ffmpeg=process.env.STUDIO_FFMPEG||join(root,'src-tauri/studio/node_modules/ffmpeg-static/ffmpeg');
const worker=spawn(process.execPath,[process.env.STUDIO_WORKER||join(root,'src-tauri/studio/worker.mjs')],{stdio:['pipe','pipe','inherit']});
const lines=createInterface({input:worker.stdout}),pending=[];
lines.on('line',line=>{const data=JSON.parse(line),next=pending.shift();data.ok?next.resolve(data.result):next.reject(Error(data.error));});
const call=(method,payload={})=>new Promise((resolve,reject)=>{pending.push({resolve,reject});worker.stdin.write(JSON.stringify({method,payload})+'\n');});
const run=args=>execFileSync(ffmpeg,['-v','error','-xerror',...args],{maxBuffer:20*1024*1024});
function bounds(path,time,width,height,region){
  const pixels=run(['-ss',String(time),'-i',path,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
  assert.equal(pixels.length,width*height*3);
  let left=width,top=height,right=-1,bottom=-1;
  for(let y=Math.ceil(height*region[1]);y<height*region[3];y++)for(let x=Math.ceil(width*region[0]);x<width*region[2];x++){
    const p=(y*width+x)*3;
    if(pixels[p]>225&&pixels[p+1]>225&&pixels[p+2]>225){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
  }
  assert.ok(right>=left&&bottom>=top,'Expected white shape/text pixels');
  return {width:right-left+1,height:bottom-top+1,ratio:(right-left+1)/(bottom-top+1)};
}
try{
  const project=await call('project:create',{targetRoot:join(directory,'project')});
  const sources=[];
  for(const [width,height] of [[640,312],[640,360],[480,360]]){
    const path=join(directory,`source-${width}x${height}.mp4`);
    run(['-f','lavfi','-i',`color=0x12339a:s=${width}x${height}:r=30:d=2`,'-vf','drawbox=x=(iw-80)/2:y=(ih-80)/2:w=80:h=80:color=white:t=fill','-c:v','libx264','-pix_fmt','yuv420p',path]);
    const render=await call('media:synthesizeAsset',{projectRoot:project.rootDir,assetId:`${width}x${height}`,videoPath:path,videoDuration:2,overlays:[],textOverlays:[{text:'FONT',start:0,end:2,x:.05,y:.05,width:.35,height:.25,fontSize:36,previewWidth:640,color:'#ffffff',backgroundOpacity:0}]});
    const outHeight=Math.floor(1920*height/width/2)*2;
    const glyph=bounds(render.path,.5,1920,outHeight,[0,0,.45,.35]);
    sources.push({...render,glyph,width:1920,height:outHeight});
  }
  const results=[];
  for(const preview of [true,false]){
    const merged=await call('media:mergeVideos',{projectRoot:project.rootDir,items:sources,preview});
    run(['-i',merged.path,'-map','0:v:0','-fps_mode','passthrough','-enc_time_base:v','-1','-f','null','-']);
    const samples=[];
    for(const [index,source] of sources.entries()){
      const square=bounds(merged.path,index*2+.5,1920,1080,[.3,.3,.7,.7]);
      const glyph=bounds(merged.path,index*2+.5,1920,1080,[0,0,.45,.35]);
      assert.ok(Math.abs(square.ratio-1)<.02,JSON.stringify({square,index}));
      assert.ok(Math.abs(glyph.ratio/source.glyph.ratio-1)<.03,JSON.stringify({glyph,original:source.glyph,index}));
      samples.push({square,glyph,originalGlyph:source.glyph});
    }
    if(preview)run(['-ss','0.5','-i',merged.path,'-frames:v','1',join(directory,'font-aspect-preview.png')]);
    results.push({path:merged.path,preview,samples});
  }
  const result={result:'PASS',directory,results};await writeFile(join(directory,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{worker.stdin.end();lines.close();worker.kill();}
