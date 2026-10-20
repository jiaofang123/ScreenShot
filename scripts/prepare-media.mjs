// Bundle a self-contained media worker; installed users do not need Node, FFmpeg or a compiler.
import { cp, mkdir, readdir, rm, access, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const tauri = join(root, 'src-tauri');
const runtime = join(tauri, 'resources/runtime');
const media = join(tauri, 'resources/studio');
const exists = path => access(path).then(() => true, () => false);
if (!await exists(join(tauri, 'studio/node_modules/ffmpeg-static'))) throw new Error('请先运行 npm run media:install');
await mkdir(runtime, { recursive: true });
await cp(process.execPath, join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'));
const nodeLicense = join(runtime, `LICENSE-node-${process.version}.txt`);
if (!await exists(nodeLicense)) {
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`无法获取 Node ${process.version} 许可证：${response.status}`);
  await writeFile(nodeLicense, await response.text());
}
await rm(media, { recursive: true, force: true });
await mkdir(join(media, 'node_modules'), { recursive: true });
await cp(join(tauri, 'studio/worker.mjs'), join(media, 'worker.mjs'));
await cp(join(tauri, 'studio/package.json'), join(media, 'package.json'));
for (const entry of await readdir(join(tauri, 'studio/node_modules'))) {
  if (entry.startsWith('.')) continue;
  await cp(join(tauri, 'studio/node_modules', entry), join(media, 'node_modules', entry), { recursive: true, dereference: true });
}
if (process.platform === 'darwin') {
  const result = spawnSync('xcrun', ['swiftc', '-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`, '-o', join(runtime, 'screenshot-recorder'), join(tauri, 'native/Recorder.swift')], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
  for (const file of [join(runtime, 'node'), join(runtime, 'screenshot-recorder'), join(media, 'node_modules/ffmpeg-static/ffmpeg')]) {
    const signed = spawnSync('codesign', ['--force', '--sign', '-', file], { stdio: 'inherit' });
    if (signed.status !== 0) process.exit(signed.status || 1);
  }
}
console.log('Media runtime prepared:', resolve(media));
