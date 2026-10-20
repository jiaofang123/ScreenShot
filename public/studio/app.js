const $ = (id) => document.getElementById(id);
const TEXT_OVERLAY_PLACEHOLDER = "输入文字";
const TEXT_OVERLAY_DEFAULT_DURATION = 2;
const TEXT_OVERLAY_FONT_SIZES = [12, 14, 16, 20, 24, 30, 36, 45];

const els = {
  projectSubtitle: $("projectSubtitle"),
  assetCount: $("assetCount"),
  assetList: $("assetList"),
  insertedTextCount: $("insertedTextCount"),
  insertedTextList: $("insertedTextList"),
  queueCount: $("queueCount"),
  mergeQueue: $("mergeQueue"),
  previewTitle: $("previewTitle"),
  previewMeta: $("previewMeta"),
  ffmpegStatus: $("ffmpegStatus"),
  ttsStatus: $("ttsStatus"),
  videoPreview: $("videoPreview"),
  insertTextBtn: $("insertTextBtn"),
  textOverlayLayer: $("textOverlayLayer"),
  textStylePanel: $("textStylePanel"),
  textFontSize: $("textFontSize"),
  textColor: $("textColor"),
  textBgColor: $("textBgColor"),
  textBgOpacity: $("textBgOpacity"),
  deleteTextOverlayBtn: $("deleteTextOverlayBtn"),
  emptyPreview: $("emptyPreview"),
  addSegmentBtn: $("addSegmentBtn"),
  segmentList: $("segmentList"),
  segmentStart: $("segmentStart"),
  segmentEnd: $("segmentEnd"),
  scriptText: $("scriptText"),
  speedSelect: $("speedSelect"),
  generateVoiceBtn: $("generateVoiceBtn"),
  previewVoiceBtn: $("previewVoiceBtn"),
  synthesizeBtn: $("synthesizeBtn"),
  voiceVersions: $("voiceVersions"),
  versionCount: $("versionCount"),
  newProjectBtn: $("newProjectBtn"),
  saveProjectBtn: $("saveProjectBtn"),
  openProjectBtn: $("openProjectBtn"),
  recordBtn: $("recordBtn"),
  importBtn: $("importBtn"),
  mergePreviewBtn: $("mergePreviewBtn"),
  mergeBtn: $("mergeBtn"),
  recordDialog: $("recordDialog"),
  closeRecordBtn: $("closeRecordBtn"),
  recordTimer: $("recordTimer"),
  recordResolution: $("recordResolution"),
  captureSources: $("captureSources"),
  recordSystemAudio: $("recordSystemAudio"),
  recordMic: $("recordMic"),
  recordCursor: $("recordCursor"),
  recordClicks: $("recordClicks"),
  recordKeys: $("recordKeys"),
  cropX: $("cropX"),
  cropY: $("cropY"),
  cropW: $("cropW"),
  cropH: $("cropH"),
  selectAreaBtn: $("selectAreaBtn"),
  areaHint: $("areaHint"),
  startRecordBtn: $("startRecordBtn"),
  stopRecordBtn: $("stopRecordBtn"),
  toast: $("toast")
};

const bridge = window.studio || createDemoBridge();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForVideoDimensions(video) {
  if (video.videoWidth && video.videoHeight) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("无法读取录屏源尺寸，请重新选择录屏来源。"));
    }, 3000);
    const done = () => {
      if (!video.videoWidth || !video.videoHeight) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", done);
      video.removeEventListener("resize", done);
      video.removeEventListener("error", fail);
    };
    const fail = () => {
      cleanup();
      reject(new Error("录屏源视频加载失败。"));
    };
    video.addEventListener("loadedmetadata", done);
    video.addEventListener("resize", done);
    video.addEventListener("error", fail);
  });
}

function evenDimension(value) {
  return Math.max(2, Math.round(Number(value || 2) / 2) * 2);
}

function areaOutputSize(width = 1920, height = 1080) {
  return {
    width: evenDimension(width),
    height: evenDimension(height)
  };
}

function recordingOutputSize(resolution = "1080") {
  if (resolution === "2k") return areaOutputSize(2560, 1440);
  return areaOutputSize(1920, 1080);
}

function areaDrawRect(cropWidth, cropHeight, outputWidth, outputHeight) {
  const safeWidth = Math.max(1, Number(cropWidth || 1));
  const safeHeight = Math.max(1, Number(cropHeight || 1));
  const scale = Math.min(outputWidth / safeWidth, outputHeight / safeHeight);
  const width = Math.max(1, Math.round(safeWidth * scale));
  const height = Math.max(1, Math.round(safeHeight * scale));
  return {
    x: Math.floor((outputWidth - width) / 2),
    y: Math.floor((outputHeight - height) / 2),
    width,
    height
  };
}

function recordingDimensions(stream) {
  const settings = stream?.getVideoTracks?.()[0]?.getSettings?.() || {};
  return {
    width: Number(settings.width || 1920),
    height: Number(settings.height || 1080)
  };
}

function recordingBitsPerSecond(stream, options) {
  const { width, height } = recordingDimensions(stream);
  const pixels = Math.max(1, width * height);
  const fps = Math.max(1, Number(options?.fps || 30));
  const megabits = Math.min(80, Math.max(12, (pixels * fps * 0.18) / 1_000_000));
  return Math.round(megabits * 1_000_000);
}

function shouldDrawPointerOverlay(options) {
  if (!Boolean(options?.cursor || options?.clickEffect)) return false;
  if (options?.mode === "window") return Boolean(options?.windowBounds);
  return true;
}

function displayContainsPoint(bounds, point) {
  if (!bounds || !point) return false;
  return point.x >= bounds.x &&
    point.y >= bounds.y &&
    point.x <= bounds.x + bounds.width &&
    point.y <= bounds.y + bounds.height;
}

function pointerPointForArea(pointer, geometry) {
  const bounds = geometry.crop.displayBounds;
  if (!displayContainsPoint(bounds, pointer.position)) return null;
  const scaleFactor = Number(geometry.crop.scaleFactor || pointer.scaleFactor || 1);
  const physicalX = (pointer.position.x - bounds.x) * scaleFactor;
  const physicalY = (pointer.position.y - bounds.y) * scaleFactor;
  const sourceX = physicalX * geometry.scaleX;
  const sourceY = physicalY * geometry.scaleY;
  const localX = sourceX - geometry.cropX;
  const localY = sourceY - geometry.cropY;
  if (localX < 0 || localY < 0 || localX > geometry.cropWidth || localY > geometry.cropHeight) return null;
  return {
    x: geometry.drawRect.x + localX * (geometry.drawRect.width / geometry.cropWidth),
    y: geometry.drawRect.y + localY * (geometry.drawRect.height / geometry.cropHeight)
  };
}

function pointerPointForScreen(pointer, options, geometry) {
  if (options.sourceDisplayId && pointer.displayId && String(options.sourceDisplayId) !== String(pointer.displayId)) return null;
  const bounds = pointer.displayBounds;
  if (!displayContainsPoint(bounds, pointer.position)) return null;
  const scaleFactor = Number(pointer.scaleFactor || 1);
  const sourceWidth = Math.max(1, bounds.width * scaleFactor);
  const sourceHeight = Math.max(1, bounds.height * scaleFactor);
  const physicalX = (pointer.position.x - bounds.x) * scaleFactor;
  const physicalY = (pointer.position.y - bounds.y) * scaleFactor;
  const drawRect = geometry.drawRect || { x: 0, y: 0, width: geometry.output.width, height: geometry.output.height };
  const x = drawRect.x + physicalX * (drawRect.width / sourceWidth);
  const y = drawRect.y + physicalY * (drawRect.height / sourceHeight);
  if (x < 0 || y < 0 || x > geometry.output.width || y > geometry.output.height) return null;
  return { x, y };
}

function pointerPointForWindow(pointer, options, geometry) {
  const bounds = options.windowBounds;
  if (!bounds || !displayContainsPoint(bounds, pointer.position)) return null;
  const localX = pointer.position.x - bounds.x;
  const localY = pointer.position.y - bounds.y;
  const drawRect = geometry.drawRect || { x: 0, y: 0, width: geometry.output.width, height: geometry.output.height };
  const x = drawRect.x + localX * (drawRect.width / Math.max(1, Number(bounds.width || 1)));
  const y = drawRect.y + localY * (drawRect.height / Math.max(1, Number(bounds.height || 1)));
  if (x < 0 || y < 0 || x > geometry.output.width || y > geometry.output.height) return null;
  return { x, y };
}

function pointerPointForCanvas(pointer, options, geometry) {
  if (!pointer?.position) return null;
  if (options.mode === "area") return pointerPointForArea(pointer, geometry);
  if (options.mode === "window") return pointerPointForWindow(pointer, options, geometry);
  return pointerPointForScreen(pointer, options, geometry);
}

function pointerVisualScale(geometry) {
  const widthScale = Number(geometry?.output?.width || 1920) / 1920;
  const heightScale = Number(geometry?.output?.height || 1080) / 1080;
  return Math.max(0.2, Math.min(2, Math.min(widthScale, heightScale)));
}

