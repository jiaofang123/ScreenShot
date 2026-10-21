const $ = id => document.getElementById(id);
const base = new URL('./', location.href);
const names = { window: '应用窗口', tab: '浏览器页签', desktop: '电脑桌面', region: '框选区域' };
const phases = { waiting: '等待选择', selecting: '调整选区', countdown: '准备录制', recording: '录制中', paused: '已暂停', saving: '保存中', saved: '已保存', cancelled: '已取消', error: '录制出错' };
let config, socket, sourceStream, outputStream, recorder, cropWorker;
let phase = 'waiting', startedAt = 0, endedAt = 0, pauseStarted = 0, pausedMs = 0, lastFlush = 0, nextSequence = 0, pendingBytes = 0;
let uploadQueue = Promise.resolve(), uploadError = null, finishing = false, cancelled = false, stopRequested = false;
let crop = null, drag = null, nativeCrop = null, nativeSources = [], preparing = false;

function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
function setPhase(value) {
  phase = value; $('phase').textContent = phases[value] || value;
  const active = ['recording', 'paused'].includes(value);
  const idle = ['waiting', 'saved', 'cancelled', 'error'].includes(value);
  $('settings').disabled = !idle || preparing;
  $('choose').hidden = !idle;
  $('choose').textContent = value === 'waiting' ? (usesNative() ? '开始录制' : `选择${$('mode').value === 'region' ? '屏幕并框选' : names[$('mode').value]}并开始录制`) : '继续新录制';
  $('choose').disabled = preparing || !socket || socket.readyState !== WebSocket.OPEN || (usesNative() && (!$('target').value || ($('mode').value === 'region' && !nativeCrop)));
  $('start').hidden = value !== 'selecting';
  $('pause').hidden = !active;
  $('pause').textContent = value === 'paused' ? '继续录制' : '暂停';
  $('stop').hidden = !active;
  $('cancel').hidden = !['waiting', 'selecting', 'countdown'].includes(value);
  $('metrics').hidden = !['recording', 'paused', 'saving', 'saved'].includes(value);
}
function elapsed() { return startedAt ? Math.max(0, (pauseStarted || endedAt || performance.now()) - startedAt - pausedMs) : 0; }
function updateClock() {
  const seconds = Math.floor(elapsed() / 1000);
  $('elapsed').textContent = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
async function api(route, data, binary = false) {
  const response = await fetch(new URL(route, base), {
    method: 'POST', headers: { 'Content-Type': binary ? 'application/octet-stream' : 'application/json', 'X-Recording-Id': config?.status?.id || '' },
    body: binary ? data : JSON.stringify(data ?? {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '本机连接出错');
  return result;
}
function cleanup() {
  const tracks = new Set([...(sourceStream?.getTracks() || []), ...(outputStream?.getTracks() || [])]);
  for (const track of tracks) track.stop();
  sourceStream = null; outputStream = null;
  if (cropWorker) { cropWorker.postMessage({ stop: true }); cropWorker.terminate(); cropWorker = null; }
  $('preview').srcObject = null;
}
async function reportError(error) {
  notice(error instanceof Error ? error.message : String(error));
  try { await api('error', { message: error instanceof Error ? error.message : String(error) }); } catch {}
  cleanup(); setPhase('error');
}
async function stop() {
  if (finishing || ['saved', 'cancelled', 'error', 'saving'].includes(phase)) return;
  stopRequested = true;
  if (recorder && recorder.state !== 'inactive') {
    if (pauseStarted) { pausedMs += performance.now() - pauseStarted; pauseStarted = 0; }
    endedAt = performance.now();
    setPhase('saving'); recorder.stop();
  } else if (phase !== 'countdown') {
    cancelled = true; cleanup();
    try { await api('cancel'); } catch {}
    setPhase('cancelled'); notice('录屏已取消，可在此页选择方式并继续新录制。');
  }
}
async function applyControl(data, heartbeat = false) {
  if (data.status && data.status.id !== config?.status?.id) return;
  if (config?.nativeCapture && config.options.mode !== 'tab') {
    if (data.status?.id === config.status.id) syncNativeStatus(data.status);
    return;
  }
  updateClock();
  if (data.command === 'stop' || data.command === 'cancel') { await stop(); return; }
  if (!recorder || finishing) return;
  if (data.command === 'pause' && recorder.state === 'recording') {
    recorder.pause(); pauseStarted = performance.now(); setPhase('paused');
    await api('state', { phase: 'paused', elapsedMs: Math.round(elapsed()) });
  } else if (data.command === 'resume' && recorder.state === 'paused') {
    pausedMs += performance.now() - pauseStarted; pauseStarted = 0;
    recorder.resume(); setPhase('recording');
    await api('state', { phase: 'recording', elapsedMs: Math.round(elapsed()) });
  } else if (heartbeat && recorder.state === 'recording' && performance.now() - lastFlush >= 900) {
    // Server-driven messages also flush data when this page is in the background.
    lastFlush = performance.now(); recorder.requestData();
    await api('state', { phase: 'recording', elapsedMs: Math.round(elapsed()) });
  }
}
function chooseMime(stream) {
  const audio = stream.getAudioTracks().length > 0;
  const candidates = [
    'video/mp4', audio ? 'video/webm;codecs=vp9,opus' : 'video/webm;codecs=vp9',
    'video/webm',
  ];
  if (config.preferredFormat === 'webm') candidates.sort((a, b) => Number(b.startsWith('video/webm')) - Number(a.startsWith('video/webm')));
  const mime = candidates.find(value => MediaRecorder.isTypeSupported(value));
  if (!mime) throw new Error('当前浏览器不支持视频编码，请使用新版 Chrome 或 Edge。');
  return mime;
}
function selectedCropPixels() {
  const video = $('preview');
  if (!crop || crop.width * video.videoWidth < 8 || crop.height * video.videoHeight < 8) throw new Error('请先在预览中框选至少 8 × 8 像素的区域。');
  return { width: Math.max(2, Math.floor(crop.width * video.videoWidth / 2) * 2), height: Math.max(2, Math.floor(crop.height * video.videoHeight / 2) * 2) };
}
async function createCropStream() {
  if (!window.MediaStreamTrackProcessor || !window.MediaStreamTrackGenerator || !window.OffscreenCanvas || !window.VideoFrame) {
    throw new Error('此浏览器暂不支持后台区域录制，请使用新版 Chrome 或 Edge。');
  }
  const { width, height } = selectedCropPixels();
  const processor = new MediaStreamTrackProcessor({ track: sourceStream.getVideoTracks()[0] });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  cropWorker = new Worker(new URL('crop-worker.js', base));
  cropWorker.onerror = event => { uploadError ||= new Error(event.message || '区域画面处理失败'); void stop(); };
  cropWorker.onmessage = ({ data }) => { if (data.error) { uploadError ||= new Error(data.error); void stop(); } };
  cropWorker.postMessage({ readable: processor.readable, writable: generator.writable, crop, width, height }, [processor.readable, generator.writable]);
  generator.contentHint = 'motion';
  return { stream: new MediaStream([generator, ...sourceStream.getAudioTracks()]), width, height };
}
async function startRecording() {
  if (!sourceStream || cancelled || stopRequested || !['waiting', 'selecting'].includes(phase)) return;
  $('start').disabled = true;
  try {
    let width = $('preview').videoWidth, height = $('preview').videoHeight;
    if (config.options.mode === 'region') {
      ({ stream: outputStream, width, height } = await createCropStream());
    } else { outputStream = sourceStream; }
    const mime = chooseMime(outputStream);
    setPhase('countdown');
    for (let remaining = 3; remaining > 0; remaining--) {
      notice(`${remaining} 秒后开始录制，可以切回目标应用…`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (stopRequested || cancelled) { cancelled = true; cleanup(); try { await api('cancel'); } catch {} setPhase('cancelled'); return; }
    }
    const track = sourceStream.getVideoTracks()[0];
    const settings = track.getSettings();
    if (track.readyState !== 'live') throw new Error('共享已停止，请重新开始录屏。');
    await api('begin', { mime, width, height, hasAudio: outputStream.getAudioTracks().length > 0, sourceName: track.label, displaySurface: settings.displaySurface || null });
    recorder = new MediaRecorder(outputStream, { mimeType: mime, videoBitsPerSecond: config.options.originalResolution ? 16000000 : 8000000, audioBitsPerSecond: 128000 });
    recorder.ondataavailable = ({ data }) => {
      if (!data.size) return;
      pendingBytes += data.size;
      uploadQueue = uploadQueue.then(async () => {
        if (uploadError) return;
        for (let offset = 0; offset < data.size; offset += 4 * 1024 * 1024) {
          const chunk = data.slice(offset, offset + 4 * 1024 * 1024);
          const control = await api(`chunk?seq=${nextSequence}`, chunk, true);
          nextSequence++;
          await applyControl(control);
        }
      }).catch(error => { uploadError ||= error; void stop(); }).finally(() => { pendingBytes -= data.size; });
      if (pendingBytes > 64 * 1024 * 1024) { notice('磁盘写入较慢，正在停止并保存已有录屏。'); void stop(); }
    };
    recorder.onerror = event => { uploadError ||= event.error || new Error('视频编码失败'); void stop(); };
    recorder.onstop = async () => {
      if (finishing) return;
      finishing = true; endedAt ||= performance.now(); const duration = Math.round(elapsed());
      setPhase('saving'); cleanup();
      await uploadQueue;
      if (uploadError) { await reportError(uploadError); return; }
      try {
        const result = await api('finish', { chunks: nextSequence, elapsedMs: duration });
        setPhase('saved'); $('preview-wrap').hidden = true; $('saved').hidden = false;
        $('saved-path').textContent = result.path; notice('视频已保存，可在此页继续新录制或切换录制方式。');
      } catch (error) { await reportError(error); }
    };
    startedAt = performance.now(); recorder.start(1000); setPhase('recording');
    $('preview-wrap').hidden = true;
    $('preview-stage').classList.remove('selecting'); $('crop').hidden = true; $('crop-help').hidden = true;
    $('source').textContent = `${names[config.options.mode]} · ${width} × ${height}`;
    $('format').textContent = `${mime.startsWith('video/mp4') ? 'MP4' : 'WebM'} · ${outputStream.getAudioTracks().length ? '含共享声音' : '仅画面'}`;
    notice(config.options.audio && !outputStream.getAudioTracks().length ? '当前来源未提供共享声音，本次只录制画面。可切回目标应用，停止后会自动保存。' : '录屏进行中。可以切回目标应用，请保留此页面。');
  } catch (error) { await reportError(error); }
  finally { $('start').disabled = false; }
}

function readOptions() {
  return { mode: $('mode').value, fps: Number($('fps').value), audio: $('audio').checked, originalResolution: $('quality').value === '4k', browser: config?.options.browser || null };
}
function usesNative() { return config?.nativeCapture && $('mode').value !== 'tab'; }
function showSaved(path) {
  $('saved').hidden = false; $('saved-path').textContent = path || '';
  $('preview-wrap').hidden = true;
  notice('视频已保存，可在此页继续新录制或切换录制方式。');
}
function syncNativeStatus(status) {
  if (status.phase === 'waiting') return;
  setPhase(status.phase);
  const seconds = Math.floor(status.elapsedMs / 1000);
  $('elapsed').textContent = `${Math.floor(seconds / 60).toString().padStart(2,'0')}:${(seconds % 60).toString().padStart(2,'0')}`;
  $('source').textContent = `${names[status.mode]} · ${status.width} × ${status.height}`;
  $('format').textContent = `MP4 · ${status.hasAudio ? '含共享声音' : '仅画面'}`;
  if (status.phase === 'saved') showSaved(status.filePath);
  else if (status.phase === 'error') notice(status.message);
  else if (status.phase === 'recording') notice('录屏进行中。ScreenShot 工具和录屏控制窗口已从画面中排除。');
}
async function prepareRound() {
  const wanted = readOptions();
  if (phase === 'waiting' && Object.entries(wanted).every(([key,value]) => config.options[key] === value)) return;
  const result = await api('restart', wanted);
  config.options = wanted; config.status = result.status;
  recorder = null; finishing = false; cancelled = false; stopRequested = false;
  startedAt = endedAt = pauseStarted = pausedMs = lastFlush = nextSequence = pendingBytes = 0;
  uploadQueue = Promise.resolve(); uploadError = null; crop = drag = null;
  $('saved').hidden = true; $('metrics').hidden = true; $('elapsed').textContent = '00:00';
  setPhase('waiting');
}
async function refreshNativeSources() {
  $('native-target').hidden = !usesNative();
  $('select-region').hidden = !usesNative() || $('mode').value !== 'region';
  $('title').textContent = `录制${names[$('mode').value]}`;
  if (!usesNative()) { setPhase(phase); return; }
  nativeSources = await api('native-sources');
  const previous = $('target').value, kind = $('mode').value === 'window' ? 'window' : 'desktop';
  $('target').replaceChildren(...nativeSources.filter(source => source.kind === kind).map(source => new Option(source.name, String(source.id))));
  if ([...$('target').options].some(option => option.value === previous)) $('target').value = previous;
  setPhase(phase);
}
async function startNative() {
  const target = nativeSources.find(source => String(source.id) === $('target').value && source.kind === (config.options.mode === 'window' ? 'window' : 'desktop'));
  if (!target || (config.options.mode === 'region' && !nativeCrop)) throw new Error('请先选择录制目标和范围。');
  setPhase('countdown');
  for (let seconds = 3; seconds > 0; seconds--) {
    notice(`${seconds} 秒后开始录制…`); await new Promise(resolve => setTimeout(resolve,1000));
    if (stopRequested) { await api('cancel'); setPhase('cancelled'); return; }
  }
  await api('native-begin', { sourceId:target.id, name:target.name, crop:config.options.mode === 'region' ? nativeCrop : null, microphone:false, cursor:true, clicks:false });
  notice('正在启动本机录制，工具和控制窗口将从画面中排除…');
}
$('mode').onchange = () => {
  nativeCrop = null; $('region-size').textContent = '';
  void refreshNativeSources().catch(error => notice(error.message));
};
$('target').onchange = () => { nativeCrop = null; $('region-size').textContent = ''; setPhase(phase); };
$('refresh').onclick = () => { void refreshNativeSources().catch(error => notice(error.message)); };
$('select-region').onclick = async () => {
  if (preparing) return;
  preparing = true; setPhase(phase); notice('请在桌面上框选；Enter 确认，Esc 取消。');
  try {
    await prepareRound();
    const selected = await api('native-region', { monitorId:Number($('target').value) });
    if (selected) { nativeCrop = selected.crop; $('region-size').textContent = `${selected.width} × ${selected.height} 像素`; }
    notice('');
  } catch (error) { notice(error.message); }
  finally { preparing = false; setPhase(phase); }
};
$('reveal').onclick = () => { void api('reveal').catch(error => notice(error.message)); };

$('choose').onclick = async () => {
  if (preparing || !['waiting','saved','cancelled','error'].includes(phase)) return;
  preparing = true; $('choose').disabled = true; $('settings').disabled = true; notice(''); cancelled = false; stopRequested = false;
  try {
    if (usesNative()) { await prepareRound(); await startNative(); return; }
    const wanted = readOptions();
    if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) throw new Error('当前浏览器不支持录屏，请使用新版 Chrome 或 Edge 打开此页。');
    const surface = { window: 'window', tab: 'browser', desktop: 'monitor', region: 'monitor' }[wanted.mode];
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: surface, frameRate: { ideal: wanted.fps, max: wanted.fps },
        width: { ideal: wanted.originalResolution ? 3840 : 1920, max: wanted.originalResolution ? 3840 : 1920 },
        height: { ideal: wanted.originalResolution ? 2160 : 1080, max: wanted.originalResolution ? 2160 : 1080 } },
      audio: wanted.audio,
      selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude',
      monitorTypeSurfaces: ['window', 'tab'].includes(wanted.mode) ? 'exclude' : 'include',
      systemAudio: wanted.audio ? 'include' : 'exclude',
    });
    sourceStream = stream;
    if (cancelled || stopRequested) { cleanup(); return; }
    await prepareRound();
    sourceStream = stream;
    if (cancelled || stopRequested) { cleanup(); return; }
    const videoTrack = stream.getVideoTracks()[0];
    const actual = videoTrack.getSettings().displaySurface;
    if (!actual) { cleanup(); throw new Error('当前浏览器无法确认录制来源类型，请使用 Chrome 或 Edge。'); }
    if (actual !== surface) {
      cleanup(); throw new Error(`请在共享面板选择${names[wanted.mode]}，当前选择的来源类型不符。`);
    }
    if (videoTrack.getCaptureHandle?.()?.handle === 'screenshot-recorder' || /ScreenShot · 本机录屏/.test(videoTrack.label)) { cleanup(); throw new Error('不能录制 ScreenShot 录屏控制页，请选择其他标签页或窗口。'); }
    videoTrack.addEventListener('capturehandlechange', () => { if (videoTrack.getCaptureHandle?.()?.handle === 'screenshot-recorder') { notice('已停止：目标切换到了 ScreenShot 录屏控制页。'); void stop(); } });
    videoTrack.contentHint = 'motion'; videoTrack.onended = () => { void stop(); };
    const video = $('preview'); video.srcObject = stream;
    $('preview-wrap').hidden = false;
    await video.play();
    if (!video.videoWidth) await new Promise(resolve => { video.onloadedmetadata = resolve; });
    $('preview-stage').style.width = `min(100%, calc(65vh * ${video.videoWidth / video.videoHeight}))`;
    if (wanted.mode === 'region') {
      if (!window.MediaStreamTrackProcessor || !window.MediaStreamTrackGenerator) { cleanup(); throw new Error('区域录制需要新版 Chrome 或 Edge。'); }
      crop = null; renderCrop(); $('preview-stage').classList.add('selecting'); $('crop-help').hidden = false;
      await api('selecting'); setPhase('selecting'); notice('请在共享画面上拖动框选录制范围，四角可以再次调整。');
    } else { await startRecording(); }
  } catch (error) {
    cleanup(); $('preview-wrap').hidden = true;
    if (!['saved', 'cancelled', 'error'].includes(phase)) {
      setPhase('waiting');
      notice(error.name === 'NotAllowedError' ? '共享已取消或未获屏幕录制权限。可重新选择；macOS 请允许 Chrome/Edge 录制屏幕。' : error.message || String(error));
    } else { notice(error.message || String(error)); }
  } finally { preparing = false; setPhase(phase); }
};
$('start').onclick = () => { void startRecording(); };
$('pause').onclick = () => { void api('control', { action: phase === 'paused' ? 'resume' : 'pause' }).then(applyControl).catch(reportError); };
$('stop').onclick = () => { void api('control', { action: 'stop' }).then(applyControl).catch(reportError); };
$('cancel').onclick = () => { stopRequested = true; void api('control', { action: 'cancel' }).then(applyControl).catch(reportError); };

function pointer(event, offset = { x: 0, y: 0 }) {
  const bounds = $('preview-stage').getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (event.clientX - bounds.x) / bounds.width + offset.x)), y: Math.max(0, Math.min(1, (event.clientY - bounds.y) / bounds.height + offset.y)) };
}
function renderCrop() {
  $('crop').hidden = !crop;
  $('start').disabled = !crop || crop.width * $('preview').videoWidth < 8 || crop.height * $('preview').videoHeight < 8;
  if (!crop) return;
  Object.assign($('crop').style, { left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` });
  $('crop-size').textContent = `${Math.round(crop.width * $('preview').videoWidth)} × ${Math.round(crop.height * $('preview').videoHeight)}`;
}
$('preview-stage').onpointerdown = event => {
  if (phase !== 'selecting' || event.button !== 0 || drag) return;
  event.preventDefault();
  let anchor = pointer(event), moving = anchor, offset = { x: 0, y: 0 };
  const corner = event.target.dataset.corner;
  if (corner && crop) {
    moving = { x: crop.x + (corner.endsWith('e') ? crop.width : 0), y: crop.y + (corner.startsWith('s') ? crop.height : 0) };
    anchor = { x: crop.x + (corner.endsWith('w') ? crop.width : 0), y: crop.y + (corner.startsWith('n') ? crop.height : 0) };
    const current = pointer(event); offset = { x: moving.x - current.x, y: moving.y - current.y };
  }
  drag = { id: event.pointerId, anchor, offset };
  $('preview-stage').setPointerCapture(event.pointerId);
  crop = { x: Math.min(anchor.x, moving.x), y: Math.min(anchor.y, moving.y), width: Math.abs(anchor.x - moving.x), height: Math.abs(anchor.y - moving.y) }; renderCrop();
};
$('preview-stage').onpointermove = event => {
  if (!drag || event.pointerId !== drag.id) return;
  const point = pointer(event, drag.offset);
  crop = { x: Math.min(drag.anchor.x, point.x), y: Math.min(drag.anchor.y, point.y), width: Math.abs(drag.anchor.x - point.x), height: Math.abs(drag.anchor.y - point.y) }; renderCrop();
};
$('preview-stage').onpointerup = event => {
  if (!drag || event.pointerId !== drag.id) return;
  $('preview-stage').onpointermove(event); drag = null;
  if ($('preview-stage').hasPointerCapture(event.pointerId)) $('preview-stage').releasePointerCapture(event.pointerId);
};
$('preview-stage').onpointercancel = $('preview-stage').onlostpointercapture = () => { drag = null; };
window.addEventListener('beforeunload', event => { if (['recording', 'paused', 'saving'].includes(phase)) { event.preventDefault(); event.returnValue = ''; } });

try {
  const response = await fetch(new URL('config', base));
  if (!response.ok) throw new Error('录屏会话已过期，请回到 ScreenShot 重新开始。');
  config = await response.json();
  if (config.status?.stopShortcutAvailable) $('stop-help').textContent = '停止快捷键：Ctrl/Cmd + Alt + Shift + R · 也可从 ScreenShot 托盘菜单停止录屏';
  $('title').textContent = `录制${names[config.options.mode]}`;
  $('choose').textContent = `选择${config.options.mode === 'region' ? '屏幕并框选' : names[config.options.mode]}${config.options.mode === 'region' ? '' : '并开始录制'}`;
  $('instructions').textContent = config.nativeCapture ? '标签页通过 Chrome/Edge 授权；窗口、屏幕和区域在此页选择并由本机录制。ScreenShot 工具与录屏控制页会从录制中排除。保存后可直接在此页继续。' : '选择共享内容，视频保存在工具中选择的目录。保存后可在此页切换方式或继续新录制。';
  if (!config.status || !['waiting','saved','cancelled','error'].includes(config.status.phase)) throw new Error('录屏已在其他页面开始，请使用原录屏页面。');
  $('mode').value = config.options.mode; $('fps').value = String(config.options.fps); $('quality').value = config.options.originalResolution ? '4k' : '1080p'; $('audio').checked = config.options.audio;
  navigator.mediaDevices?.setCaptureHandleConfig?.({ handle: 'screenshot-recorder', permittedOrigins: ['*'] });
  await refreshNativeSources();
  socket = new WebSocket(config.webSocketUrl);
  socket.onopen = () => { setPhase(config.status.phase); notice(''); if(config.status.phase === 'saved') showSaved(config.status.filePath); };
  socket.onmessage = ({ data }) => { void applyControl(JSON.parse(data), true).catch(reportError); };
  socket.onerror = () => { notice('无法连接 ScreenShot，请确认应用仍在运行。'); };
  socket.onclose = () => {
    if (['saved', 'cancelled', 'error'].includes(phase)) return;
    cancelled = true; uploadError ||= new Error('ScreenShot 连接已断开，已写入的片段会尽可能保留。');
    if (recorder?.state && recorder.state !== 'inactive') recorder.stop();
    else { cleanup(); setPhase('error'); notice(uploadError.message); }
  };
} catch (error) { setPhase('error'); notice(error.message || String(error)); }
