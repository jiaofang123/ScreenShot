// Run after `cargo build --locked --example recording_harness` in src-tauri.
// Uses real MediaRecorder/VideoFrame encoding with synthetic pixels, never the desktop.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const executable = process.env.RECORDING_HARNESS || resolve(root, 'src-tauri/target/debug/examples/recording_harness');
const directory = await mkdtemp(join(tmpdir(), 'screenshot-recording-test-'));
const browser = await chromium.launch({ executablePath: process.env.RECORDING_CHROME_PATH || undefined });
const options = mode => ({ mode, fps: 30, audio: false, originalResolution: false });

async function session(mode, suffix = mode, overrides = {}, format = 'mp4') {
  const child = spawn(executable, [join(directory, `${suffix}.${format}`), JSON.stringify({ ...options(mode), ...overrides })], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  const [line] = await Promise.race([
    once(lines, 'line'),
    once(child, 'exit').then(() => { throw new Error(`Recording harness exited: ${stderr}`); }),
  ]);
  const info = JSON.parse(line);
  const page = await browser.newPage({ viewport: { width: 1060, height: 880 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.addInitScript(({ mode }) => {
    window.testSurface = { window: 'window', tab: 'browser', desktop: 'monitor', region: 'monitor' }[mode];
    window.captureCalls = [];
    navigator.mediaDevices.getDisplayMedia = async constraints => {
      window.captureCalls.push(constraints);
      if (window.denyCapture) throw new DOMException('Test cancellation', 'NotAllowedError');
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d'); let frame = 0;
      function paint() {
        context.fillStyle = '#19b34a'; context.fillRect(0, 0, 320, 360);
        context.fillStyle = '#1645d1'; context.fillRect(320, 0, 320, 360);
        context.fillStyle = '#fff'; context.fillRect(8 + frame++ % 30, 8, 20, 20);
      }
      paint(); const timer = setInterval(paint, 50);
      const stream = canvas.captureStream(20);
      const track = stream.getVideoTracks()[0]; const settings = track.getSettings.bind(track);
      track.getSettings = () => ({ ...settings(), displaySurface: window.testSurface });
      track.addEventListener('ended', () => clearInterval(timer));
      if (constraints.audio) {
        const audio = new AudioContext(); const oscillator = audio.createOscillator();
        const destination = audio.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start(); void audio.resume();
        stream.addTrack(destination.stream.getAudioTracks()[0]);
      }
      window.sourceStream = stream;
      return stream;
    };
  }, { mode });
  await page.goto(info.url);
  await page.getByRole('button', { name: /^选择/, exact: false }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('choose').disabled);
  return { child, page, info, errors, async close() {
    await page.close(); child.stdin.end('quit\n');
    if (child.exitCode === null) await once(child, 'exit'); lines.close();
  } };
}

async function videoInfo(page, path, audio = false) {
  const bytes = await readFile(path);
  const result = await page.evaluate(async ({ bytes, mime, audio }) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: mime });
    const url = URL.createObjectURL(blob); const video = document.createElement('video');
    video.muted = true; video.src = url; document.body.append(video);
    await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('Saved video cannot be decoded')); });
    video.currentTime = 0.2;
    await new Promise(resolve => { video.onseeked = resolve; });
    const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0);
    const pixel = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    const result = { width: video.videoWidth, height: video.videoHeight, duration: Number.isFinite(video.duration) ? video.duration : null,
      left: pixel(Math.floor(video.videoWidth * .25), Math.floor(video.videoHeight * .5)), right: pixel(Math.floor(video.videoWidth * .75), Math.floor(video.videoHeight * .5)) };
    if (audio) {
      const context = new AudioContext();
      const decoded = await context.decodeAudioData(new Uint8Array(bytes).buffer);
      const samples = decoded.getChannelData(0);
      result.audioDuration = decoded.duration;
      result.audioPeak = Math.max(...Array.from(samples.subarray(0, Math.min(samples.length, 48000))).map(Math.abs));
      await context.close();
    }
    video.remove(); URL.revokeObjectURL(url); return result;
  }, { bytes: Array.from(bytes), mime: path.endsWith('.mp4') ? 'video/mp4' : 'video/webm', audio });
  assert.ok(bytes.length > 100);
  return result;
}