function drawClickEffect(ctx, point, ageMs, scale = 1) {
  const progress = Math.min(1, Math.max(0, ageMs / 900));
  const alpha = 1 - progress;
  const radius = (18 + progress * 52) * scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 8 * scale;
  ctx.strokeStyle = "#f97316";
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = Math.min(1, alpha + 0.2);
  ctx.lineWidth = 3 * scale;
  ctx.strokeStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius + 7 * scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawTargetCursor(ctx, point, scale = 1) {
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  const radius = 12 * scale;
  const armInner = 7 * scale;
  const armOuter = 22 * scale;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
  ctx.shadowBlur = 4 * scale;
  ctx.lineWidth = 5 * scale;
  ctx.strokeStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.moveTo(x - armOuter, y);
  ctx.lineTo(x - armInner, y);
  ctx.moveTo(x + armInner, y);
  ctx.lineTo(x + armOuter, y);
  ctx.moveTo(x, y - armOuter);
  ctx.lineTo(x, y - armInner);
  ctx.moveTo(x, y + armInner);
  ctx.lineTo(x, y + armOuter);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 2.5 * scale;
  ctx.strokeStyle = "#2563eb";
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.moveTo(x - armOuter, y);
  ctx.lineTo(x - armInner, y);
  ctx.moveTo(x + armInner, y);
  ctx.lineTo(x + armOuter, y);
  ctx.moveTo(x, y - armOuter);
  ctx.lineTo(x, y - armInner);
  ctx.moveTo(x, y + armInner);
  ctx.lineTo(x, y + armOuter);
  ctx.stroke();
  ctx.fillStyle = "#ef4444";
  ctx.beginPath();
  ctx.arc(x, y, 3.5 * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawDefaultCursor(ctx, point, scale = 1) {
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.scale(scale, scale);
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 31);
  ctx.lineTo(8, 23);
  ctx.lineTo(13, 36);
  ctx.lineTo(20, 33);
  ctx.lineTo(15, 21);
  ctx.lineTo(27, 21);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#111827";
  ctx.stroke();
  ctx.restore();
}

function drawPointerOverlay(ctx, options, geometry) {
  const snapshot = state.pointerSnapshot;
  if (!snapshot || !shouldDrawPointerOverlay(options)) return;
  const point = pointerPointForCanvas(snapshot, options, geometry);
  if (!point) return;
  const visualScale = pointerVisualScale(geometry);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (options.mode === "area" && geometry.drawRect) {
    ctx.beginPath();
    ctx.rect(geometry.drawRect.x, geometry.drawRect.y, geometry.drawRect.width, geometry.drawRect.height);
    ctx.clip();
  }
  const lastDownAge = Date.now() - Number(snapshot.lastDownAt || 0);
  if (options.clickEffect) {
    for (const click of snapshot.clicks || []) {
      const clickPoint = pointerPointForCanvas(click, options, geometry);
      const age = Date.now() - Number(click.createdAt || 0);
      if (!clickPoint || age < 0 || age > 900) continue;
      drawClickEffect(ctx, clickPoint, age, visualScale);
    }
  }
  const showPressedCursor = options.clickEffect && (snapshot.isDown || (lastDownAge >= 0 && lastDownAge < 320));
  if (showPressedCursor) {
    drawDefaultCursor(ctx, point, visualScale);
    ctx.restore();
    return;
  }
  if (options.cursor || options.clickEffect) drawTargetCursor(ctx, point, visualScale);
  ctx.restore();
}

async function startPointerOverlay(options) {
  if (!shouldDrawPointerOverlay(options)) return;
  if (options.clickEffect) await bridge.startPointerMonitor?.();
  const poll = async () => {
    try {
      state.pointerSnapshot = await bridge.getPointerSnapshot?.();
    } catch {
      state.pointerSnapshot = null;
    }
  };
  await poll();
  clearInterval(state.pointerPollTimer);
  state.pointerPollTimer = setInterval(poll, 33);
}

const state = {
  status: null,
  project: null,
  selectedAssetId: null,
  selectedSegmentId: null,
  selectedVoiceId: null,
  selectedRenderId: null,
  previewPath: null,
  captureSources: [],
  selectedSourceId: null,
  recorder: null,
  recordChunks: [],
  recordStream: null,
  sourceStream: null,
  cropTimer: null,
  pointerPollTimer: null,
  pointerSnapshot: null,
  selectedArea: null,
  recordingStartedAt: 0,
  recordingWindowVisibleSince: null,
  recordingStopTrimTailSeconds: 0,
  recordingStopping: false,
  recordingTimer: null,
  draggedQueueId: null,
  selectedTextOverlayId: null,
  textOverlayRect: null,
  saveTimer: null,
  previewAudio: null,
  previewAudioVoiceId: null
};

function createDemoBridge() {
  const demoStoreKey = "video-narration-studio-demo";
  const load = () => JSON.parse(localStorage.getItem(demoStoreKey) || "null");
  const save = (project) => {
    localStorage.setItem(demoStoreKey, JSON.stringify(project));
    return project;
  };
  return {
    getStatus: async () => ({
      platform: "browser-demo",
      workspaceRoot: "demo",
      ffmpeg: { ok: false },
      tts: { ok: false }
    }),
    listCaptureSources: async () => [],
    setCapturePreference: async () => {},
    selectCaptureArea: async () => null,
    minimizeToTaskbar: async () => false,
    prepareForRecording: async () => false,
    restoreFromTaskbar: async () => false,
    startPointerMonitor: async () => ({ ok: false }),
    stopPointerMonitor: async () => ({ ok: true }),
    getPointerSnapshot: async () => null,
    createProject: async ({ name }) => save(createBlankProject(name || "合成视频", "demo")),
    createProjectDialog: async () => save(createBlankProject("合成视频", "demo")),
    openProject: async () => load(),
    openProjectFolder: async () => load(),
    saveProject: async (project) => save(project),
    saveProjectFolder: async (project) => save(project),
    registerStopShortcut: async () => false,
    unregisterStopShortcut: async () => true,
    onStopRecordingShortcut: () => () => {},
    importVideos: async () => [],
    saveRecording: async () => {
      throw new Error("浏览器 demo 模式无法保存录屏。请在 Electron 中运行。");
    },
    generateVoice: async () => {
      throw new Error("浏览器 demo 模式无法生成语音。");
    },
    prepareAudioPreview: async ({ path }) => ({ path }),
    synthesizeSegment: async () => {
      throw new Error("浏览器 demo 模式无法合成视频。");
    },
    synthesizeAsset: async () => {
      throw new Error("浏览器 demo 模式无法合成视频。");
    },
    mergeVideos: async () => {
      throw new Error("浏览器 demo 模式无法导出视频。");
    },
    showItem: async () => {},
    openPath: async () => {}
  };
}

function createBlankProject(name, rootDir) {
  const time = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name,
    rootDir,
    createdAt: time,
    updatedAt: time,
    assets: [],
    mergeQueue: [],
    exports: []
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(value) {
  const raw = Number(value || 0);
  const seconds = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatDuration(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return "";
  return formatTime(raw);
}

function formatInsertMoment(value) {
  const raw = Number(value || 0);
  const seconds = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  const rounded = Math.round(seconds * 10) / 10;
  return `第${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}秒`;
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function toMediaUrl(file) {
  if (!file) return "";
  if (bridge.mediaUrl) return bridge.mediaUrl(file);
  if (/^(blob:|data:|https?:|demo:)/.test(file)) return file;
  const normalized = String(file).replaceAll("\\", "/");
  if (normalized.startsWith("/")) return `file://${normalized}`;
  return `file:///${normalized}`;
}

function selectedAsset() {
  return state.project?.assets.find((asset) => asset.id === state.selectedAssetId) || null;
}

function findAssetById(assetId) {
  return state.project?.assets.find((asset) => asset.id === assetId) || null;
}

function findSegmentById(assetId, segmentId) {
  return findAssetById(assetId)?.segments?.find((segment) => segment.id === segmentId) || null;
}

function selectedSegment() {
  const asset = selectedAsset();
  return asset?.segments?.find((segment) => segment.id === state.selectedSegmentId) || null;
}

function selectedVoice(segment = selectedSegment()) {
  return segment?.voiceVersions?.find((version) => version.id === (segment.activeVoiceId || state.selectedVoiceId)) ||
    segment?.voiceVersions?.at(-1) ||
    null;
}

function selectedRender(asset = selectedAsset()) {
  return asset?.renderVersions?.find((version) => version.id === state.selectedRenderId) ||
    asset?.renderVersions?.at(-1) ||
    null;
}

function previewRender(asset = selectedAsset()) {
  if (!asset || !state.previewPath) return null;
  return (asset.renderVersions || []).find((version) =>
    version.path === state.previewPath && (!state.selectedRenderId || version.id === state.selectedRenderId)
  ) || (asset.renderVersions || []).find((version) => version.path === state.previewPath) || null;
}

function currentTextTarget() {
  const asset = selectedAsset();
  if (!asset) return null;
  const render = previewRender(asset);
  if (render) return { type: "render", owner: render, asset, path: render.path };
  if (!state.previewPath || state.previewPath === asset.path) {
    return { type: "asset", owner: asset, asset, path: asset.path };
  }
  return null;
}

function currentTextOverlays() {
  const target = currentTextTarget();
  if (!target?.owner) return [];
  target.owner.textOverlays ||= [];
  return target.owner.textOverlays;
}

function currentPreviewTime() {
  const time = Number(els.videoPreview.currentTime || 0);
  return Number.isFinite(time) ? Math.max(0, time) : 0;
}

function isTextOverlayVisibleAt(overlay, time = currentPreviewTime()) {
  normalizeTextOverlay(overlay);
  return time >= overlay.start && time < overlay.end;
}

function selectedTextOverlay() {
  return currentTextOverlays().find((item) => item.id === state.selectedTextOverlayId) || null;
}

function createSegment(asset, start = 0) {
  const duration = Number(asset?.duration || els.videoPreview.duration || start + 10);
  const end = Math.max(start + 0.1, Math.min(duration || start + 10, start + 10));
  const nextIndex = asset?.segments?.length || 0;
  return {
    id: crypto.randomUUID(),
    title: `段${nextIndex + 1}`,
    start: Number(start.toFixed(1)),
    end: Number(end.toFixed(1)),
    text: "",
    speed: "normal",
    activeVoiceId: null,
    voiceVersions: [],
    renderVersions: []
  };
}

function segmentTitle(segment, index = 0) {
  return String(segment?.title || "").trim() || `段${index + 1}`;
}

function segmentIndex(asset, segmentId) {
  const index = (asset?.segments || []).findIndex((item) => item.id === segmentId);
  return index >= 0 ? index : 0;
}

function isGenericVoiceTitle(value) {
  return /^(旁白语音|未命名语音|段\d+语音?)$/.test(String(value || "").trim());
}

function shouldKeepVoiceTitle(existingVoice, nextDefaultTitle) {
  if (!existingVoice?.title) return false;
  if (existingVoice.titleSource === "manual") return true;
  if (existingVoice.titleSource === "segment") return false;
  return existingVoice.title !== nextDefaultTitle && !isGenericVoiceTitle(existingVoice.title);
}

function syncSegmentVoiceTitles(segment, title, previousTitle = "") {
  const nextTitle = String(title || "").trim();
  if (!segment || !nextTitle) return;
  for (const voice of segment.voiceVersions || []) {
    const currentTitle = String(voice.title || "").trim();
    const canSync =
      voice.titleSource === "segment" ||
      !voice.titleSource ||
      !currentTitle ||
      currentTitle === previousTitle ||
      isGenericVoiceTitle(currentTitle);
    if (!canSync || voice.titleSource === "manual") continue;
    voice.title = nextTitle;
    voice.titleSource = "segment";
  }
}

function ensureDefaultSegment(asset, select = false) {
  if (!asset) return null;
  asset.segments ||= [];
  let created = false;
  if (!asset.segments.length) {
    asset.segments.push(createSegment(asset, 0));
    created = true;
  }
  if (select && !asset.segments.some((segment) => segment.id === state.selectedSegmentId)) {
    state.selectedSegmentId = asset.segments[0]?.id || null;
  }
  if (created) saveProjectSoon();
  return asset.segments[0] || null;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value || 0)));
}

function createTextOverlay(startTime = currentPreviewTime()) {
  const now = new Date().toISOString();
  const start = Math.max(0, Number(startTime || 0));
  const duration = Number(els.videoPreview.duration || 0);
  const rect = state.textOverlayRect || videoContentRect();
  const rawEnd = Number.isFinite(duration) && duration > 0
    ? Math.min(duration, start + TEXT_OVERLAY_DEFAULT_DURATION)
    : start + TEXT_OVERLAY_DEFAULT_DURATION;
  const end = Math.max(start + 0.1, rawEnd);
  return {
    id: crypto.randomUUID(),
    text: "",
    start,
    end,
    x: 0.12,
    y: 0.12,
    width: 0.28,
    height: 0.12,
    fontSize: 16,
    color: "#ffffff",
    backgroundColor: "#111827",
    backgroundOpacity: 0.5,
    previewWidth: Number(rect?.width || 0) || null,
    previewHeight: Number(rect?.height || 0) || null,
    createdAt: now,
    updatedAt: now
  };
}

function normalizeTextOverlay(overlay) {
  const start = Number(overlay.start);
  overlay.start = Number.isFinite(start) ? Math.max(0, start) : 0;
  const end = Number(overlay.end);
  overlay.end = Number.isFinite(end)
    ? Math.max(overlay.start + 0.1, end)
    : overlay.start + TEXT_OVERLAY_DEFAULT_DURATION;
  overlay.x = clampNumber(overlay.x, 0, 0.98);
  overlay.y = clampNumber(overlay.y, 0, 0.98);
  overlay.width = clampNumber(overlay.width || 0.28, 0.04, 1 - overlay.x);
  overlay.height = clampNumber(overlay.height || 0.12, 0.04, 1 - overlay.y);
  overlay.fontSize = TEXT_OVERLAY_FONT_SIZES.includes(Number(overlay.fontSize)) ? Number(overlay.fontSize) : 16;
  if (String(overlay.text || "").trim() === TEXT_OVERLAY_PLACEHOLDER) overlay.text = "";
  overlay.color = /^#[0-9a-f]{6}$/i.test(overlay.color || "") ? overlay.color : "#ffffff";
  overlay.backgroundColor = /^#[0-9a-f]{6}$/i.test(overlay.backgroundColor || "") ? overlay.backgroundColor : "#111827";
  overlay.backgroundOpacity = clampNumber(overlay.backgroundOpacity ?? 0.5, 0, 1);
  return overlay;
}

function videoContentRect() {
  const frameRect = els.videoPreview.parentElement.getBoundingClientRect();
  const videoRect = els.videoPreview.getBoundingClientRect();
  const videoWidth = Number(els.videoPreview.videoWidth || 0);
  const videoHeight = Number(els.videoPreview.videoHeight || 0);
  if (!videoWidth || !videoHeight || !videoRect.width || !videoRect.height) return null;
  const scale = Math.min(videoRect.width / videoWidth, videoRect.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return {
    left: videoRect.left - frameRect.left + (videoRect.width - width) / 2,
    top: videoRect.top - frameRect.top + (videoRect.height - height) / 2,
    width,
    height
  };
}

function updateTextOverlayLayerRect() {
  const rect = videoContentRect();
  state.textOverlayRect = rect;
  if (!rect || !currentTextTarget()) {
    els.textOverlayLayer.style.display = "none";
    els.textStylePanel.hidden = true;
    return null;
  }
  Object.assign(els.textOverlayLayer.style, {
    display: "block",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  });
  return rect;
}

function selectAsset(assetId) {
  if (state.selectedAssetId !== assetId) stopVoicePreview();
  state.selectedAssetId = assetId || null;
  const asset = selectedAsset();
  ensureDefaultSegment(asset, true);
  const segment = selectedSegment();
  state.selectedVoiceId = segment?.activeVoiceId || segment?.voiceVersions?.at(-1)?.id || null;
  state.selectedRenderId = asset?.renderVersions?.at(-1)?.id || null;
  state.previewPath = null;
  state.selectedTextOverlayId = null;
}

function renderLabel(asset, render, index) {
  const voiceCount = render.overlayCount || render.overlays?.length || 0;
  const bakedTextCount = Number(render.textOverlayCount || render.textOverlaysApplied || 0);
  const pendingTextCount = (render.textOverlays || [])
    .map((overlay) => normalizeTextOverlay({ ...overlay }))
    .filter((overlay) => String(overlay.text || "").trim()).length;
  const textCount = bakedTextCount + pendingTextCount;
  return `${asset?.name || "视频"} · 合成视频 ${index + 1} · ${voiceCount} 段旁白${textCount ? ` · ${textCount} 段文字` : ""}`;
}

function refreshAssetRenderLabels(asset) {
  if (!asset) return;
  (asset.renderVersions || []).forEach((render, index) => {
    render.label = renderLabel(asset, render, index);
    const queueItem = state.project?.mergeQueue?.find((item) => item.id === render.id);
    if (queueItem) {
      queueItem.label = render.label;
      queueItem.path = render.path;
      queueItem.assetId = asset.id;
    }
  });
}

function allRenderItems() {
  const project = state.project;
  if (!project) return [];
  const queueMap = new Map((project.mergeQueue || []).map((item, index) => [item.id, { ...item, index }]));
  const items = [];
  for (const asset of project.assets || []) {
    (asset.renderVersions || []).forEach((render, index) => {
      const queued = queueMap.get(render.id);
      items.push({
        ...render,
        assetId: asset.id,
        assetName: asset.name,
        label: queued?.label || render.label || renderLabel(asset, render, index),
        queueIndex: queued?.index ?? Number.POSITIVE_INFINITY,
        selected: Boolean(queued),
        path: queued?.path || render.path
      });
    });
  }
  return items.sort((a, b) => {
    if (a.queueIndex !== b.queueIndex) return a.queueIndex - b.queueIndex;
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  });
}

function queueItemFromRender(render) {
  return {
    id: render.id,
    assetId: render.assetId,
    path: render.path,
    label: render.label,
    addedAt: new Date().toISOString()
  };
}

function showToast(message, tone = "default") {
  els.toast.textContent = message;
  els.toast.style.background = tone === "error" ? "#991b1b" : "#111827";
  els.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove("show"), 3200);
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label || "处理中";
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

function setPreviewVoiceButtonState() {
  const voice = selectedVoice();
  const isPreviewing = Boolean(state.previewAudio && voice?.id === state.previewAudioVoiceId);
  els.previewVoiceBtn.textContent = isPreviewing ? "停止" : "试听";
}

function stopVoicePreview() {
  const audio = state.previewAudio;
  if (audio) {
    audio.pause();
    try {
      audio.currentTime = 0;
    } catch {
      // Some audio sources may not allow seeking before metadata is loaded.
    }
  }
  state.previewAudio = null;
  state.previewAudioVoiceId = null;
  setPreviewVoiceButtonState();
}

async function saveProjectSoon() {
  if (!state.project) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    try {
      state.project = await bridge.saveProject(state.project);
      renderHeader();
    } catch (error) {
      showToast(error.message || "保存项目失败", "error");
    }
  }, 250);
}

async function saveProjectNow() {
  if (!state.project) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  state.project = await bridge.saveProject(state.project);
  renderHeader();
}

async function ensureProject() {
  if (state.project) return state.project;
  state.project = await bridge.createProject({ name: "合成视频" });
  state.selectedAssetId = null;
  state.selectedSegmentId = null;
  renderAll();
  return state.project;
}

function renderHeader() {
  if (!state.project) {
    els.projectSubtitle.textContent = "未打开项目";
    return;
  }
  els.projectSubtitle.textContent = `${state.project.name} · ${state.project.rootDir}`;
}

function renderStatus() {
  if (!els.ffmpegStatus || !els.ttsStatus) return;
  const ffmpegOk = Boolean(state.status?.ffmpeg?.ok);
  const ttsOk = Boolean(state.status?.tts?.ok);
  els.ffmpegStatus.textContent = ffmpegOk ? "FFmpeg 可用" : "FFmpeg 未配置";
  els.ffmpegStatus.className = `pill ${ffmpegOk ? "ok" : "warn"}`;
  els.ttsStatus.textContent = ttsOk ? `TTS ${state.status.tts.label}` : "TTS 未配置";
  els.ttsStatus.className = `pill ${ttsOk ? "ok" : "warn"}`;
}

function renderAssets() {
  const assets = state.project?.assets || [];
  els.assetCount.textContent = String(assets.length);
  if (!assets.length) {
    els.assetList.innerHTML = `<div class="item-meta">暂无素材</div>`;
    return;
  }
  els.assetList.innerHTML = assets.map((asset) => `
    <div class="list-item ${asset.id === state.selectedAssetId ? "active" : ""}" data-asset-id="${asset.id}" role="button" tabindex="0">
      <button class="asset-delete-button" data-delete-asset-id="${asset.id}" title="删除素材" aria-label="删除素材">×</button>
      <span class="item-title">
        <input class="asset-title-input" data-asset-title-id="${asset.id}" value="${escapeHtml(asset.name)}" aria-label="素材名称">
        <span class="version-actions">
          <span>${asset.kind === "recording" ? "录屏" : "导入"}</span>
        </span>
      </span>
      <span class="item-meta">${formatTime(asset.duration)} · ${(asset.segments || []).length} 段文字稿</span>
    </div>
  `).join("");
  els.assetList.querySelectorAll("[data-delete-asset-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteAsset(button.dataset.deleteAssetId);
    });
  });
  els.assetList.querySelectorAll("[data-asset-title-id]").forEach((input) => {
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("input", () => {
      const asset = findAssetById(input.dataset.assetTitleId);
      if (!asset) return;
      asset.name = input.value;
      refreshAssetRenderLabels(asset);
      if (asset.id === state.selectedAssetId) els.previewTitle.textContent = asset.name || "未命名素材";
      saveProjectSoon();
    });
    input.addEventListener("blur", () => {
      const asset = findAssetById(input.dataset.assetTitleId);
      if (!asset) return;
      asset.name = String(input.value || "").trim() || "未命名素材";
      input.value = asset.name;
      refreshAssetRenderLabels(asset);
      saveProjectSoon();
      renderAll();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
    });
  });
  els.assetList.querySelectorAll("[data-asset-id]").forEach((item) => {
    const select = () => {
      selectAsset(item.dataset.assetId);
      renderAll();
    };
    item.addEventListener("click", (event) => {
      if (event.target.closest("button,input")) return;
      select();
    });
    item.addEventListener("keydown", (event) => {
      if (event.target.closest("button,input")) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      select();
    });
  });
}

