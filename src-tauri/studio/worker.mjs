// Adapted from jiaofang123/Video-Narration-Studio (41f55c8). No Electron runtime.
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile, realpath, readdir, lstat, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, extname, join, relative as pathRelative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import os from 'node:os';
import { spawn } from 'node:child_process';
console.log = (...args) => console.error(...args);
const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const OUTPUT_VIDEO_WIDTH = 1920, DEFAULT_TEXT_PREVIEW_WIDTH = 960;
const TEXT_OVERLAY_PLACEHOLDER = '输入文字', TEXT_OVERLAY_DEFAULT_DURATION = 2;
const TEXT_OVERLAY_FONT_SIZES = [12,14,16,20,24,30,36,45];
const handlers = new Map();
const ipcMain = { handle: (name, handler) => handlers.set(name, handler) };
let requestPayload = {};
const mainWindow = null;
const dialog = { showOpenDialog: async () => ({ canceled: !requestPayload.paths?.length, filePaths: requestPayload.paths || [] }) };
function now() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function padTimePart(value) {
  return String(value).padStart(2, "0");
}

function projectFolderTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return [
    `${safeDate.getFullYear()}年`,
    `${padTimePart(safeDate.getMonth() + 1)}月`,
    `${padTimePart(safeDate.getDate())}日`,
    `${padTimePart(safeDate.getHours())}时`,
    `${padTimePart(safeDate.getMinutes())}分`,
    `${padTimePart(safeDate.getSeconds())}秒`
  ].join("");
}

function projectFolderName(createdAt = new Date()) {
  return `合成视频-${projectFolderTimestamp(createdAt)}`;
}

function safeSlug(value, fallback = "project") {
  return String(value || fallback)
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function safeFileName(value, fallback = "file") {
  const name = basename(String(value || fallback)).replace(/[\\/:\0]/g, "-");
  return name || fallback;
}

async function exists(file) {
  return Boolean(await stat(file).catch(() => null));
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

function workspaceRoot() {
  return process.env.SCREENSHOT_STUDIO_WORKSPACE || join(os.homedir(), "screenshot");
}

function projectsRoot() {
  return join(workspaceRoot(), "projects");
}

function projectFile(projectRoot) {
  return join(projectRoot, "project.json");
}

function assetSubdir(projectRoot, name) {
  return join(projectRoot, name);
}


function speedToSpeechRate(speed) {
  const rates = {
    slow: 150,
    normal: 180,
    fast: 220,
    faster: 260
  };
  return rates[speed] || rates.normal;
}

function speedToMultiplier(speed) {
  const values = {
    slow: 0.85,
    normal: 1,
    fast: 1.15,
    faster: 1.3
  };
  return values[speed] || values.normal;
}

function edgeTtsRate(speed) {
  const values = {
    slow: "-15%",
    normal: "0%",
    fast: "+15%",
    faster: "+30%"
  };
  return values[speed] || values.normal;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd || APP_ROOT,
      env: { ...process.env, ...(options.env || {}) },
      shell: Boolean(options.shell),
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectCommand);
    child.on("close", (code) => {
      if (code === 0) resolveCommand({ stdout, stderr });
      else rejectCommand(new Error(stderr || stdout || `${command} exited with ${code}`));
    });
  });
}


function secondsFromTimestamp(value) {
  const match = String(value || "").match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const total = (hours * 3600) + (minutes * 60) + seconds;
  return Number.isFinite(total) ? total : null;
}

function parseMediaDuration(output) {
  const match = String(output || "").match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
  return match ? secondsFromTimestamp(match[1]) : null;
}

async function probeMediaDuration(ffmpeg, file) {
  if (!file) return null;
  try {
    const result = await runCommand(ffmpeg, ["-hide_banner", "-i", file]);
    return parseMediaDuration(`${result.stderr}\n${result.stdout}`);
  } catch (error) {
    return parseMediaDuration(error.message);
  }
}