const results = [];
try {
  for (const { mode, audio = false, suffix = mode, format = 'mp4' } of [
    { mode: 'window' }, { mode: 'tab' }, { mode: 'desktop' }, { mode: 'region' },
    { mode: 'tab', audio: true, suffix: 'tab-audio' },
    { mode: 'desktop', suffix: 'desktop-webm', format: 'webm' },
  ]) {
    const current = await session(mode, suffix, { audio }, format);
    const { child, page, info, errors } = current;
    try {
      if (mode === 'window') {
        await page.evaluate(() => { window.denyCapture = true; });
        await page.getByRole('button', { name: /^选择/ }).click();
        await page.getByText(/共享已取消或未获屏幕录制权限/).waitFor();
        await page.evaluate(() => { window.denyCapture = false; });
        await page.evaluate(() => { window.testSurface = 'monitor'; });
        await page.getByRole('button', { name: /^选择/ }).click();
        await page.getByText(/来源类型不符/).waitFor();
        await page.evaluate(() => { window.testSurface = 'window'; });
      }
      await page.getByRole('button', { name: /^选择/ }).click();
      if (mode === 'region') {
        await page.getByText('调整选区', { exact: true }).waitFor();
        const box = await page.locator('#preview-stage').boundingBox();
        await page.mouse.move(box.x + box.width * .1, box.y + box.height * .2); await page.mouse.down();
        await page.mouse.move(box.x + box.width * .4, box.y + box.height * .8); await page.mouse.up();
        const nw = await page.locator('[data-corner="nw"]').boundingBox();
        await page.mouse.move(nw.x + nw.width / 2, nw.y + nw.height / 2); await page.mouse.down();
        await page.mouse.move(nw.x + nw.width / 2 + box.width * .02, nw.y + nw.height / 2); await page.mouse.up();
        await page.getByRole('button', { name: '开始录制选区', exact: true }).click();
      }
      await page.getByText('录制中', { exact: true }).waitFor({ timeout: 15000 });
      await page.waitForTimeout(1300);
      if (mode === 'window') {
        child.stdin.write('pause\n');
        await page.getByText('已暂停', { exact: true }).waitFor();
        await page.waitForTimeout(700);
        child.stdin.write('resume\n');
        await page.getByText('录制中', { exact: true }).waitFor();
        await page.waitForTimeout(800);
      }
      // Stop via the native-side control channel, including while another tab is foreground.
      const other = await browser.newPage(); await other.goto('about:blank'); await other.bringToFront();
      child.stdin.write('stop\n');
      await page.getByRole('heading', { name: '视频已保存', exact: true }).waitFor({ timeout: 20000 });
      await other.close();
      const path = await page.locator('#saved-path').textContent();
      const metadata = await videoInfo(page, path, audio);
      if (audio) { assert.ok(metadata.audioDuration >= 1); assert.ok(metadata.audioPeak > 0.1); }
      assert.equal(path.endsWith(`.${format}`), true);
      if (mode === 'region') {
        assert.ok(metadata.width >= 174 && metadata.width <= 180, JSON.stringify(metadata));
        assert.ok(metadata.height >= 214 && metadata.height <= 218, JSON.stringify(metadata));
        assert.ok(metadata.left[1] > 100 && metadata.right[1] > 100, 'Crop should contain only the green portion of the shared screen');
      } else {
        assert.equal(metadata.width, 640); assert.equal(metadata.height, 360);
        assert.ok(metadata.left[1] > 100 && metadata.right[2] > 100);
      }
      const saved = await fetch(new URL('config', info.url)).then(response => response.json());
      assert.equal(saved.status.phase, 'saved'); assert.equal(saved.status.filePath, path);
      assert.equal(saved.status.bytesWritten, (await stat(path)).size);
      assert.equal(saved.status.hasAudio, audio);
      assert.ok(saved.status.elapsedMs >= 1000);
      assert.deepEqual(errors, []);
      results.push({ mode, audio, path, ...metadata, bytes: saved.status.bytesWritten });
      console.log(`PASS: ${mode} real encoder, streamed save, native stop, decoded video ${metadata.width}x${metadata.height}`);
    } catch (error) {
      console.error('Recorder notice:', await page.locator('#notice').textContent().catch(() => 'page closed'));
      throw error;
    } finally { await current.close(); }
  }
  // Closing the recorder abruptly preserves a distinct, unfinished recording.
  const interrupted = await session('desktop', 'interrupted');
  try {
    await interrupted.page.getByRole('button', { name: /^选择/ }).click();
    await interrupted.page.getByText('录制中', { exact: true }).waitFor({ timeout: 15000 });
    await interrupted.page.waitForTimeout(1500);
    await interrupted.page.close({ runBeforeUnload: false });
    await new Promise(resolve => setTimeout(resolve, 500));
    const config = await fetch(new URL('config', interrupted.info.url)).then(response => response.json());
    assert.equal(config.status.phase, 'error');
    assert.ok(config.status.filePath.includes('未完成'));
    assert.ok((await stat(config.status.filePath)).size > 0);
    results.push({ mode: 'recovery', path: config.status.filePath });
    console.log('PASS: interrupted recorder preserves an unfinished video');
  } finally { await interrupted.close(); }
  console.log(JSON.stringify({ result: 'PASS', directory, results }));
} finally { await browser.close(); }