function textOverlaySummary(overlay) {
  const text = String(overlay?.text || "").trim();
  return text || "未填写文字";
}

function syncInsertedTextListSelection() {
  if (!els.insertedTextList) return;
  els.insertedTextList.querySelectorAll("[data-text-overlay-list-id]").forEach((item) => {
    item.classList.toggle("active", item.dataset.textOverlayListId === state.selectedTextOverlayId);
  });
}

function renderInsertedTextList() {
  if (!els.insertedTextCount || !els.insertedTextList) return;
  const overlays = currentTextOverlays()
    .map((overlay) => normalizeTextOverlay(overlay))
    .sort((a, b) => a.start - b.start || String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  els.insertedTextCount.textContent = String(overlays.length);
  if (!overlays.length) {
    els.insertedTextList.innerHTML = `<div class="item-meta">暂无插入文字</div>`;
    return;
  }

  els.insertedTextList.innerHTML = overlays.map((overlay) => {
    const summary = textOverlaySummary(overlay);
    return `
      <div class="inserted-text-item ${overlay.id === state.selectedTextOverlayId ? "active" : ""}" data-text-overlay-list-id="${overlay.id}" data-tooltip="${escapeHtml(summary)}" title="${escapeHtml(summary)}" role="button" tabindex="0">
        <div class="inserted-text-title">${escapeHtml(formatInsertMoment(overlay.start))}</div>
        <div class="inserted-text-content">${escapeHtml(summary)}</div>
      </div>
    `;
  }).join("");

  els.insertedTextList.querySelectorAll("[data-text-overlay-list-id]").forEach((item) => {
    const select = () => {
      const overlay = currentTextOverlays().find((value) => value.id === item.dataset.textOverlayListId);
      if (!overlay) return;
      normalizeTextOverlay(overlay);
      state.selectedTextOverlayId = overlay.id;
      els.videoPreview.pause();
      if (Number.isFinite(Number(overlay.start))) {
        try {
          const duration = Number(els.videoPreview.duration || 0);
          els.videoPreview.currentTime = Number.isFinite(duration) && duration > 0
            ? Math.min(duration, overlay.start)
            : overlay.start;
        } catch {
          // The video element may not be seekable until metadata is loaded.
        }
      }
      renderTextOverlays();
      renderInsertedTextList();
    };
    item.addEventListener("click", select);
    item.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      select();
    });
  });
}

function voiceDurationText(version) {
  return formatDuration(version?.duration ?? version?.voiceDuration ?? version?.segmentDuration);
}

function deleteAsset(assetId) {
  if (!state.project || !assetId) return;
  const asset = findAssetById(assetId);
  if (!asset) return;
  if (!confirm(`删除视频素材“${asset.name}”？该操作只会从当前项目移除，不会删除磁盘文件。`)) return;
  stopVoicePreview();

  const renderIds = new Set((asset.renderVersions || []).map((render) => render.id));
  const assetPreviewPaths = new Set([
    asset.path,
    ...(asset.renderVersions || []).map((render) => render.path)
  ].filter(Boolean));

  state.project.assets = (state.project.assets || []).filter((item) => item.id !== assetId);
  state.project.mergeQueue = (state.project.mergeQueue || []).filter((item) => !renderIds.has(item.id));

  if (state.selectedAssetId === assetId) {
    const nextAsset = state.project.assets[0] || null;
    state.selectedAssetId = nextAsset?.id || null;
    state.selectedSegmentId = nextAsset?.segments?.[0]?.id || null;
    const segment = selectedSegment();
    state.selectedVoiceId = segment?.activeVoiceId || segment?.voiceVersions?.at(-1)?.id || null;
    state.selectedRenderId = nextAsset?.renderVersions?.at(-1)?.id || null;
  }
  if (assetPreviewPaths.has(state.previewPath)) state.previewPath = null;

  saveProjectSoon();
  renderAll();
  showToast("视频素材已删除");
}

