import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { recordingPath } from "../recordingPaths";
import BrowserRecordingPanel from "./BrowserRecordingPanel";

type Mode = "window" | "tab" | "desktop" | "region";
type Source = { id: number; kind: string; name: string; width: number; height: number };
type Crop = { x: number; y: number; width: number; height: number };
type Status = { id: string; controllerId?: string; mode?: Mode; phase: string; message: string; filePath: string | null; width: number; height: number; elapsedMs: number; bytesWritten: number; browser: string };
const modes: {value:Mode;label:string;description:string;icon:string}[] = [
  {value:"window",label:"应用窗口",description:"在工具内选择具体窗口",icon:"▣"},
  {value:"tab",label:"浏览器页签",description:"独立页签通过浏览器授权",icon:"▤"},
  {value:"desktop",label:"电脑桌面",description:"选择一块屏幕完整录制",icon:"▰"},
  {value:"region",label:"框选区域",description:"隐藏工具后，在桌面上框选",icon:"⌗"},
];

export default function RecordingPanel({onNotify,onEditVideo,defaultEditAfter=false}:{onNotify:(message:string)=>void;onEditVideo:(path:string)=>void;defaultEditAfter?:boolean}) {
  const [mode,setMode]=useState<Mode>("window");
  const [native,setNative]=useState<boolean|null>(null);
  const [sources,setSources]=useState<Source[]>([]),[sourceId,setSourceId]=useState(0);
  const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState("");
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[countdown,setCountdown]=useState(0);
  const [selecting,setSelecting]=useState(false);
  const [fps,setFps]=useState(30),[quality,setQuality]=useState("1080p"),[audio,setAudio]=useState(true),[microphone,setMicrophone]=useState(false),[cursor,setCursor]=useState(true),[clicks,setClicks]=useState(false);
  const [crop,setCrop]=useState<Crop|null>(null);
  const [editAfter,setEditAfter]=useState(defaultEditAfter);
  const editAfterRef=useRef(defaultEditAfter),completed=useRef(new Set<string>());
  const startedSession=useRef<string|null>(null),latestStatus=useRef<Status|null>(null);
  const countdownCancelled=useRef(false);
  const importCompleted=useCallback((value:Status|null)=>{
    if(value?.phase==='saved'&&value.filePath&&(value.id===startedSession.current||value.controllerId===startedSession.current)&&editAfterRef.current&&!completed.current.has(value.id)){
      completed.current.add(value.id);if(!value.controllerId)startedSession.current=null;onEditVideo(value.filePath);
    }
  },[onEditVideo]);
  const recordingStarted=useCallback((value:Status)=>{
    startedSession.current=value.controllerId||value.id;
    // Completion can arrive before the start command returns; keep that newer event.
    if(latestStatus.current?.id===value.id){setStatus(latestStatus.current);importCompleted(latestStatus.current);}
    else{latestStatus.current=value;setStatus(value);}
  },[importCompleted]);
  const active=!!status&&!['saved','cancelled','error'].includes(status.phase);
  const locked=active||busy||selecting;
  const source=sources.find(item=>item.id===sourceId&&item.kind===(mode==='window'?'window':'desktop'));
  const available=sources.filter(item=>item.kind===(mode==='window'?'window':'desktop'));
  useEffect(()=>{void invoke<boolean>('native_recording_available').then(setNative).catch(()=>setNative(false));},[]);
  useEffect(()=>{
    let mounted=true,receivedEvent=false;
    function update(value:Status|null,live=false) {
      if (!mounted||(startedSession.current&&value&&value.id!==startedSession.current&&value.controllerId!==startedSession.current)) return;
      if(value&&completed.current.has(value.id)&&latestStatus.current?.id!==value.id)return;
      latestStatus.current=value;setStatus(value);
      if(value?.mode && !["saved","cancelled","error"].includes(value.phase)) setMode(value.mode);
      if(live)importCompleted(value);
    }
    const unlisten=listen<Status>('recording-status',({payload})=>{receivedEvent=true;update(payload,true);});
    // Restoring an old snapshot is for display only, never a new recording result.
    void unlisten.then(()=>invoke<Status|null>('get_recording_status')).then(value=>{if(!receivedEvent)update(value);}).catch(()=>undefined);
    return()=>{mounted=false;void unlisten.then(off=>off());};
  },[importCompleted]);
  async function refresh(){setLoading(true);setError('');try{setSources(await invoke<Source[]>('native_capture_sources'));}catch(e){setError(String(e));}finally{setLoading(false);}}
  useEffect(()=>{if(native)void refresh();},[native]);
  useEffect(()=>{if(!available.some(item=>item.id===sourceId))setSourceId(available[0]?.id||0);},[mode,sources,sourceId]);
  useEffect(()=>{setCrop(null);setError('');},[native,mode,sourceId]);
  async function selectRegion(){
    if(locked||!source)return;
    setSelecting(true);setError('');
    try{
      const selection=await invoke<{crop:Crop}|null>('select_recording_region',{monitorId:source.id});
      // Esc preserves a previously confirmed range when reselecting.
      if(selection)setCrop(selection.crop);
    }catch(e){setError(String(e));}finally{setSelecting(false);}
  }
  async function start(){
    if(locked||!source||(mode==='region'&&(!crop||crop.width*source.width<8||crop.height*source.height<8)))return;
    setBusy(true);setError('');
    countdownCancelled.current=false;
    try{
      const path=await recordingPath();
      for(let remaining=3;remaining>0;remaining--){setCountdown(remaining);await new Promise(resolve=>setTimeout(resolve,1000));if(countdownCancelled.current)return;}
      editAfterRef.current=editAfter;
      startedSession.current=null;latestStatus.current=null;
      const value=await invoke<Status>('start_native_recording',{path,options:{mode,fps,audio,originalResolution:quality==='4k',resolution:quality,browser:null},source:{sourceId:source.id,name:source.name,crop:mode==='region'?crop:null,microphone,cursor,clicks}});
      recordingStarted(value);
    }catch(e){setError(String(e));}finally{setBusy(false);setCountdown(0);}
  }
  async function control(action:string){try{await invoke('recording_control',{action});}catch(e){onNotify(String(e));}}
  return <>
    <section className="recording-panel native-recording-panel">
      <div className="recording-heading"><div><span className="eyebrow">录屏 · 录完自动保存</span><h2>{active ? status?.phase==='saving' ? '正在保存录屏…' : status?.phase==='paused' ? '录制已暂停' : '录屏进行中' : '你想录制什么？'}</h2></div><span className="recording-badge">{native===null?'正在准备…':native?'本机录制':'浏览器录制'}</span></div>
      <p className="recording-intro">1 选择录制范围 → 2 选择目标并开始 → 3 停止后自动保存。只录一个应用时，建议选“应用窗口”。</p>
      <fieldset className="recording-sources" hidden={active} disabled={locked}><legend>第一步：选择录制范围</legend>{modes.map(item=><label key={item.value} className={`recording-source ${mode===item.value?'selected':''}`}><input type="radio" name="native-mode" value={item.value} checked={mode===item.value} onChange={()=>setMode(item.value)}/><span className="recording-source-icon">{item.icon}</span><span><strong>{item.label}</strong><small>{item.description}</small></span></label>)}</fieldset>
      {native&&mode!=='tab'&&<>
        <div className="recording-setup" hidden={active}>
        <div className="recording-options"><label>录制目标 <select aria-label="录制目标" disabled={locked||loading} value={sourceId} onChange={e=>setSourceId(Number(e.target.value))}>{!available.length&&<option value={0}>{loading?'正在读取来源…':'暂无来源'}</option>}{available.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="recording-secondary" disabled={locked||loading} onClick={()=>void refresh()}>刷新来源</button></div>
        {mode==='region'&&<div className="native-region"><button className="recording-secondary" disabled={locked||!source} onClick={()=>void selectRegion()}>{selecting?'正在框选…':crop?'重新框选':'框选录制区域'}</button><p>{crop&&source?`已选择 ${Math.round(crop.width*source.width)} × ${Math.round(crop.height*source.height)} 像素。可重新框选调整范围。`:'点击后自动隐藏工具窗口，在桌面上拖动框选，四角可调整；Enter 确认，Esc 取消。'}</p></div>}
        <div className="recording-options"><label>帧率 <select aria-label="录屏帧率" value={fps} disabled={locked} onChange={e=>setFps(Number(e.target.value))}><option value={15}>15 fps</option><option value={30}>30 fps</option><option value={60}>60 fps</option></select></label><label>画质 <select aria-label="录屏画质" value={quality} disabled={locked} onChange={e=>setQuality(e.target.value)}><option value="1080p">最高 1080p</option><option value="2k">最高 2K（2560 × 1440）</option><option value="4k">最高 4K</option></select></label></div>
        <div className="recording-options"><label><input type="checkbox" checked={audio} disabled={locked} onChange={e=>setAudio(e.target.checked)}/>录制电脑播放的声音</label><span className="recording-note">默认 1080p / 30 fps 适合日常演示，想更清晰可选 2K。</span></div>
        <details className="recording-advanced"><summary>更多设置：麦克风、鼠标与点击效果</summary><div className="recording-options">{[{label:'录制我的麦克风',value:microphone,set:setMicrophone},{label:'显示鼠标指针',value:cursor,set:setCursor},{label:'显示点击效果',value:clicks,set:setClicks}].map(item=><label key={item.label}><input type="checkbox" checked={item.value} disabled={locked} onChange={e=>item.set(e.target.checked)}/>{item.label}</label>)}</div></details>
        <label className="recording-note"><input type="checkbox" checked={editAfter} disabled={locked} onChange={e=>setEditAfter(e.target.checked)}/>录完直接进入视频制作，添加文字稿和旁白</label>
        </div>
        <div className="recording-actions">{!active?<button className="capture-button" disabled={busy||selecting||!source||(mode==='region'&&!crop)} onClick={()=>void start()}><span className="record-dot"/>{countdown?`${countdown} 秒后开始…`:busy?'正在准备…':'开始录屏'}</button>:<><button className="recording-secondary" disabled={!['recording','paused'].includes(status!.phase)} onClick={()=>void control(status!.phase==='paused'?'resume':'pause')}>{status!.phase==='paused'?'继续录制':'暂停录制'}</button><button className="recording-stop" disabled={status!.phase==='saving'} onClick={()=>void control('stop')}>{status!.phase==='saving'?'正在保存…':'停止并保存'}</button></>}{status?.phase==='saved'&&status.filePath&&<><button className="recording-secondary" onClick={()=>onEditVideo(status.filePath!)}>添加旁白 / 编辑视频</button><button className="recording-secondary" onClick={()=>{void invoke('reveal_recording');}}>打开所在文件夹</button></>}</div>
        {countdown>0&&<div className="recording-countdown" role="status"><span>{countdown} 秒后开始，可以切换到要演示的应用。</span><button className="recording-secondary" onClick={()=>{countdownCancelled.current=true;onNotify('已取消开始录屏');}}>取消开始</button></div>}
        {!source&&!loading&&<p className="recording-note">没有找到可录制的目标？先打开对应应用，再点“刷新来源”。若仍为空，请检查系统设置中的屏幕录制权限。</p>}
        {status&&<div className={`recording-status ${status.phase==='error'?'error':''}`} role="status"><strong>{status.message}</strong>{status.width>0&&<span>{Math.floor(status.elapsedMs/60000).toString().padStart(2,'0')}:{Math.floor(status.elapsedMs/1000%60).toString().padStart(2,'0')} · {status.width} × {status.height} · {(status.bytesWritten/1048576).toFixed(1)} MB</span>}{status.filePath&&<span className="recording-path">保存位置：{status.filePath}</span>}</div>}
        {error&&<div className="recording-status error" role="alert">{error}</div>}
        <p className="recording-note">开始后工具自动收起。结束时按 <kbd>Cmd + Alt + Shift + R</kbd>，或点菜单栏图标 →“停止录屏并保存”。视频保存到用户目录 screenshot / 当天日期，可用“打开所在文件夹”找到。<br/>第一次使用需在系统设置中允许 ScreenShot 录制屏幕。</p>
      </>}
    </section>
    {(mode==='tab'||native===false)&&<BrowserRecordingPanel lockedMode={mode} onNotify={onNotify} onEditVideo={onEditVideo} onRecordingStarted={recordingStarted} onRecordingPreparing={()=>{startedSession.current=null;latestStatus.current=null;}}/>}
  </>;
}