function ffmpegFilterEscape(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function ffmpegFilterString(value) {
  return `'${ffmpegFilterEscape(value)}'`;
}

function ffmpegHexColor(value, fallback = "#111827") {
  const color = /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : fallback;
  return `0x${color.slice(1)}`;
}

function defaultDrawtextFontFile() {
  const candidates = process.platform === "darwin"
    ? [
      "/System/Library/Fonts/PingFang.ttc",
      "/System/Library/Fonts/Hiragino Sans GB.ttc",
      "/System/Library/Fonts/STHeiti Light.ttc"
    ]
    : process.platform === "win32"
      ? [
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/arial.ttf"
      ]
      : [
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
      ];
  return candidates.find((file) => existsSyncSafe(file)) || "";
}

function existsSyncSafe(file) {
  try {
    return Boolean(file && statSyncSafe(file));
  } catch {
    return false;
  }
}

function statSyncSafe(file) {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

function normalizeTextOverlayForRender(overlay = {}) {
  const x = Math.min(0.98, Math.max(0, Number(overlay.x || 0)));
  const y = Math.min(0.98, Math.max(0, Number(overlay.y || 0)));
  const text = String(overlay.text || "").trim();
  const fontSize = TEXT_OVERLAY_FONT_SIZES.includes(Number(overlay.fontSize)) ? Number(overlay.fontSize) : 16;
  const previewWidth = Number(overlay.previewWidth || 0);
  const fontScale = Math.min(4, Math.max(0.5, OUTPUT_VIDEO_WIDTH / (previewWidth > 0 ? previewWidth : DEFAULT_TEXT_PREVIEW_WIDTH)));
  const renderFontSize = Math.max(1, Math.round(fontSize * fontScale));
  const rawStart = Number(overlay.start);
  const start = Number.isFinite(rawStart) ? Math.max(0, rawStart) : 0;
  const rawEnd = Number(overlay.end);
  const end = Number.isFinite(rawEnd)
    ? Math.max(start + 0.1, rawEnd)
    : start + TEXT_OVERLAY_DEFAULT_DURATION;
  return {
    id: String(overlay.id || randomUUID()),
    text: text === TEXT_OVERLAY_PLACEHOLDER ? "" : text,
    start,
    end,
    x,
    y,
    width: Math.min(1 - x, Math.max(0.04, Number(overlay.width || 0.28))),
    height: Math.min(1 - y, Math.max(0.04, Number(overlay.height || 0.12))),
    fontSize,
    renderFontSize,
    color: /^#[0-9a-f]{6}$/i.test(String(overlay.color || "")) ? String(overlay.color) : "#ffffff",
    backgroundColor: /^#[0-9a-f]{6}$/i.test(String(overlay.backgroundColor || "")) ? String(overlay.backgroundColor) : "#111827",
    backgroundOpacity: Math.min(1, Math.max(0, Number(overlay.backgroundOpacity ?? 0.5)))
  };
}

function wrapTextForDrawtext(text, overlay) {
  const fontSize = Number(overlay.renderFontSize || overlay.fontSize || 16);
  const maxWidth = Math.max(fontSize * 2, overlay.width * OUTPUT_VIDEO_WIDTH - 16);
  const maxChars = Math.max(1, Math.floor(maxWidth / (fontSize * 0.9)));
  const maxLines = Math.max(1, Math.floor((overlay.height * 1080 - 12) / (fontSize * 1.35)));
  const sourceLines = String(text || "").split(/\r?\n/);
  const lines = [];
  for (const sourceLine of sourceLines) {
    let line = sourceLine.trim();
    if (!line) {
      lines.push("");
      continue;
    }
    while (line.length > maxChars) {
      lines.push(line.slice(0, maxChars));
      line = line.slice(maxChars);
    }
    lines.push(line);
  }
  return lines.slice(0, maxLines);
}

async function buildTextOverlayFilters({ projectRoot, outputId, textOverlays = [], videoDuration }) {
  const tmpDir = await ensureDir(assetSubdir(projectRoot, "tmp"));
  const fontFile = defaultDrawtextFontFile();
  const filters = [];
  let current = "vbase";
  // A narration/audio track can outlast the source video. The player holds the
  // last image, so create those frames before applying time-based text too.
  const duration = Number(videoDuration);
  const hold = Number.isFinite(duration) && duration > 0
    ? `,tpad=stop_mode=clone:stop_duration=${duration.toFixed(3)},trim=duration=${duration.toFixed(3)}` : '';
  filters.push(`[0:v]setpts=PTS-STARTPTS,scale=${OUTPUT_VIDEO_WIDTH}:'trunc(${OUTPUT_VIDEO_WIDTH}/dar/2)*2',setsar=1,fps=30${hold}[${current}]`);
  const normalized = textOverlays.map(normalizeTextOverlayForRender).filter((item) => item.text);

  for (const [overlayIndex, overlay] of normalized.entries()) {
    const boxX = `${overlay.x.toFixed(6)}*iw`;
    const boxY = `${overlay.y.toFixed(6)}*ih`;
    const boxWidth = `${overlay.width.toFixed(6)}*iw`;
    const boxHeight = `${overlay.height.toFixed(6)}*ih`;
    const textX = `${overlay.x.toFixed(6)}*w`;
    const textY = `${overlay.y.toFixed(6)}*h`;
    const enableWindow = `enable='gte(t,${overlay.start.toFixed(3)})*lt(t,${overlay.end.toFixed(3)})'`;
    if (overlay.backgroundOpacity > 0) {
      const next = `vbox${overlayIndex}`;
      filters.push(
        `[${current}]drawbox=x=${boxX}:y=${boxY}:w=${boxWidth}:h=${boxHeight}:color=${ffmpegHexColor(overlay.backgroundColor)}@${overlay.backgroundOpacity.toFixed(3)}:t=fill:${enableWindow}[${next}]`
      );
      current = next;
    }
    const lines = wrapTextForDrawtext(overlay.text, overlay);
    for (const [lineIndex, line] of lines.entries()) {
      const textFile = join(tmpDir, `${outputId}-text-${overlayIndex}-${lineIndex}.txt`);
      await writeFile(textFile, line);
      const next = `vtxt${overlayIndex}_${lineIndex}`;
      const renderFontSize = Number(overlay.renderFontSize || overlay.fontSize || 16);
      const lineHeight = Math.round(renderFontSize * 1.35);
      const padding = Math.max(4, Math.round(renderFontSize * 0.45));
      const drawOptions = [
        fontFile ? `fontfile=${ffmpegFilterString(fontFile)}` : null,
        `textfile=${ffmpegFilterString(textFile)}`,
        `x=${textX}+${padding}`,
        `y=${textY}+${padding + lineIndex * lineHeight}`,
        `fontsize=${renderFontSize}`,
        `fontcolor=${ffmpegHexColor(overlay.color)}`,
        enableWindow
      ].filter(Boolean).join(":");
      filters.push(
        `[${current}]drawtext=${drawOptions}[${next}]`
      );
      current = next;
    }
  }

  filters.push(`[${current}]format=yuv420p[vout]`);
  return { filters, normalized };
}

async function materializeMergeItemForConcat(ffmpeg, { projectRoot, outputId, item, index }) {
  const textOverlays = Array.isArray(item.textOverlays) ? item.textOverlays : [];
  const videoDuration = Math.max(0.1, Number(await probeMediaDuration(ffmpeg, item.path)) || 0,
    ...textOverlays.map(overlay => normalizeTextOverlayForRender(overlay).end));
  const { filters, normalized } = await buildTextOverlayFilters({
    projectRoot,
    outputId: `${outputId}-merge-${index}`,
    textOverlays, videoDuration
  });

  const tmpDir = await ensureDir(assetSubdir(projectRoot, "tmp"));
  const output = join(tmpDir, `${outputId}-merge-${index}.mp4`);
  // Concat requires one geometry for every clip. Fit the entire composed frame
  // (including text) inside 1080p, then letterbox instead of stretching it.
  filters.push('[vout]scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1[vconcat]');
  await runCommand(ffmpeg, [
    "-y",
    "-i", item.path,
    "-filter_complex", filters.join(";"),
    "-map", "[vconcat]",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-af", `asetpts=PTS-STARTPTS,apad=whole_dur=${videoDuration.toFixed(3)}`,
    "-t", videoDuration.toFixed(3),
    output
  ]);

  return {
    ...item,
    path: output,
    materializedForConcat: true,
    materializedTextOverlayCount: normalized.length
  };
}

async function resolveFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    join(APP_ROOT, "bin", process.platform, "ffmpeg"),
    join(APP_ROOT, "bin", process.platform, "ffmpeg.exe"),
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
    "ffmpeg"
  ].filter(Boolean);

  try {
    const mod = await import("ffmpeg-static");
    if (mod.default) candidates.unshift(mod.default);
  } catch {
    // Optional dependency. The app can still run without it and report setup status.
  }

  for (const candidate of candidates) {
    if (candidate === "ffmpeg") {
      try {
        await runCommand(candidate, ["-version"]);
        return candidate;
      } catch {
        continue;
      }
    }
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function resolveTtsAdapter() {
  try {
    const mod = await import("@andresaya/edge-tts");
    if (mod.EdgeTTS) {
      return {
        type: "edge-tts",
        label: `Edge TTS ${process.env.EDGE_TTS_VOICE || "zh-CN-XiaoxiaoNeural"}`,
        voice: process.env.EDGE_TTS_VOICE || "zh-CN-XiaoxiaoNeural",
        outputFormat: process.env.EDGE_TTS_OUTPUT_FORMAT || "audio-24khz-48kbitrate-mono-mp3"
      };
    }
  } catch {
    // Fall through to optional local adapters if the Edge TTS package is unavailable.
  }
  if (process.env.TTS_COMMAND_TEMPLATE) {
    return { type: "template", label: "TTS_COMMAND_TEMPLATE" };
  }
  if (process.env.SHERPA_ONNX_TTS && await exists(process.env.SHERPA_ONNX_TTS)) {
    return { type: "sherpa", command: process.env.SHERPA_ONNX_TTS, label: "sherpa-onnx" };
  }
  if (process.platform === "darwin") {
    return { type: "macos-say", command: "say", label: "macOS say fallback" };
  }
  if (process.platform === "win32") {
    return { type: "windows-sapi", command: "powershell.exe", label: "Windows SAPI fallback" };
  }
  return null;
}

function shellQuote(value) {
  if (process.platform === "win32") return `"${String(value).replace(/"/g, '\\"')}"`;
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function writeProject(project) {
  const normalized = {
    ...project,
    updatedAt: now()
  };
  await ensureDir(normalized.rootDir);
  const temporary = join(normalized.rootDir, `.project-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`);
    await rename(temporary, projectFile(normalized.rootDir));
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  return normalized;
}

function inside(parent, file) {
  const relative = pathRelative(parent, file);
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${sep}`) && !isAbsolute(relative));
}

async function deleteProjectSegment({ project, assetId, segmentId }) {
  if (!project?.rootDir || !segmentId) throw new Error('文字稿删除参数不完整。');
  const root = await realpath(project.rootDir);
  if (!(await stat(projectFile(root))).isFile()) throw new Error('视频项目不存在。');
  const updated = structuredClone(project);
  const asset = updated.assets?.find(asset => asset.id === assetId);
  const segment = asset?.segments?.find(segment => segment.id === segmentId);
  if (!segment) throw new Error('文字稿段已不存在。');
  asset.segments = asset.segments.filter(item => item.id !== segmentId);
  asset.segmentsInitialized = true;
  updated.updatedAt = now();
  const voicesRoot = await ensureDir(join(root, 'voices'));
  const canonicalVoices = await realpath(voicesRoot);
  if (!inside(root, canonicalVoices)) throw new Error('语音目录位于项目外，无法安全清理。');
  const candidates = new Set(), retained = new Set(), references = new Set();
  function voiceFiles(voice) {
    const files = [voice.path, voice.textPath].filter(Boolean).map(file => resolve(file));
    if (voice.path) {
      const stem = join(dirname(voice.path), basename(voice.path, extname(voice.path)));
      files.push(`${stem}.aiff`, `${stem}.preview.wav`);
    }
    return files;
  }
  for (const other of updated.assets || []) for (const entry of other.segments || []) for (const voice of entry.voiceVersions || []) {
    for (const file of voiceFiles(voice)) references.add(await realpath(file).catch(() => file));
  }
  for (const voice of segment.voiceVersions || []) for (const file of voiceFiles(voice)) candidates.add(file);
  // Include old generated versions/intermediate files belonging to this segment.
  const segmentDirectory = join(voicesRoot, String(segmentId));
  let cleanDirectory = null;
  if (inside(voicesRoot, resolve(segmentDirectory)) && dirname(resolve(segmentDirectory)) === resolve(voicesRoot)) {
    const info = await lstat(segmentDirectory).catch(() => null);
    if (info?.isDirectory() && inside(canonicalVoices, await realpath(segmentDirectory))) {
      cleanDirectory = segmentDirectory;
      for (const name of await readdir(segmentDirectory)) candidates.add(join(segmentDirectory, name));
    }
  }
  const files = [];
  for (const candidate of candidates) {
    const info = await lstat(candidate).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) continue;
    const canonical = await realpath(candidate);
    if (!info.isFile() || !inside(canonicalVoices, canonical) || references.has(canonical)) { retained.add(candidate); continue; }
    if (!files.includes(canonical)) files.push(canonical);
  }
  const tmp = await realpath(await ensureDir(join(root, 'tmp')));
  if (!inside(root, tmp)) throw new Error('项目临时目录位于项目外，无法删除文字稿。');
  const transaction = await mkdtemp(join(tmp, 'delete-segment-'));
  const staged = [];
  try {
    for (const [index, original] of files.entries()) {
      const destination = join(transaction, String(index));
      await rename(original, destination); staged.push({ original, destination });
    }
    // Commit metadata atomically only after every voice file has been staged.
    const metadata = join(transaction, 'project.json');
    await writeFile(metadata, JSON.stringify(updated, null, 2) + '\n');
    await rename(metadata, projectFile(root));
  } catch (error) {
    for (const { original, destination } of staged.reverse()) await rename(destination, original);
    await rm(transaction, { recursive: true, force: true });
    throw error;
  }
  let cleanupPending = false;
  await rm(transaction, { recursive: true, force: true }).catch(() => { cleanupPending = true; });
  // Only an empty generated segment folder is removed; shared files remain.
  if (cleanDirectory) await rmdir(cleanDirectory).catch(() => {});
  return { deletedFiles: files.length, retainedFiles: retained.size, cleanupPending };
}

async function copyIfDifferent(source, target) {
  if (!source || !await exists(source)) return null;
  await ensureDir(dirname(target));
  if (resolve(source) !== resolve(target)) await copyFile(source, target);
  return target;
}

function relativePath(rootDir, file) {
  return file ? pathRelative(rootDir, file).replaceAll("\\", "/") : null;
}

function withAbsolutePackagedPaths(project, rootDir) {
  const normalized = JSON.parse(JSON.stringify(project));
  normalized.rootDir = rootDir;
  for (const asset of normalized.assets || []) {
    if (asset.relativePath) asset.path = join(rootDir, asset.relativePath);
    for (const segment of asset.segments || []) {
      if (segment.transcriptRelativePath) segment.transcriptPath = join(rootDir, segment.transcriptRelativePath);
      if (segment.transcriptTextRelativePath) segment.transcriptTextPath = join(rootDir, segment.transcriptTextRelativePath);
      for (const voice of segment.voiceVersions || []) {
        if (voice.relativePath) voice.path = join(rootDir, voice.relativePath);
        if (voice.textRelativePath) voice.textPath = join(rootDir, voice.textRelativePath);
      }
    }
    for (const render of asset.renderVersions || []) {
      if (render.relativePath) render.path = join(rootDir, render.relativePath);
    }
  }
  for (const exported of normalized.exports || []) {
    if (exported.relativePath) exported.path = join(rootDir, exported.relativePath);
  }
  for (const item of normalized.mergeQueue || []) {
    if (item.relativePath) item.path = join(rootDir, item.relativePath);
  }
  return normalized;
}

async function openProjectFolder(rootDir) {
  if (!rootDir) return null;
  const file = projectFile(rootDir);
  if (!await exists(file)) throw new Error("所选文件夹不是有效项目文件夹，缺少 project.json。");
  return withAbsolutePackagedPaths(await openProjectFromFile(file), rootDir);
}

async function saveProjectPackage(project, targetRoot) {
  if (!project) throw new Error("没有可保存的项目。");
  const rootDir = targetRoot || project.rootDir;
  if (!rootDir) throw new Error("项目文件夹无效。");

  await ensureDir(rootDir);
  await ensureDir(join(rootDir, "videos"));
  await ensureDir(join(rootDir, "transcripts"));
  await ensureDir(join(rootDir, "audio"));
  await ensureDir(join(rootDir, "renders"));
  await ensureDir(join(rootDir, "exports"));

  const packaged = JSON.parse(JSON.stringify(project));
  packaged.rootDir = rootDir;
  packaged.updatedAt = now();
  const renderById = new Map();

  for (const asset of packaged.assets || []) {
    const videoExt = extname(asset.path || asset.name || "") || ".webm";
    const videoTarget = join(rootDir, "videos", `${asset.id}${videoExt}`);
    const copiedVideo = await copyIfDifferent(asset.path, videoTarget);
    if (copiedVideo) {
      asset.path = copiedVideo;
      asset.relativePath = relativePath(rootDir, copiedVideo);
    }

    for (const segment of asset.segments || []) {
      const transcriptDir = await ensureDir(join(rootDir, "transcripts", asset.id));
      const segmentJson = join(transcriptDir, `${segment.id}.json`);
      const segmentText = join(transcriptDir, `${segment.id}.txt`);
      const transcript = {
        id: segment.id,
        assetId: asset.id,
        title: segment.title || "",
        start: segment.start,
        end: segment.end,
        text: segment.text || "",
        speed: segment.speed || "normal",
        activeVoiceId: segment.activeVoiceId || null,
        voiceVersions: (segment.voiceVersions || []).map((voice) => ({
          id: voice.id,
          title: voice.title || "",
          titleSource: voice.titleSource || "",
          speed: voice.speed,
          duration: voice.duration || null,
          createdAt: voice.createdAt,
          adapter: voice.adapter
        }))
      };
      await writeFile(segmentJson, `${JSON.stringify(transcript, null, 2)}\n`);
      await writeFile(segmentText, `${segment.text || ""}\n`);
      segment.transcriptPath = segmentJson;
      segment.transcriptRelativePath = relativePath(rootDir, segmentJson);
      segment.transcriptTextPath = segmentText;
      segment.transcriptTextRelativePath = relativePath(rootDir, segmentText);

      for (const voice of segment.voiceVersions || []) {
        const audioExt = extname(voice.path || "") || ".wav";
        const audioTarget = join(rootDir, "audio", asset.id, segment.id, `${voice.id}${audioExt}`);
        const copiedAudio = await copyIfDifferent(voice.path, audioTarget);
        if (copiedAudio) {
          voice.path = copiedAudio;
          voice.relativePath = relativePath(rootDir, copiedAudio);
        }
        const voiceTextTarget = join(transcriptDir, `${voice.id}.txt`);
        if (voice.textPath && await exists(voice.textPath)) await copyIfDifferent(voice.textPath, voiceTextTarget);
        else await writeFile(voiceTextTarget, `${voice.text || segment.text || ""}\n`);
        voice.textPath = voiceTextTarget;
        voice.textRelativePath = relativePath(rootDir, voiceTextTarget);
      }
    }

    for (const render of asset.renderVersions || []) {
      const renderExt = extname(render.path || "") || ".mp4";
      const renderTarget = join(rootDir, "renders", asset.id, `${render.id}${renderExt}`);
      const copiedRender = await copyIfDifferent(render.path, renderTarget);
      if (copiedRender) {
        render.path = copiedRender;
        render.relativePath = relativePath(rootDir, copiedRender);
      }
      renderById.set(render.id, render);
    }
  }

  for (const item of packaged.mergeQueue || []) {
    const render = renderById.get(item.id);
    if (render?.path) {
      item.path = render.path;
      item.relativePath = render.relativePath || relativePath(rootDir, render.path);
    }
  }

  for (const exported of packaged.exports || []) {
    const exportExt = extname(exported.path || "") || ".mp4";
    const exportTarget = join(rootDir, "exports", `${safeSlug(exported.name || packaged.name || "export")}-${exported.id}${exportExt}`);
    const copiedExport = await copyIfDifferent(exported.path, exportTarget);
    if (copiedExport) {
      exported.path = copiedExport;
      exported.relativePath = relativePath(rootDir, copiedExport);
    }
  }

  await writeFile(projectFile(rootDir), `${JSON.stringify(packaged, null, 2)}\n`);
  return packaged;
}

async function createProject(name, targetRoot = null) {
  const id = randomUUID();
  const createdDate = new Date();
  const createdAt = createdDate.toISOString();
  let rootDir = targetRoot ? resolve(targetRoot) : null;
  if (rootDir) {
    if (await exists(projectFile(rootDir))) {
      throw new Error("该文件夹已存在项目，请更换项目文件夹名称或选择其他位置。");
    }
  } else {
    const rootBase = await ensureDir(projectsRoot());
    const baseName = projectFolderName(createdDate);
    rootDir = join(rootBase, baseName);
    let duplicateIndex = 2;
    while (await exists(rootDir)) {
      rootDir = join(rootBase, `${baseName}-${duplicateIndex}`);
      duplicateIndex += 1;
    }
  }
  const project = {
    id,
    name: name || basename(rootDir) || "合成视频",
    rootDir,
    createdAt,
    updatedAt: createdAt,
    assets: [],
    mergeQueue: [],
    exports: []
  };
  await ensureDir(assetSubdir(rootDir, "assets"));
  await ensureDir(assetSubdir(rootDir, "voices"));
  await ensureDir(assetSubdir(rootDir, "renders"));
  await ensureDir(assetSubdir(rootDir, "exports"));
  await ensureDir(assetSubdir(rootDir, "tmp"));
  return writeProject(project);
}


async function openProjectFromFile(file) {
  const project = JSON.parse(await readFile(file, "utf8"));
  project.rootDir ||= dirname(file);
  return project;
}

async function generateVoiceWithTemplate(template, values) {
  let command = template;
  for (const [key, value] of Object.entries(values)) {
    command = command.replaceAll(`{${key}}`, shellQuote(value));
  }
  await runCommand(command, [], { shell: true });
}

async function generateVoiceWithSherpa(adapter, values) {
  await runCommand(adapter.command, [
    "--text", values.text,
    "--output", values.output,
    "--speed", String(values.speedMultiplier)
  ]);
}

async function generateVoiceWithEdgeTts(adapter, values) {
  const { EdgeTTS } = await import("@andresaya/edge-tts");
  const tts = new EdgeTTS();
  await tts.synthesize(values.text, adapter.voice, {
    rate: edgeTtsRate(values.speed),
    pitch: "0Hz",
    volume: "0%",
    outputFormat: adapter.outputFormat
  });
  await writeFile(values.output, tts.toBuffer());
}

async function convertAudioToWav(input, output) {
  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg) throw new Error("未找到 FFmpeg，无法转换试听音频。");
  await ensureDir(dirname(output));
  await runCommand(ffmpeg, [
    "-y",
    "-i", input,
    "-acodec", "pcm_s16le",
    "-ar", "44100",
    "-ac", "2",
    output
  ]);
  return output;
}

async function playableAudioPath(file) {
  const extension = extname(file).toLowerCase();
  if ([".wav", ".mp3", ".m4a", ".aac", ".ogg"].includes(extension)) return file;
  const output = join(dirname(file), `${basename(file, extension)}.preview.wav`);
  if (!await exists(output)) await convertAudioToWav(file, output);
  return output;
}

async function generateVoiceWithMacSay(values) {
  const intermediate = values.output.replace(/\.wav$/i, ".aiff");
  const args = [
    "-v", "Tingting",
    "-r", String(speedToSpeechRate(values.speed)),
    "-o", intermediate,
    "-f", values.textFile
  ];
  try {
    await runCommand("say", args);
  } catch { throw new Error('本机中文语音不可用，请在系统设置中下载 Tingting，或选择在线中文女声。'); }
  await convertAudioToWav(intermediate, values.output);
}

async function generateVoiceWithWindowsSapi(values) {
  const sapiRate = { slow: -2, normal: 0, fast: 2, faster: 4 }[values.speed] ?? 0;
  const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `$s.Rate = ${sapiRate}`,
    `$s.SetOutputToWaveFile(${literal(values.output)})`,
    `$s.Speak([System.IO.File]::ReadAllText(${literal(values.textFile)}, [System.Text.Encoding]::UTF8))`,
    "$s.Dispose()"
  ].join("; ");
  await runCommand("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
}

  ipcMain.handle("app:getStatus", async () => {
    const ffmpeg = await resolveFfmpeg();
    const tts = await resolveTtsAdapter();
    return {
      platform: process.platform,
      workspaceRoot: workspaceRoot(),
      ffmpeg: ffmpeg ? { ok: true, path: ffmpeg } : { ok: false },
      tts: tts ? { ok: true, label: tts.label } : { ok: false }
    };
  });
  ipcMain.handle("project:create", async (_event, payload = {}) => {
    return createProject(payload.name, payload.targetRoot || null);
  });
  ipcMain.handle("project:defaultPath", async () => {
    return join(await ensureDir(projectsRoot()), projectFolderName());
  });
  ipcMain.handle("project:openFolder", async (_event, payload = {}) => {
    return openProjectFolder(payload.targetRoot);
  });
  ipcMain.handle("project:saveAsFolder", async (_event, payload = {}) => {
    const project = payload.project;
    if (!project) throw new Error("没有可保存的项目。");
    let targetRoot = payload.targetRoot;
    if (!targetRoot) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: "保存项目到文件夹",
        defaultPath: project.rootDir || join(await ensureDir(projectsRoot()), projectFolderName(project.createdAt || new Date())),
        properties: ["openDirectory", "createDirectory"]
      });
      if (result.canceled || !result.filePaths[0]) return null;
      targetRoot = result.filePaths[0];
    }
    return saveProjectPackage(project, targetRoot);
  });
  ipcMain.handle("project:save", async (_event, project) => {
    return writeProject(project);
  });
  ipcMain.handle('project:deleteSegment', async (_event, payload) => deleteProjectSegment(payload));
  ipcMain.handle("project:importVideos", async (_event, payload = {}) => {
    if (!payload.projectRoot) throw new Error("请先创建或打开项目。");
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "导入视频",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Videos", extensions: ["mp4", "mov", "m4v", "webm", "mkv"] }]
    });
    if (result.canceled) return [];
    const assetsDir = await ensureDir(assetSubdir(payload.projectRoot, "assets"));
    const imported = [];
    for (const file of result.filePaths) {
      // Recordings already saved in this project's assets are registered in
      // place, as in Narration Studio. External videos still get their own copy.
      const inPlace = payload.recording === true && resolve(dirname(file)) === resolve(assetsDir);
      const id = inPlace ? basename(file, extname(file)) : randomUUID();
      const target = inPlace ? file : join(assetsDir, `${id}${extname(file) || ".mp4"}`);
      if (inPlace) {
        if (!(await stat(file)).isFile()) throw new Error("录屏视频不存在或尚未保存完成。");
      } else await copyFile(file, target);
      imported.push({
        id,
        kind: payload.recording === true ? "recording" : "imported",
        name: safeFileName(file),
        sourcePath: file,
        path: target,
        createdAt: now(),
        duration: payload.duration || null,
        segments: []
      });
    }
    return imported;
  });
  ipcMain.handle("tts:generate", async (_event, payload = {}) => {
    if (!payload.projectRoot) throw new Error("请先创建或打开项目。");
    const text = String(payload.text || "").trim();
    if (!text) throw new Error("文字稿不能为空。");

    const adapter = payload.provider === 'local'
      ? (process.platform === 'darwin' ? { type: 'macos-say', label: '本机中文语音' } : process.platform === 'win32' ? { type: 'windows-sapi', label: '本机语音' } : null)
      : await resolveTtsAdapter();
    if (!adapter) throw new Error("未找到可用 TTS。请配置 SHERPA_ONNX_TTS 或 TTS_COMMAND_TEMPLATE。");

    const voiceId = payload.existingVoiceId ? safeSlug(payload.existingVoiceId, "voice") : randomUUID();
    const voiceDir = await ensureDir(join(assetSubdir(payload.projectRoot, "voices"), payload.segmentId || "segment"));
    const textFile = join(voiceDir, `${voiceId}.txt`);
    const outputExtension = adapter.type === "edge-tts" ? ".mp3" : ".wav";
    const output = join(voiceDir, `${voiceId}${outputExtension}`);
    await writeFile(textFile, `${text}\n`);

    const values = {
      text,
      textFile,
      output,
      speed: payload.speed || "normal",
      speedMultiplier: speedToMultiplier(payload.speed || "normal")
    };

    if (adapter.type === "edge-tts") await generateVoiceWithEdgeTts(adapter, values);
    else if (adapter.type === "template") await generateVoiceWithTemplate(process.env.TTS_COMMAND_TEMPLATE, values);
    else if (adapter.type === "sherpa") await generateVoiceWithSherpa(adapter, values);
    else if (adapter.type === "macos-say") await generateVoiceWithMacSay(values);
    else if (adapter.type === "windows-sapi") await generateVoiceWithWindowsSapi(values);

    let duration = null;
    try {
      const ffmpeg = await resolveFfmpeg();
      const probedDuration = ffmpeg ? await probeMediaDuration(ffmpeg, output) : null;
      duration = Number.isFinite(probedDuration) ? probedDuration : null;
    } catch {
      duration = null;
    }

    return {
      id: voiceId,
      text,
      speed: payload.speed || "normal",
      path: output,
      textPath: textFile,
      duration,
      createdAt: now(),
      adapter: adapter.label
    };
  });
  ipcMain.handle("audio:preparePreview", async (_event, payload = {}) => {
    if (!payload.path) throw new Error("音频路径为空。");
    return { path: await playableAudioPath(payload.path) };
  });
  ipcMain.handle("media:synthesizeSegment", async (_event, payload = {}) => {
    const ffmpeg = await resolveFfmpeg();
    if (!ffmpeg) throw new Error("未找到 FFmpeg。请安装 ffmpeg-static 或配置 FFMPEG_PATH。");
    if (!payload.projectRoot || !payload.videoPath || !payload.voicePath) {
      throw new Error("合成参数不完整。");
    }

    const segment = payload.segment || {};
    const start = Math.max(0, Number(segment.start || 0));
    const end = Math.max(start + 0.1, Number(segment.end || start + 1));
    const voiceDuration = await probeMediaDuration(ffmpeg, payload.voicePath);
    const videoDuration = Math.max(end, Number(payload.videoDuration || end), start + Number(voiceDuration || 0));
    const outputId = payload.existingRenderId || randomUUID();
    const renderDir = await ensureDir(join(assetSubdir(payload.projectRoot, "renders"), segment.id || "segment"));
    const output = payload.existingRenderPath || join(renderDir, `${outputId}.mp4`);
    const delayMs = Math.round(start * 1000);
    const filter = `[1:a]asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1,apad=whole_dur=${videoDuration.toFixed(3)}[voice]`;

    await runCommand(ffmpeg, [
      "-y",
      "-i", payload.videoPath,
      "-i", payload.voicePath,
      "-filter_complex", filter,
      "-map", "0:v:0",
      "-map", "[voice]",
      "-vf", "setsar=1,fps=30",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-c:a", "aac",
      "-b:a", "192k",
      "-t", videoDuration.toFixed(3),
      output
    ]);

    return {
      id: outputId,
      path: output,
      createdAt: now(),
      voiceVersionId: payload.voiceVersionId,
      mode: "voice-only",
      start,
      end,
      voiceDuration
    };
  });
  ipcMain.handle("media:synthesizeAsset", async (_event, payload = {}) => {
    const ffmpeg = await resolveFfmpeg();
    if (!ffmpeg) throw new Error("未找到 FFmpeg。请安装 ffmpeg-static 或配置 FFMPEG_PATH。");
    const textOverlays = Array.isArray(payload.textOverlays) ? payload.textOverlays : [];
    if (!payload.projectRoot || !payload.videoPath || (!Array.isArray(payload.overlays) && !textOverlays.length)) {
      throw new Error("没有可合成的旁白语音或文字。");
    }

    const outputId = payload.existingRenderId || randomUUID();
    const renderDir = await ensureDir(join(assetSubdir(payload.projectRoot, "renders"), payload.assetId || "asset"));
    const output = payload.existingRenderPath || join(renderDir, `${outputId}.mp4`);
    const tmpDir = await ensureDir(assetSubdir(payload.projectRoot, "tmp"));
    const outputTarget = resolve(output) === resolve(payload.videoPath)
      ? join(tmpDir, `${outputId}-replace.mp4`)
      : output;
    await ensureDir(dirname(output));
    const args = ["-y", "-i", payload.videoPath];

    const overlays = await Promise.all((payload.overlays || [])
      .filter((overlay) => overlay.voicePath)
      .map(async (overlay) => {
        const start = Math.max(0, Number(overlay.start || 0));
        const end = Math.max(start + 0.1, Number(overlay.end || start + 0.1));
        const voiceDuration = await probeMediaDuration(ffmpeg, overlay.voicePath);
        return {
          ...overlay,
          start,
          end,
          voiceDuration: Number.isFinite(voiceDuration) ? voiceDuration : null
        };
      }));

    const sourceDuration = await probeMediaDuration(ffmpeg, payload.videoPath);
    const videoDuration = Math.max(
      0.1,
      Number(payload.videoDuration || 0),
      Number(sourceDuration || 0),
      ...overlays.map((overlay) => overlay.end),
      ...overlays.map((overlay) => overlay.start + Number(overlay.voiceDuration || 0)),
      ...textOverlays.map((overlay) => normalizeTextOverlayForRender(overlay).end)
    );
    const { filters: videoFilters, normalized: normalizedTextOverlays } = await buildTextOverlayFilters({
      projectRoot: payload.projectRoot, outputId, textOverlays, videoDuration
    });
    if (!overlays.length && !normalizedTextOverlays.length) {
      throw new Error("没有可合成的有效旁白语音或文字。");
    }

    for (const overlay of overlays) args.push("-i", overlay.voicePath);

    const audioFilters = overlays.map((overlay, index) => {
      const inputIndex = index + 1;
      const delayMs = Math.round(overlay.start * 1000);
      return `[${inputIndex}:a]asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1,apad=whole_dur=${videoDuration.toFixed(3)}[a${inputIndex}]`;
    });
    if (overlays.length) {
      const labels = overlays.map((_overlay, index) => `[a${index + 1}]`).join("");
      audioFilters.push(overlays.length === 1
        ? `${labels}anull[voice]`
        : `${labels}amix=inputs=${overlays.length}:duration=longest:normalize=0,apad=whole_dur=${videoDuration.toFixed(3)}[voice]`);
    }
    const filter = [...videoFilters, ...audioFilters].join(";");

    await runCommand(ffmpeg, [
      ...args,
      "-filter_complex", filter,
      "-map", "[vout]",
      ...(overlays.length ? ["-map", "[voice]"] : ["-map", "0:a?"]),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-c:a", "aac",
      "-b:a", "192k",
      "-t", videoDuration.toFixed(3),
      outputTarget
    ]);

    if (outputTarget !== output) {
      await rename(outputTarget, output);
    }

    return {
      id: outputId,
      path: output,
      createdAt: payload.existingCreatedAt || now(),
      updatedAt: now(),
      mode: overlays.length ? "asset-voice-text" : "asset-text-only",
      overlayCount: overlays.length,
      textOverlayCount: normalizedTextOverlays.length,
      textOverlays: [],
      overlays: overlays.map((overlay) => ({
        segmentId: overlay.segmentId,
        voiceVersionId: overlay.voiceVersionId,
        start: overlay.start,
        end: overlay.end,
        voiceDuration: overlay.voiceDuration
      }))
    };
  });
  ipcMain.handle("media:mergeVideos", async (_event, payload = {}) => {
    const ffmpeg = await resolveFfmpeg();
    if (!ffmpeg) throw new Error("未找到 FFmpeg。请安装 ffmpeg-static 或配置 FFMPEG_PATH。");
    if (!payload.projectRoot || !Array.isArray(payload.items) || payload.items.length === 0) {
      throw new Error("请选择需要合并的视频。");
    }
    const tmpDir = await ensureDir(assetSubdir(payload.projectRoot, "tmp"));
    const previewMode = Boolean(payload.preview);
    const exportDir = await ensureDir(previewMode ? join(tmpDir, "merge-previews") : assetSubdir(payload.projectRoot, "exports"));
    const outputId = randomUUID();
    const createdDate = new Date();
    const createdAt = createdDate.toISOString();
    const outputBaseName = `${previewMode ? "合并预览" : "最终合成视频"}-${projectFolderTimestamp(createdDate)}`;
    const listFile = join(tmpDir, `${outputId}.txt`);
    let output = join(exportDir, `${outputBaseName}.mp4`);
    let duplicateIndex = 2;
    while (await exists(output)) {
      output = join(exportDir, `${outputBaseName}-${duplicateIndex}.mp4`);
      duplicateIndex += 1;
    }
    const mergeItems = [];
    for (const [index, item] of payload.items.entries()) {
      if (!item?.path) throw new Error("合并列表中有视频路径缺失。");
      mergeItems.push(await materializeMergeItemForConcat(ffmpeg, {
        projectRoot: payload.projectRoot,
        outputId,
        item,
        index
      }));
    }

    const listContent = mergeItems
      .map((item) => `file '${String(item.path).replace(/'/g, "'\\''")}'`)
      .join(os.EOL);
    await writeFile(listFile, `${listContent}${os.EOL}`);

    await runCommand(ffmpeg, [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listFile,
      "-vf", "scale=1920:-2,fps=30",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "48000",
      output
    ]);

    return {
      id: outputId,
      name: basename(output, extname(output)),
      path: output,
      createdAt,
      items: payload.items.map((item) => item.id),
      preview: previewMode
    };
  });

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  try {
    const request = JSON.parse(line); requestPayload = request.payload || {};
    const handler = handlers.get(request.method);
    if (!handler) throw new Error('不支持的视频制作操作');
    const result = await handler(null, requestPayload);
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message || String(error) }) + '\n');
  }
}