function deleteVoice(voiceId, segmentId = state.selectedSegmentId) {
  const segment = findSegmentById(state.selectedAssetId, segmentId);
  if (!segment || !voiceId) return;
  const voice = segment.voiceVersions?.find((item) => item.id === voiceId);
  if (!voice) return;
  const title = voice.title || "旁白语音";
  if (!confirm(`删除转写语音“${title}”？该操作只会从当前项目移除，不会删除磁盘文件。`)) return;
  if (state.previewAudioVoiceId === voiceId) stopVoicePreview();

  segment.voiceVersions = (segment.voiceVersions || []).filter((item) => item.id !== voiceId);
  const nextVoice = segment.voiceVersions.at(-1) || null;
  segment.activeVoiceId = nextVoice?.id || null;
  if (state.selectedVoiceId === voiceId) state.selectedVoiceId = nextVoice?.id || null;

  saveProjectSoon();
  renderAll();
  showToast("转写语音已删除");
}

function deleteRenderVersion(renderId) {
  if (!state.project || !renderId) return;
  let ownerAsset = null;
  let render = null;
  for (const asset of state.project.assets || []) {
    render = (asset.renderVersions || []).find((item) => item.id === renderId);
    if (render) {
      ownerAsset = asset;
      break;
    }
  }
  if (!ownerAsset || !render) return;
  if (!confirm(`删除合成视频“${render.label || "合成视频"}”？该操作只会从当前项目移除，不会删除磁盘文件。`)) return;

  ownerAsset.renderVersions = (ownerAsset.renderVersions || []).filter((item) => item.id !== renderId);
  state.project.mergeQueue = (state.project.mergeQueue || []).filter((item) => item.id !== renderId);
  if (state.selectedRenderId === renderId) state.selectedRenderId = ownerAsset.renderVersions.at(-1)?.id || null;
  if (state.previewPath === render.path) state.previewPath = null;

  saveProjectSoon();
  renderAll();
  showToast("合成视频已删除");
}

function rgbaFromHex(hex, opacity) {
  const color = /^#[0-9a-f]{6}$/i.test(hex || "") ? hex : "#111827";
  const alpha = clampNumber(opacity ?? 0.5, 0, 1);
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `rgb(${r} ${g} ${b} / ${alpha})`;
}

function syncTextStylePanel() {
  const overlay = selectedTextOverlay();
  const target = currentTextTarget();
  els.insertTextBtn.disabled = !target;
  const isVisible = overlay ? isTextOverlayVisibleAt(overlay) : false;
  els.textStylePanel.hidden = !overlay || !target || !isVisible;
  if (!overlay || !isVisible) return;
  normalizeTextOverlay(overlay);
  els.textFontSize.value = String(overlay.fontSize);
  els.textColor.value = overlay.color;
  els.textBgColor.value = overlay.backgroundColor;
  els.textBgOpacity.value = String(overlay.backgroundOpacity);
  positionTextStylePanel(overlay);
}

function positionTextStylePanel(overlay) {
  const rect = state.textOverlayRect;
  if (!overlay || !rect || els.textStylePanel.hidden) return;
  const frame = els.videoPreview.parentElement;
  const frameWidth = frame.clientWidth || rect.width;
  const frameHeight = frame.clientHeight || rect.height;
  const panelWidth = els.textStylePanel.offsetWidth || 310;
  const panelHeight = els.textStylePanel.offsetHeight || 48;
  const gap = 10;
  const margin = 8;
  let left = rect.left + (overlay.x + overlay.width / 2) * rect.width - panelWidth / 2;
  let top = rect.top + overlay.y * rect.height - gap;
  let translateY = "-100%";

  if (top - panelHeight < margin) {
    top = rect.top + (overlay.y + overlay.height) * rect.height + gap;
    translateY = "0";
  }

  left = clampNumber(left, margin, Math.max(margin, frameWidth - panelWidth - margin));
  const maxTop = translateY === "0"
    ? Math.max(margin, frameHeight - panelHeight - margin)
    : Math.max(margin, frameHeight - margin);
  top = clampNumber(top, margin, maxTop);
  Object.assign(els.textStylePanel.style, {
    left: `${left}px`,
    top: `${top}px`,
    transform: `translateY(${translateY})`
  });
}

function renderTextOverlays() {
  const rect = updateTextOverlayLayerRect();
  const target = currentTextTarget();
  if (!rect || !target) {
    els.textOverlayLayer.innerHTML = "";
    syncTextStylePanel();
    return;
  }
  const overlays = currentTextOverlays();
  if (!overlays.some((item) => item.id === state.selectedTextOverlayId)) {
    state.selectedTextOverlayId = null;
  }
  const visibleOverlays = overlays.filter((overlay) => isTextOverlayVisibleAt(overlay));
  els.textOverlayLayer.innerHTML = visibleOverlays.map((overlay) => {
    normalizeTextOverlay(overlay);
    const active = overlay.id === state.selectedTextOverlayId;
    const style = [
      `left:${overlay.x * 100}%`,
      `top:${overlay.y * 100}%`,
      `width:${overlay.width * 100}%`,
      `height:${overlay.height * 100}%`,
      `font-size:${overlay.fontSize}px`,
      `color:${overlay.color}`,
      `background:${rgbaFromHex(overlay.backgroundColor, overlay.backgroundOpacity)}`
    ].join(";");
    return `
      <div class="text-overlay-box ${active ? "active" : ""}" data-text-overlay-id="${overlay.id}" style="${style}">
        <div class="text-overlay-content" contenteditable="true" spellcheck="false" data-placeholder="${escapeHtml(TEXT_OVERLAY_PLACEHOLDER)}">${escapeHtml(overlay.text || "")}</div>
        <span class="resize-handle nw" data-resize-handle="nw"></span>
        <span class="resize-handle ne" data-resize-handle="ne"></span>
        <span class="resize-handle sw" data-resize-handle="sw"></span>
        <span class="resize-handle se" data-resize-handle="se"></span>
      </div>
    `;
  }).join("");
  attachTextOverlayEvents();
  syncTextStylePanel();
}

function updateTextOverlay(overlay, changes) {
  if (!overlay) return;
  const rect = state.textOverlayRect || videoContentRect();
  Object.assign(overlay, changes, {
    previewWidth: Number(rect?.width || 0) || overlay.previewWidth || null,
    previewHeight: Number(rect?.height || 0) || overlay.previewHeight || null,
    updatedAt: new Date().toISOString()
  });
  normalizeTextOverlay(overlay);
  saveProjectSoon();
  renderInsertedTextList();
}

function placeCaretAtEnd(element) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function placeCaretFromPoint(element, clientX, clientY) {
  const selection = window.getSelection();
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(clientX, clientY);
  } else if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(clientX, clientY);
    if (position) {
      range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
    }
  }
  if (!range || !element.contains(range.startContainer)) {
    placeCaretAtEnd(element);
    return;
  }
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function attachTextOverlayEvents() {
  els.textOverlayLayer.querySelectorAll("[data-text-overlay-id]").forEach((box) => {
    const overlayId = box.dataset.textOverlayId;
    const content = box.querySelector(".text-overlay-content");
    const beginEditing = () => {
      content.classList.add("editing");
      const overlay = currentTextOverlays().find((item) => item.id === overlayId);
      if (String(overlay?.text || content.textContent || "").trim() !== TEXT_OVERLAY_PLACEHOLDER) return;
      content.textContent = "";
      updateTextOverlay(overlay, { text: "" });
    };
    const select = () => {
      state.selectedTextOverlayId = overlayId;
      els.textOverlayLayer.querySelectorAll(".text-overlay-box").forEach((item) => {
        item.classList.toggle("active", item === box);
      });
      syncTextStylePanel();
      syncInsertedTextListSelection();
    };
    box.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".resize-handle") || event.target.closest(".text-overlay-content")) return;
      event.preventDefault();
      select();
      startTextOverlayDrag(event, overlayId);
    });
    box.addEventListener("click", (event) => {
      if (event.target.closest(".text-overlay-content")) return;
      select();
    });
    content.addEventListener("focus", () => {
      select();
      beginEditing();
    });
    content.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const overlay = currentTextOverlays().find((item) => item.id === overlayId);
      const rect = state.textOverlayRect || updateTextOverlayLayerRect();
      if (!overlay || !rect) return;
      event.preventDefault();
      select();

      const start = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        x: overlay.x,
        y: overlay.y
      };
      let dragging = false;
      const move = (moveEvent) => {
        const distance = Math.hypot(moveEvent.clientX - start.pointerX, moveEvent.clientY - start.pointerY);
        if (!dragging && distance < 4) return;
        if (!dragging) {
          dragging = true;
          content.blur();
          content.classList.remove("editing");
        }
        const dx = (moveEvent.clientX - start.pointerX) / rect.width;
        const dy = (moveEvent.clientY - start.pointerY) / rect.height;
        overlay.x = clampNumber(start.x + dx, 0, 1 - overlay.width);
        overlay.y = clampNumber(start.y + dy, 0, 1 - overlay.height);
        renderTextOverlays();
      };
      const up = (upEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (dragging) {
          updateTextOverlay(overlay, {});
          return;
        }
        beginEditing();
        content.focus();
        placeCaretFromPoint(content, upEvent.clientX, upEvent.clientY);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
    });
    content.addEventListener("blur", () => {
      content.classList.remove("editing");
    });
    content.addEventListener("input", () => {
      const overlay = currentTextOverlays().find((item) => item.id === overlayId);
      updateTextOverlay(overlay, { text: content.textContent || "" });
    });
    box.querySelectorAll("[data-resize-handle]").forEach((handle) => {
      handle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.selectedTextOverlayId = overlayId;
        startTextOverlayResize(event, overlayId, handle.dataset.resizeHandle);
      });
    });
  });
}

function startTextOverlayDrag(event, overlayId) {
  const overlay = currentTextOverlays().find((item) => item.id === overlayId);
  const rect = state.textOverlayRect || updateTextOverlayLayerRect();
  if (!overlay || !rect) return;
  const start = {
    pointerX: event.clientX,
    pointerY: event.clientY,
    x: overlay.x,
    y: overlay.y
  };
  const move = (moveEvent) => {
    const dx = (moveEvent.clientX - start.pointerX) / rect.width;
    const dy = (moveEvent.clientY - start.pointerY) / rect.height;
    overlay.x = clampNumber(start.x + dx, 0, 1 - overlay.width);
    overlay.y = clampNumber(start.y + dy, 0, 1 - overlay.height);
    renderTextOverlays();
  };
  const up = () => {
    updateTextOverlay(overlay, {});
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
}

function startTextOverlayResize(event, overlayId, handle) {
  const overlay = currentTextOverlays().find((item) => item.id === overlayId);
  const rect = state.textOverlayRect || updateTextOverlayLayerRect();
  if (!overlay || !rect) return;
  const start = {
    pointerX: event.clientX,
    pointerY: event.clientY,
    x: overlay.x,
    y: overlay.y,
    width: overlay.width,
    height: overlay.height
  };
  const minWidth = Math.min(0.18, Math.max(0.06, 44 / rect.width));
  const minHeight = Math.min(0.18, Math.max(0.06, 28 / rect.height));
  const move = (moveEvent) => {
    const dx = (moveEvent.clientX - start.pointerX) / rect.width;
    const dy = (moveEvent.clientY - start.pointerY) / rect.height;
    let nextX = start.x;
    let nextY = start.y;
    let nextWidth = start.width;
    let nextHeight = start.height;
    if (handle.includes("e")) nextWidth = start.width + dx;
    if (handle.includes("s")) nextHeight = start.height + dy;
    if (handle.includes("w")) {
      nextX = start.x + dx;
      nextWidth = start.width - dx;
    }
    if (handle.includes("n")) {
      nextY = start.y + dy;
      nextHeight = start.height - dy;
    }
    nextWidth = clampNumber(nextWidth, minWidth, 1);
    nextHeight = clampNumber(nextHeight, minHeight, 1);
    nextX = clampNumber(nextX, 0, start.x + start.width - minWidth);
    nextY = clampNumber(nextY, 0, start.y + start.height - minHeight);
    if (nextX + nextWidth > 1) nextWidth = 1 - nextX;
    if (nextY + nextHeight > 1) nextHeight = 1 - nextY;
    overlay.x = nextX;
    overlay.y = nextY;
    overlay.width = nextWidth;
    overlay.height = nextHeight;
    renderTextOverlays();
  };
  const up = () => {
    updateTextOverlay(overlay, {});
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
}

function handleInsertTextOverlay() {
  const target = currentTextTarget();
  if (!target) {
    showToast("请选择可编辑的视频素材或合成视频", "error");
    return;
  }
  els.videoPreview.pause();
  target.owner.textOverlays ||= [];
  const overlay = createTextOverlay(currentPreviewTime());
  target.owner.textOverlays.push(overlay);
  state.selectedTextOverlayId = overlay.id;
  saveProjectSoon();
  renderTextOverlays();
  renderInsertedTextList();
  requestAnimationFrame(() => {
    const content = els.textOverlayLayer.querySelector(`[data-text-overlay-id="${overlay.id}"] .text-overlay-content`);
    if (!content) return;
    content.classList.add("editing");
    content.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(content);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

function deleteSelectedTextOverlay() {
  const target = currentTextTarget();
  if (!target || !state.selectedTextOverlayId) return;
  target.owner.textOverlays = (target.owner.textOverlays || []).filter((item) => item.id !== state.selectedTextOverlayId);
  state.selectedTextOverlayId = null;
  saveProjectSoon();
  renderTextOverlays();
  renderInsertedTextList();
}

function updateSelectedTextStyle() {
  const overlay = selectedTextOverlay();
  if (!overlay) return;
  updateTextOverlay(overlay, {
    fontSize: Number(els.textFontSize.value || 16),
    color: els.textColor.value,
    backgroundColor: els.textBgColor.value,
    backgroundOpacity: Number(els.textBgOpacity.value || 0)
  });
  renderTextOverlays();
}

function renderPreview() {
  const asset = selectedAsset();
  const path = state.previewPath || asset?.path || "";
  els.emptyPreview.style.display = path ? "none" : "grid";
  els.videoPreview.style.display = path ? "block" : "none";
  if (path && els.videoPreview.dataset.path !== path) {
    els.videoPreview.dataset.path = path;
    els.videoPreview.src = toMediaUrl(path);
  }
  els.previewTitle.textContent = asset ? asset.name : "预览";
  const segment = selectedSegment();
  const meta = segment
    ? `${formatTime(segment.start)} - ${formatTime(segment.end)} · ${segment.voiceVersions?.length || 0} 个语音版本`
    : asset ? `${formatTime(asset.duration)} · 未选择文字稿段` : "请选择素材";
  els.previewMeta.textContent = meta;
  requestAnimationFrame(renderTextOverlays);
}

function renderInspector() {
  const asset = selectedAsset();
  if (asset) ensureDefaultSegment(asset, true);
  const segment = selectedSegment();
  const hasSegment = Boolean(segment);
  const currentVoice = selectedVoice(segment);
  const hasAnyVoice = Boolean(asset?.segments?.some((item) => selectedVoice(item)));
  const textTarget = currentTextTarget();
  const hasAnyTextOverlay = Boolean(currentTextOverlays().length);
  els.segmentStart.disabled = !hasSegment;
  els.segmentEnd.disabled = !hasSegment;
  els.scriptText.disabled = !hasSegment;
  els.speedSelect.disabled = !hasSegment;
  els.generateVoiceBtn.disabled = !hasSegment;
  els.previewVoiceBtn.disabled = !hasSegment || !currentVoice;
  setPreviewVoiceButtonState();
  els.synthesizeBtn.disabled = !asset || (textTarget?.type === "render" ? !hasAnyTextOverlay : (!hasAnyVoice && !hasAnyTextOverlay));

  els.segmentStart.value = hasSegment ? Number(segment.start || 0).toFixed(1) : "0";
  els.segmentEnd.value = hasSegment ? Number(segment.end || 10).toFixed(1) : "10";
  els.scriptText.value = hasSegment ? segment.text || "" : "";
  els.speedSelect.value = hasSegment ? segment.speed || "normal" : "normal";
  renderSegmentList();

  const voiceItems = (asset?.segments || []).flatMap((item, segmentIndex) =>
    (item.voiceVersions || []).map((version, voiceIndex) => ({
      ...version,
      segmentId: item.id,
      segmentIndex,
      segmentTitle: segmentTitle(item, segmentIndex),
      segmentDuration: Math.max(0, Number(item.end || 0) - Number(item.start || 0)),
      voiceIndex
    }))
  );
  els.versionCount.textContent = String(voiceItems.length);

  els.voiceVersions.innerHTML = voiceItems.length ? voiceItems.map((version) => `
    <div class="version-item ${version.id === state.selectedVoiceId ? "active" : ""}" data-voice-id="${version.id}" data-voice-segment-id="${version.segmentId}">
      <button class="delete-icon-button version-delete-button" data-delete-voice-id="${version.id}" data-delete-voice-segment-id="${version.segmentId}" title="删除语音" aria-label="删除语音">×</button>
      <span class="item-title">
        <input class="voice-title-input" data-voice-title-id="${version.id}" data-voice-title-segment-id="${version.segmentId}" value="${escapeHtml(version.title || version.segmentTitle)}" aria-label="语音标题">
        <span class="voice-duration">${escapeHtml(voiceDurationText(version))}</span>
      </span>
      <span class="item-meta">${formatDate(version.createdAt)}</span>
    </div>
  `).join("") : `<div class="item-meta">暂无语音</div>`;

  els.voiceVersions.querySelectorAll("[data-voice-id]").forEach((item) => {
    item.addEventListener("click", (event) => {
      if (event.target.closest("input,button,label")) return;
      if (state.selectedVoiceId !== item.dataset.voiceId) stopVoicePreview();
      state.selectedSegmentId = item.dataset.voiceSegmentId;
      state.selectedVoiceId = item.dataset.voiceId;
      const current = selectedSegment();
      if (current) current.activeVoiceId = state.selectedVoiceId;
      saveProjectSoon();
      renderInspector();
    });
  });
  els.voiceVersions.querySelectorAll("[data-voice-title-id]").forEach((input) => {
    input.addEventListener("focus", () => {
      if (state.selectedVoiceId !== input.dataset.voiceTitleId) stopVoicePreview();
      state.selectedSegmentId = input.dataset.voiceTitleSegmentId;
      state.selectedVoiceId = input.dataset.voiceTitleId;
      const current = selectedSegment();
      if (current) current.activeVoiceId = state.selectedVoiceId;
      els.voiceVersions.querySelectorAll("[data-voice-id]").forEach((item) => {
        item.classList.toggle("active", item.dataset.voiceId === state.selectedVoiceId);
      });
      saveProjectSoon();
    });
    input.addEventListener("input", () => {
      const current = findSegmentById(state.selectedAssetId, input.dataset.voiceTitleSegmentId);
      const voice = current?.voiceVersions?.find((item) => item.id === input.dataset.voiceTitleId);
      if (!voice) return;
      voice.title = input.value;
      voice.titleSource = "manual";
      saveProjectSoon();
    });
    input.addEventListener("blur", () => {
      const current = findSegmentById(state.selectedAssetId, input.dataset.voiceTitleSegmentId);
      const voice = current?.voiceVersions?.find((item) => item.id === input.dataset.voiceTitleId);
      if (!voice) return;
      const nextTitle = String(input.value || "").trim();
      voice.title = nextTitle || segmentTitle(current, segmentIndex(selectedAsset(), current.id));
      voice.titleSource = nextTitle ? "manual" : "segment";
      input.value = voice.title;
      saveProjectSoon();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
    });
  });
  els.voiceVersions.querySelectorAll("[data-delete-voice-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteVoice(button.dataset.deleteVoiceId, button.dataset.deleteVoiceSegmentId);
    });
  });
}

function renderSegmentList() {
  const asset = selectedAsset();
  const segments = asset?.segments || [];
  if (!els.segmentList) return;
  if (!segments.length) {
    els.segmentList.innerHTML = `<div class="item-meta">暂无文字稿段</div>`;
    return;
  }
  els.segmentList.innerHTML = segments.map((segment, index) => {
    const text = String(segment.text || "").trim();
    return `
      <div class="segment-list-item ${segment.id === state.selectedSegmentId ? "active" : ""}" data-segment-id="${segment.id}" role="button" tabindex="0">
        <span class="item-title">
          <input class="segment-title-input" data-segment-title-id="${segment.id}" data-segment-previous-title="${escapeHtml(segmentTitle(segment, index))}" value="${escapeHtml(segmentTitle(segment, index))}" aria-label="文字稿标题">
          <span>${formatTime(segment.start)}-${formatTime(segment.end)}</span>
        </span>
        <span class="item-meta">${escapeHtml(text || "未填写文字稿")}</span>
      </div>
    `;
  }).join("");
  els.segmentList.querySelectorAll("[data-segment-title-id]").forEach((input) => {
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("focus", () => {
      if (state.selectedSegmentId !== input.dataset.segmentTitleId) stopVoicePreview();
      state.selectedSegmentId = input.dataset.segmentTitleId;
      const segment = selectedSegment();
      state.selectedVoiceId = segment?.activeVoiceId || segment?.voiceVersions?.at(-1)?.id || null;
      state.selectedRenderId = selectedAsset()?.renderVersions?.at(-1)?.id || null;
      els.segmentList.querySelectorAll("[data-segment-id]").forEach((item) => {
        item.classList.toggle("active", item.dataset.segmentId === state.selectedSegmentId);
      });
    });
    input.addEventListener("input", () => {
      const asset = selectedAsset();
      const segment = findSegmentById(state.selectedAssetId, input.dataset.segmentTitleId);
      if (!segment) return;
      const previousTitle = input.dataset.segmentPreviousTitle || "";
      segment.title = input.value;
      syncSegmentVoiceTitles(segment, input.value, previousTitle);
      saveProjectSoon();
    });
    input.addEventListener("blur", () => {
      const asset = selectedAsset();
      const segment = findSegmentById(state.selectedAssetId, input.dataset.segmentTitleId);
      if (!segment) return;
      const previousTitle = input.dataset.segmentPreviousTitle || "";
      const title = String(input.value || "").trim() || segmentTitle(segment, segmentIndex(asset, segment.id));
      segment.title = title;
      syncSegmentVoiceTitles(segment, title, previousTitle);
      input.value = title;
      input.dataset.segmentPreviousTitle = title;
      saveProjectSoon();
      renderInspector();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
    });
  });
  els.segmentList.querySelectorAll("[data-segment-id]").forEach((item) => {
    const selectSegment = () => {
      updateSegmentFromForm();
      if (state.selectedSegmentId !== item.dataset.segmentId) stopVoicePreview();
      state.selectedSegmentId = item.dataset.segmentId;
      const segment = selectedSegment();
      state.selectedVoiceId = segment?.activeVoiceId || segment?.voiceVersions?.at(-1)?.id || null;
      state.selectedRenderId = selectedAsset()?.renderVersions?.at(-1)?.id || null;
      state.previewPath = null;
      renderAll();
    };
    item.addEventListener("click", (event) => {
      if (event.target.closest("input")) return;
      selectSegment();
    });
    item.addEventListener("keydown", (event) => {
      if (event.target.closest("input")) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectSegment();
    });
  });
}

function renderMergeQueue() {
  const items = allRenderItems();
  els.queueCount.textContent = String(items.length);
  if (!items.length) {
    els.mergeQueue.innerHTML = `<div class="item-meta">暂无合成视频</div>`;
    return;
  }
  els.mergeQueue.innerHTML = items.map((item) => {
    const selectedIndex = item.selected ? item.queueIndex + 1 : null;
    return `
    <div class="queue-item ${item.selected ? "active" : ""} ${item.id === state.selectedRenderId ? "previewing" : ""}" draggable="${item.selected}" data-queue-id="${item.id}" role="button" tabindex="0">
      <span class="item-title">
        <label class="merge-check">
          <input type="checkbox" data-merge-render-id="${item.id}" ${item.selected ? "checked" : ""}>
          <span>${selectedIndex ? `${selectedIndex}. ` : ""}${escapeHtml(item.label)}</span>
        </label>
        <span class="version-actions">
          <button class="delete-icon-button" data-delete-render-id="${item.id}" title="删除合成视频" aria-label="删除合成视频">×</button>
        </span>
      </span>
      <span class="item-meta">${formatDate(item.createdAt)}</span>
    </div>
  `;
  }).join("");

  els.mergeQueue.querySelectorAll("[data-delete-render-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteRenderVersion(button.dataset.deleteRenderId);
    });
  });
  els.mergeQueue.querySelectorAll("[data-merge-render-id]").forEach((checkbox) => {
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", (event) => {
      event.stopPropagation();
      const render = allRenderItems().find((item) => item.id === checkbox.dataset.mergeRenderId);
      toggleMergeQueue(render, checkbox.checked);
    });
  });
  els.mergeQueue.querySelectorAll(".queue-item").forEach((item) => {
    const loadRenderPreview = () => {
      const render = allRenderItems().find((value) => value.id === item.dataset.queueId);
      if (!render) return;
      selectAsset(render.assetId || state.selectedAssetId);
      state.selectedRenderId = render.id;
      state.previewPath = render.path;
      renderAll();
    };
    item.addEventListener("click", (event) => {
      if (event.target.closest("input,label,button")) return;
      loadRenderPreview();
    });
    item.addEventListener("keydown", (event) => {
      if (event.target.closest("input,label,button")) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      loadRenderPreview();
    });
    item.addEventListener("dragstart", () => {
      if (item.getAttribute("draggable") !== "true") return;
      state.draggedQueueId = item.dataset.queueId;
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => {
      state.draggedQueueId = null;
      item.classList.remove("dragging");
    });
    item.addEventListener("dragover", (event) => event.preventDefault());
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      reorderQueue(state.draggedQueueId, item.dataset.queueId);
    });
  });
}

function renderAll() {
  renderHeader();
  renderStatus();
  renderAssets();
  renderPreview();
  renderInsertedTextList();
  renderInspector();
  renderMergeQueue();
}

function updateSegmentFromForm() {
  const segment = selectedSegment();
  if (!segment) return;
  const start = Math.max(0, Number(els.segmentStart.value || 0));
  const end = Math.max(start + 0.1, Number(els.segmentEnd.value || start + 0.1));
  segment.start = start;
  segment.end = end;
  segment.text = els.scriptText.value;
  segment.speed = els.speedSelect.value;
  saveProjectSoon();
  renderSegmentList();
}

function addSegment() {
  const asset = selectedAsset();
  if (!asset) {
    showToast("请先选择视频素材", "error");
    return;
  }
  updateSegmentFromForm();
  asset.segments ||= [];
  const current = Math.max(0, Number(els.videoPreview.currentTime || 0));
  const segment = createSegment(asset, current);
  asset.segments.push(segment);
  state.selectedSegmentId = segment.id;
  state.selectedVoiceId = null;
  state.selectedRenderId = null;
  saveProjectSoon();
  renderAll();
}

function toggleMergeQueue(render, checked) {
  if (!render || !state.project) return;
  state.project.mergeQueue ||= [];
  if (checked) {
    const queueItem = queueItemFromRender(render);
    const existing = state.project.mergeQueue.find((item) => item.id === render.id);
    if (existing) Object.assign(existing, queueItem, { addedAt: existing.addedAt || queueItem.addedAt });
    else state.project.mergeQueue.push(queueItem);
  } else {
    state.project.mergeQueue = state.project.mergeQueue.filter((item) => item.id !== render.id);
  }
  saveProjectSoon();
  renderMergeQueue();
  renderInspector();
}

function reorderQueue(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId || !state.project?.mergeQueue) return;
  const queue = state.project.mergeQueue;
  const sourceIndex = queue.findIndex((item) => item.id === sourceId);
  const targetIndex = queue.findIndex((item) => item.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const [source] = queue.splice(sourceIndex, 1);
  queue.splice(targetIndex, 0, source);
  saveProjectSoon();
  renderMergeQueue();
}

function resetSelectionForProject(project) {
  state.selectedAssetId = project?.assets?.[0]?.id || null;
  ensureDefaultSegment(selectedAsset(), true);
  const segment = selectedSegment();
  state.selectedVoiceId = segment?.activeVoiceId || segment?.voiceVersions?.at(-1)?.id || null;
  state.selectedRenderId = selectedAsset()?.renderVersions?.at(-1)?.id || null;
  state.previewPath = null;
  state.selectedSourceId = null;
  state.selectedArea = null;
  state.draggedQueueId = null;
  state.selectedTextOverlayId = null;
}

async function handleNewProject() {
  stopVoicePreview();
  updateSegmentFromForm();
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  setBusy(els.newProjectBtn, true, "创建中");
  try {
    if (state.project) await saveProjectNow();
    const project = await bridge.createProjectDialog();
    if (!project) return;
    state.project = project;
    resetSelectionForProject(project);
    renderAll();
    showToast("新项目已创建");
  } catch (error) {
    showToast(error.message || "新建项目失败", "error");
  } finally {
    setBusy(els.newProjectBtn, false);
  }
}

async function handleSaveProjectFolder() {
  const project = await ensureProject();
  updateSegmentFromForm();
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  setBusy(els.saveProjectBtn, true, "保存中");
  try {
    const saved = await bridge.saveProjectFolder(project);
    if (!saved) return;
    state.project = saved;
    if (!selectedAsset()) state.selectedAssetId = saved.assets?.[0]?.id || null;
    if (!selectedSegment()) ensureDefaultSegment(selectedAsset(), true);
    const segment = selectedSegment();
    state.selectedVoiceId = segment?.activeVoiceId || segment?.voiceVersions?.at(-1)?.id || null;
    state.selectedRenderId = selectedAsset()?.renderVersions?.at(-1)?.id || null;
    renderAll();
    showToast("项目已保存");
  } catch (error) {
    showToast(error.message || "保存项目失败", "error");
  } finally {
    setBusy(els.saveProjectBtn, false);
  }
}

async function handleOpenProject() {
  const project = await bridge.openProject();
  if (!project) return;
  stopVoicePreview();
  state.project = project;
  state.selectedAssetId = project.assets?.[0]?.id || null;
  ensureDefaultSegment(selectedAsset(), true);
  const segment = selectedSegment();
  state.selectedVoiceId = segment?.activeVoiceId || segment?.voiceVersions?.at(-1)?.id || null;
  state.selectedRenderId = selectedAsset()?.renderVersions?.at(-1)?.id || null;
  state.previewPath = null;
  state.selectedTextOverlayId = null;
  renderAll();
}

async function handleImport() {
  const project = await ensureProject();
  const assets = await bridge.importVideos({ projectRoot: project.rootDir });
  if (!assets.length) return;
  stopVoicePreview();
  project.assets.push(...assets);
  state.selectedAssetId = assets[0].id;
  ensureDefaultSegment(assets[0], true);
  state.previewPath = null;
  await saveProjectNow();
  renderAll();
  showToast(`已导入 ${assets.length} 个视频`);
}

async function handleGenerateVoice() {
  const project = await ensureProject();
  const asset = selectedAsset();
  const segment = selectedSegment();
  if (!segment) return;
  stopVoicePreview();
  updateSegmentFromForm();
  const assetId = asset?.id;
  const segmentId = segment.id;
  const text = segment.text;
  const speed = segment.speed;
  const existingVoice = selectedVoice(segment) || segment.voiceVersions?.[0] || null;
  const nextDefaultTitle = segmentTitle(segment, segmentIndex(asset, segment.id));
  setBusy(els.generateVoiceBtn, true, "生成中");
  try {
    const voice = await bridge.generateVoice({
      projectRoot: project.rootDir,
      segmentId,
      text,
      speed,
      existingVoiceId: existingVoice?.id || null,
      provider: document.getElementById("voiceProvider").value
    });
    const targetSegment = findSegmentById(assetId, segmentId);
    if (!targetSegment) throw new Error("文字稿段已不存在。");
    if (shouldKeepVoiceTitle(existingVoice, nextDefaultTitle)) {
      voice.title = existingVoice.title;
      voice.titleSource = "manual";
    } else {
      voice.title = nextDefaultTitle;
      voice.titleSource = "segment";
    }
    targetSegment.voiceVersions = [voice];
    targetSegment.activeVoiceId = voice.id;
    state.selectedVoiceId = voice.id;
    await saveProjectNow();
    renderAll();
    showToast(existingVoice ? "语音已覆盖" : "语音已生成");
  } catch (error) {
    showToast(error.message || "生成语音失败", "error");
  } finally {
    setBusy(els.generateVoiceBtn, false);
  }
}

async function handlePreviewVoice() {
  const voice = selectedVoice();
  if (!voice?.path) return;
  if (state.previewAudio) {
    if (state.previewAudioVoiceId === voice.id) {
      stopVoicePreview();
      return;
    }
    stopVoicePreview();
  }
  try {
    const prepared = await bridge.prepareAudioPreview({ path: voice.path });
    const audio = new Audio(toMediaUrl(prepared.path || voice.path));
    state.previewAudio = audio;
    state.previewAudioVoiceId = voice.id;
    setPreviewVoiceButtonState();
    audio.addEventListener("ended", stopVoicePreview, { once: true });
    audio.addEventListener("error", stopVoicePreview, { once: true });
    await audio.play();
  } catch (error) {
    stopVoicePreview();
    showToast(error.message || "试听失败", "error");
  }
}

function serializableTextOverlays(owner) {
  const target = currentTextTarget();
  const rect = target?.owner === owner ? (state.textOverlayRect || videoContentRect()) : null;
  const previewWidth = Number(rect?.width || 0);
  const previewHeight = Number(rect?.height || 0);
  return (owner?.textOverlays || [])
    .map((item) => normalizeTextOverlay({ ...item }))
    .map((item) => ({
      ...item,
      previewWidth: Number.isFinite(previewWidth) && previewWidth > 0
        ? previewWidth
        : Number(item.previewWidth || 0) || null,
      previewHeight: Number.isFinite(previewHeight) && previewHeight > 0
        ? previewHeight
        : Number(item.previewHeight || 0) || null
    }))
    .filter((item) => String(item.text || "").trim());
}

function findRenderForQueueItem(queueItem) {
  if (!state.project || !queueItem) return { asset: null, render: null };
  const preferredAsset = queueItem.assetId ? findAssetById(queueItem.assetId) : null;
  const assets = preferredAsset ? [preferredAsset] : (state.project.assets || []);
  for (const asset of assets) {
    const render = (asset.renderVersions || []).find((item) => item.id === queueItem.id);
    if (render) return { asset, render };
  }
  return { asset: preferredAsset, render: null };
}

function mergeItemsWithPendingText(queue) {
  return (queue || []).map((queueItem) => {
    const { asset, render } = findRenderForQueueItem(queueItem);
    if (!render) return queueItem;
    return {
      ...queueItem,
      assetId: asset?.id || queueItem.assetId,
      path: render.path || queueItem.path,
      label: render.label || queueItem.label,
      textOverlays: serializableTextOverlays(render)
    };
  });
}

async function handleSynthesize() {
  const project = await ensureProject();
  const asset = selectedAsset();
  const segment = selectedSegment();
  if (!asset) return;
  updateSegmentFromForm();
  const assetId = asset.id;
  const textTarget = currentTextTarget();
  const editingRender = textTarget?.type === "render" ? textTarget.owner : null;
  const textOverlays = serializableTextOverlays(textTarget?.owner);
  const overlays = editingRender ? [] : (asset.segments || [])
    .map((item) => {
      const voice = selectedVoice(item);
      if (!voice?.path) return null;
      return {
        segmentId: item.id,
        voiceVersionId: voice.id,
        voicePath: voice.path,
        start: item.start,
        end: item.end
      };
    })
    .filter(Boolean);
  if (!overlays.length && !textOverlays.length) {
    showToast("请先生成至少一段语音或插入文字", "error");
    return;
  }
  setBusy(els.synthesizeBtn, true, "合成中");
  try {
    const existingRender = editingRender || (asset.renderVersions || [])[0] || null;
    const fallbackDuration = Math.max(0.1, ...overlays.map((item) => Number(item.end || 0)));
    if (existingRender?.path && state.previewPath === existingRender.path) {
      els.videoPreview.pause();
      els.videoPreview.removeAttribute("src");
      delete els.videoPreview.dataset.path;
      els.videoPreview.load();
    }
    const render = await bridge.synthesizeAsset({
      projectRoot: project.rootDir,
      assetId: asset.id,
      videoPath: editingRender?.path || asset.path,
      videoDuration: asset.duration || els.videoPreview.duration || fallbackDuration,
      overlays,
      textOverlays,
      keepOriginalAudio: Boolean(editingRender || (!overlays.length && textOverlays.length)),
      existingRenderId: existingRender?.id || null,
      existingRenderPath: existingRender?.path || null,
      existingCreatedAt: existingRender?.createdAt || null
    });
    const targetAsset = findAssetById(assetId);
    if (!targetAsset) throw new Error("视频素材已不存在。");
    if (editingRender) {
      render.textOverlayCount = Number(render.textOverlayCount || 0) +
        Number(editingRender.textOverlayCount || editingRender.textOverlaysApplied || 0);
    }
    targetAsset.renderVersions ||= [];
    const oldRenderIds = new Set(targetAsset.renderVersions.map((item) => item.id));
    render.assetId = targetAsset.id;
    render.label = renderLabel(targetAsset, render, 0);
    if (editingRender) {
      targetAsset.renderVersions = targetAsset.renderVersions.map((item) => item.id === render.id ? render : item);
    } else {
      targetAsset.renderVersions = [render];
    }
    state.project.mergeQueue = (state.project.mergeQueue || [])
      .filter((item) => !oldRenderIds.has(item.id) || item.id === render.id);
    toggleMergeQueue({
      ...render,
      assetId: targetAsset.id,
      assetName: targetAsset.name,
      selected: false
    }, true);
    state.selectedRenderId = render.id;
    state.previewPath = render.path;
    state.selectedTextOverlayId = null;
    await saveProjectNow();
    renderAll();
    showToast(existingRender ? "合成视频已覆盖并加入音视频合并列表" : "合成视频已生成并加入音视频合并列表");
  } catch (error) {
    showToast(error.message || "合成失败", "error");
  } finally {
    setBusy(els.synthesizeBtn, false);
  }
}

async function handleMerge() {
  const project = await ensureProject();
  const queue = project.mergeQueue || [];
  if (!queue.length) {
    showToast("请选择需要合并的视频", "error");
    return;
  }
  setBusy(els.mergeBtn, true, "导出中");
  try {
    const exported = await bridge.mergeVideos({
      projectRoot: project.rootDir,
      name: "最终合成视频",
      items: mergeItemsWithPendingText(queue)
    });
    project.exports ||= [];
    project.exports.push(exported);
    await saveProjectNow();
    state.previewPath = exported.path;
    renderPreview();
    showToast("最终视频已导出");
  } catch (error) {
    showToast(error.message || "合并导出失败", "error");
  } finally {
    setBusy(els.mergeBtn, false);
  }
}

async function handleMergePreview() {
  const project = await ensureProject();
  const queue = project.mergeQueue || [];
  if (!queue.length) {
    showToast("请选择需要预览合并的视频", "error");
    return;
  }
  setBusy(els.mergePreviewBtn, true, "预览中");
  try {
    const preview = await bridge.mergeVideos({
      projectRoot: project.rootDir,
      name: "合并预览",
      items: mergeItemsWithPendingText(queue),
      preview: true
    });
    state.previewPath = preview.path;
    renderPreview();
    showToast("合并预览已生成");
  } catch (error) {
    showToast(error.message || "合并预览失败", "error");
  } finally {
    setBusy(els.mergePreviewBtn, false);
  }
}

async function openRecordDialog() {
  if (bridge.requestRecording) { bridge.requestRecording(); return; }
  await ensureProject();
  els.recordDialog.showModal();
  try {
    state.captureSources = await bridge.listCaptureSources();
  } catch {
    state.captureSources = [];
  }
  renderCaptureSources();
}

function currentCaptureMode() {
  return document.querySelector("input[name='captureMode']:checked")?.value || "screen";
}

function captureOptions() {
  const source = state.captureSources.find((item) => item.id === state.selectedSourceId) || null;
  const resolution = els.recordResolution?.value || "1080";
  const output = recordingOutputSize(resolution);
  return {
    mode: currentCaptureMode(),
    sourceId: state.selectedSourceId,
    sourceDisplayId: source?.displayId || state.selectedArea?.displayId || null,
    windowBounds: source?.windowBounds || null,
    systemAudio: els.recordSystemAudio.checked,
    microphone: els.recordMic.checked,
    cursor: els.recordCursor.checked,
    clickEffect: els.recordClicks.checked,
    keyHints: els.recordKeys.checked,
    crop: {
      x: Number(els.cropX.value || 0),
      y: Number(els.cropY.value || 0),
      width: Number(els.cropW.value || 1280),
      height: Number(els.cropH.value || 720),
      sourceWidth: state.selectedArea?.sourceWidth || null,
      sourceHeight: state.selectedArea?.sourceHeight || null,
      displayId: state.selectedArea?.displayId || null,
      displayBounds: state.selectedArea?.displayBounds || null,
      scaleFactor: state.selectedArea?.scaleFactor || null
    },
    fps: 30,
    resolution,
    width: output.width,
    height: output.height
  };
}

function renderCaptureSources() {
  const mode = currentCaptureMode();
  const filtered = state.captureSources.filter((source) => {
    if (source.id === "system-picker") return true;
    if (mode === "window") return source.id.startsWith("window:") || source.id.startsWith("browser-tab:");
    return source.id.startsWith("screen:");
  });
  if (!filtered.some((source) => source.id === state.selectedSourceId)) {
    state.selectedSourceId = filtered[0]?.id || null;
  }
  els.captureSources.innerHTML = filtered.length ? filtered.map((source) => `
    <button class="source-item ${source.id === state.selectedSourceId ? "active" : ""}" type="button" data-source-id="${source.id}">
      ${source.thumbnail ? `<img alt="" src="${source.thumbnail}">` : ""}
      <span class="item-title">${escapeHtml(source.name)}</span>
      ${source.url ? `<span class="item-meta">${escapeHtml(source.url)}</span>` : ""}
    </button>
  `).join("") : `<div class="item-meta">暂无可选来源</div>`;
  els.captureSources.querySelectorAll("[data-source-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedSourceId = button.dataset.sourceId;
      state.selectedArea = null;
      renderCaptureSources();
      updateAreaControls();
    });
  });
  updateAreaControls();
}

function updateAreaControls() {
  const isArea = currentCaptureMode() === "area";
  els.selectAreaBtn.disabled = !isArea;
  els.areaHint.textContent = isArea
    ? "点击“框选区域”后在屏幕上拖拽选择录制范围"
    : "选择“自定义区域”后可拖拽框选录制范围";
}

function setCaptureMode(mode) {
  const input = document.querySelector(`input[name="captureMode"][value="${mode}"]`);
  if (!input) return;
  input.checked = true;
  renderCaptureSources();
}

async function chooseCaptureArea() {
  if (currentCaptureMode() !== "area") setCaptureMode("area");
  const source = state.captureSources.find((item) => item.id === state.selectedSourceId) || null;
  const area = await bridge.selectCaptureArea({ displayId: source?.displayId || null });
  if (!area) return;
  const scale = Number(area.scaleFactor || 1);
  state.selectedArea = {
    ...area,
    sourceWidth: area.sourceWidth || Math.round((area.displayBounds?.width || 0) * scale),
    sourceHeight: area.sourceHeight || Math.round((area.displayBounds?.height || 0) * scale)
  };
  const screenSource =
    state.captureSources.find((item) => item.id?.startsWith("screen:") && String(item.displayId) === String(area.displayId)) ||
    state.captureSources.find((item) => item.id?.startsWith("screen:")) ||
    null;
  if (screenSource) state.selectedSourceId = screenSource.id;
  els.cropX.value = String(Math.max(0, Math.round(area.x * scale)));
  els.cropY.value = String(Math.max(0, Math.round(area.y * scale)));
  els.cropW.value = String(Math.max(1, Math.round(area.width * scale)));
  els.cropH.value = String(Math.max(1, Math.round(area.height * scale)));
  renderCaptureSources();
  els.areaHint.textContent = `已选择 ${els.cropW.value} × ${els.cropH.value}，可重新框选`;
}

function pickRecorderMimeType() {
  const types = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function getDesktopStream(options) {
  if (window.studio) {
    await bridge.setCapturePreference(options);
  }
  const customPointer = shouldDrawPointerOverlay(options);
  return navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: options.fps || 30, max: options.fps || 30 },
      cursor: customPointer ? "never" : options.cursor ? "always" : "never"
    },
    audio: Boolean(options.systemAudio)
  });
}

function captureErrorMessage(error) {
  const name = error?.name || "";
  const message = error?.message || String(error || "");
  if (name === "NotAllowedError") return "录屏权限被拒绝，请在系统设置中允许屏幕录制权限后重试。";
  if (name === "NotFoundError") return "没有找到可录制的屏幕或窗口，请重新选择录屏来源。";
  if (name === "NotSupportedError" || /not support/i.test(message)) {
    return "当前录屏方式不受支持，已修正为 Electron 桌面捕获方式，请重启工具后再试。";
  }
  return message || "开始录制失败";
}

async function buildRecordingStream(options) {
  await startPointerOverlay(options);
  state.sourceStream = await getDesktopStream(options);
  const streams = [state.sourceStream];
  if (options.microphone) {
    streams.push(await navigator.mediaDevices.getUserMedia({ audio: true, video: false }));
  }

  const audioTracks = streams.flatMap((stream) => stream.getAudioTracks());
  const videoTrack = state.sourceStream.getVideoTracks()[0];
  if (!videoTrack) throw new Error("没有获取到视频轨道。");

  if (options.mode !== "area") {
    const video = document.createElement("video");
    video.srcObject = new MediaStream([videoTrack]);
    video.muted = true;
    await video.play();
    await waitForVideoDimensions(video);
    const output = areaOutputSize(options.width || 1920, options.height || 1080);
    const drawRect = areaDrawRect(video.videoWidth, video.videoHeight, output.width, output.height);
    const canvas = document.createElement("canvas");
    canvas.width = output.width;
    canvas.height = output.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("无法创建录制输出画布。");
    ctx.fillStyle = "#000000";
    ctx.imageSmoothingEnabled = drawRect.width !== video.videoWidth || drawRect.height !== video.videoHeight;
    ctx.imageSmoothingQuality = "high";
    const geometry = {
      output,
      drawRect,
      crop: {
        x: 0,
        y: 0,
        width: video.videoWidth,
        height: video.videoHeight,
        sourceWidth: video.videoWidth,
        sourceHeight: video.videoHeight,
        displayBounds: options.windowBounds || null,
        scaleFactor: 1
      },
      cropX: 0,
      cropY: 0,
      cropWidth: video.videoWidth,
      cropHeight: video.videoHeight,
      scaleX: 1,
      scaleY: 1
    };
    const draw = () => {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      ctx.fillRect(0, 0, output.width, output.height);
      ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, drawRect.x, drawRect.y, drawRect.width, drawRect.height);
      drawPointerOverlay(ctx, options, geometry);
    };
    draw();
    state.cropTimer = setInterval(draw, Math.max(16, Math.round(1000 / (options.fps || 30))));
    const composed = canvas.captureStream(options.fps || 30);
    return new MediaStream([...composed.getVideoTracks(), ...audioTracks]);
  }

  const video = document.createElement("video");
  video.srcObject = new MediaStream([videoTrack]);
  video.muted = true;
  await video.play();
  await waitForVideoDimensions(video);

  const crop = options.crop;
  const sourceWidth = Number(crop.sourceWidth || video.videoWidth || crop.width);
  const sourceHeight = Number(crop.sourceHeight || video.videoHeight || crop.height);
  const scaleX = video.videoWidth / sourceWidth;
  const scaleY = video.videoHeight / sourceHeight;
  const cropX = Math.max(0, Math.round(crop.x * scaleX));
  const cropY = Math.max(0, Math.round(crop.y * scaleY));
  const cropWidth = Math.min(video.videoWidth - cropX, Math.max(1, Math.round(crop.width * scaleX)));
  const cropHeight = Math.min(video.videoHeight - cropY, Math.max(1, Math.round(crop.height * scaleY)));
  const output = areaOutputSize(options.width || 1920, options.height || 1080);
  const drawRect = areaDrawRect(cropWidth, cropHeight, output.width, output.height);
  const canvas = document.createElement("canvas");
  canvas.width = output.width;
  canvas.height = output.height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("无法创建区域录制画布。");
  ctx.fillStyle = "#000000";
  ctx.imageSmoothingEnabled = drawRect.width !== cropWidth || drawRect.height !== cropHeight;
  ctx.imageSmoothingQuality = "high";
  const draw = () => {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    ctx.fillRect(0, 0, output.width, output.height);
    ctx.drawImage(
      video,
      cropX,
      cropY,
      cropWidth,
      cropHeight,
      drawRect.x,
      drawRect.y,
      drawRect.width,
      drawRect.height
    );
    drawPointerOverlay(ctx, options, {
      output,
      drawRect,
      crop,
      cropX,
      cropY,
      cropWidth,
      cropHeight,
      scaleX,
      scaleY
    });
  };
  draw();
  state.cropTimer = setInterval(draw, Math.max(16, Math.round(1000 / (options.fps || 30))));
  const cropped = canvas.captureStream(options.fps || 30);
  return new MediaStream([...cropped.getVideoTracks(), ...audioTracks]);
}

async function startRecording() {
  const project = await ensureProject();
  const options = captureOptions();
  if (!options.sourceId && window.studio) {
    showToast("未读取到录屏来源，将自动选择可用屏幕源或触发系统权限。");
  }
  setBusy(els.startRecordBtn, true, "录制中");
  els.stopRecordBtn.disabled = false;
  state.recordingWindowVisibleSince = null;
  state.recordingStopTrimTailSeconds = 0;
  state.recordingStopping = false;
  try {
    if (bridge.prepareForRecording) {
      await bridge.prepareForRecording();
    } else {
      await bridge.minimizeToTaskbar?.();
    }
    await delay(options.mode === "area" || options.mode === "screen" ? 800 : 450);
    state.recordStream = await buildRecordingStream(options);
    state.recordChunks = [];
    const mimeType = pickRecorderMimeType();
    state.recorder = new MediaRecorder(state.recordStream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: recordingBitsPerSecond(state.recordStream, options),
      audioBitsPerSecond: 192000
    });
    state.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) state.recordChunks.push(event.data);
    };
    state.recorder.onstop = async () => {
      await finishRecording(project, options, mimeType);
    };
    state.recordingStartedAt = Date.now();
    state.recordingTimer = setInterval(updateRecordTimer, 500);
    updateRecordTimer();
    state.recorder.start(1000);
    await bridge.registerStopShortcut?.();
  } catch (error) {
    cleanupRecording();
    await bridge.restoreFromTaskbar?.();
    showToast(captureErrorMessage(error), "error");
  }
}

function noteRecordingWindowVisible() {
  if (!state.recorder || state.recorder.state === "inactive" || document.hidden) return;
  if (!state.recordingWindowVisibleSince) state.recordingWindowVisibleSince = Date.now();
}

function recordingTailTrimSeconds() {
  if (!state.recordingWindowVisibleSince) return 0;
  return Math.max(0, (Date.now() - state.recordingWindowVisibleSince) / 1000 + 0.45);
}

async function stopRecording(options = {}) {
  if (state.recordingStopping) return;
  if (state.recorder && state.recorder.state !== "inactive") {
    state.recordingStopping = true;
    els.stopRecordBtn.disabled = true;
    if (options.fromShortcut) noteRecordingWindowVisible();
    if (!options.fromShortcut) {
      noteRecordingWindowVisible();
      if (bridge.prepareForRecording) {
        await bridge.prepareForRecording();
      } else {
        await bridge.minimizeToTaskbar?.();
      }
      await delay(650);
    }
    state.recordingStopTrimTailSeconds = recordingTailTrimSeconds();
    state.recorder.stop();
  } else {
    cleanupRecording();
  }
}

async function finishRecording(project, options, mimeType) {
  try {
    const blob = new Blob(state.recordChunks, { type: mimeType || "video/webm" });
    const duration = (Date.now() - state.recordingStartedAt) / 1000;
    const bytes = await blob.arrayBuffer();
    const asset = await bridge.saveRecording({
      projectRoot: project.rootDir,
      bytes,
      mimeType: blob.type,
      duration,
      trimTailSeconds: state.recordingStopTrimTailSeconds,
      captureOptions: options
    });
    project.assets.push(asset);
    state.selectedAssetId = asset.id;
    ensureDefaultSegment(asset, true);
    state.previewPath = null;
    await saveProjectNow();
    renderAll();
    showToast("录屏已保存");
  } catch (error) {
    showToast(error.message || "保存录屏失败", "error");
  } finally {
    cleanupRecording();
    await bridge.restoreFromTaskbar?.();
  }
}

function cleanupRecording() {
  clearInterval(state.recordingTimer);
  state.recordingTimer = null;
  clearInterval(state.cropTimer);
  state.cropTimer = null;
  clearInterval(state.pointerPollTimer);
  state.pointerPollTimer = null;
  state.pointerSnapshot = null;
  bridge.stopPointerMonitor?.();
  for (const stream of [state.recordStream, state.sourceStream]) {
    stream?.getTracks?.().forEach((track) => track.stop());
  }
  state.recordStream = null;
  state.sourceStream = null;
  state.recorder = null;
  state.recordChunks = [];
  state.recordingWindowVisibleSince = null;
  state.recordingStopTrimTailSeconds = 0;
  state.recordingStopping = false;
  bridge.unregisterStopShortcut?.();
  els.startRecordBtn.textContent = els.startRecordBtn.dataset.label || "开始录制";
  els.startRecordBtn.disabled = false;
  els.stopRecordBtn.disabled = true;
  els.recordTimer.textContent = "00:00";
}

function updateRecordTimer() {
  const elapsed = (Date.now() - state.recordingStartedAt) / 1000;
  els.recordTimer.textContent = formatTime(elapsed);
}

function attachEvents() {
  els.newProjectBtn.addEventListener("click", () => handleNewProject().catch(reportError));
  els.saveProjectBtn.addEventListener("click", () => handleSaveProjectFolder().catch(reportError));
  els.openProjectBtn.addEventListener("click", () => handleOpenProject().catch(reportError));
  els.importBtn.addEventListener("click", () => handleImport().catch(reportError));
  els.recordBtn.addEventListener("click", () => openRecordDialog().catch(reportError));
  els.mergePreviewBtn.addEventListener("click", () => handleMergePreview().catch(reportError));
  els.mergeBtn.addEventListener("click", () => handleMerge().catch(reportError));
  els.addSegmentBtn.addEventListener("click", addSegment);

  els.segmentStart.addEventListener("input", updateSegmentFromForm);
  els.segmentEnd.addEventListener("input", updateSegmentFromForm);
  els.scriptText.addEventListener("input", updateSegmentFromForm);
  els.speedSelect.addEventListener("change", updateSegmentFromForm);
  els.generateVoiceBtn.addEventListener("click", () => handleGenerateVoice().catch(reportError));
  els.previewVoiceBtn.addEventListener("click", () => handlePreviewVoice().catch(reportError));
  els.synthesizeBtn.addEventListener("click", () => handleSynthesize().catch(reportError));
  els.insertTextBtn.addEventListener("click", handleInsertTextOverlay);
  els.textFontSize.addEventListener("change", updateSelectedTextStyle);
  els.textColor.addEventListener("input", updateSelectedTextStyle);
  els.textBgColor.addEventListener("input", updateSelectedTextStyle);
  els.textBgOpacity.addEventListener("input", updateSelectedTextStyle);
  els.deleteTextOverlayBtn.addEventListener("click", deleteSelectedTextOverlay);

  els.videoPreview.addEventListener("loadedmetadata", () => {
    const asset = selectedAsset();
    const duration = Number(els.videoPreview.duration);
    if (asset && !state.previewPath && Number.isFinite(duration) && duration > 0) {
      asset.duration = duration;
      saveProjectSoon();
      renderAssets();
    }
    renderTextOverlays();
  });
  els.videoPreview.addEventListener("loadeddata", renderTextOverlays);
  els.videoPreview.addEventListener("timeupdate", renderTextOverlays);
  els.videoPreview.addEventListener("seeked", renderTextOverlays);
  els.videoPreview.addEventListener("play", renderTextOverlays);
  els.videoPreview.addEventListener("pause", renderTextOverlays);
  window.addEventListener("resize", renderTextOverlays);

  document.querySelectorAll("input[name='captureMode']").forEach((input) => {
    input.addEventListener("change", renderCaptureSources);
  });
  els.selectAreaBtn.addEventListener("click", () => chooseCaptureArea().catch(reportError));
  [els.cropX, els.cropY, els.cropW, els.cropH].forEach((input) => {
    input.addEventListener("input", () => {
      state.selectedArea = null;
    });
  });
  els.startRecordBtn.addEventListener("click", () => startRecording().catch(reportError));
  els.stopRecordBtn.addEventListener("click", () => stopRecording().catch(reportError));
  els.closeRecordBtn.addEventListener("click", () => {
    if (state.recorder) stopRecording().catch(reportError);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) noteRecordingWindowVisible();
  });
  window.addEventListener("focus", noteRecordingWindowVisible);
  bridge.onStopRecordingShortcut?.(() => {
    stopRecording({ fromShortcut: true }).catch(reportError);
  });
}

function reportError(error) {
  showToast(error.message || String(error), "error");
}

async function init() {
  attachEvents();
  state.status = await bridge.getStatus();
  document.getElementById('mediaStatus').textContent = state.status.ffmpeg?.ok ? '媒体组件已就绪' : '媒体组件不可用';
  const previous = localStorage.getItem('screenshot-studio-last-project');
  if (previous) { try { state.project = await bridge.openProjectFolder(previous); if (state.project) resetSelectionForProject(state.project); } catch {} }
  renderAll();
  window.importRecording = async path => {
    const project = await ensureProject();
    if (!project) throw new Error('请先创建视频项目，录屏仍保存在原位置');
    const assets = await bridge.importVideos({ projectRoot: project.rootDir, paths: [path] });
    for (const asset of assets) { asset.kind = 'recording'; project.assets.push(asset); }
    if (assets[0]) { state.selectedAssetId = assets[0].id; ensureDefaultSegment(assets[0], true); }
    await saveProjectNow(); renderAll(); showToast('录屏已添加到视频素材');
  };
  window.parent.dispatchEvent(new CustomEvent('studio-ready'));
}

init().catch(reportError);
