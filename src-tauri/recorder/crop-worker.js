let stopped = false;
self.onmessage = async ({ data }) => {
  if (data.stop) { stopped = true; return; }
  const { readable, writable, crop, width, height } = data;
  const reader = readable.getReader();
  const writer = writable.getWriter();
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { alpha: false });
  try {
    while (!stopped) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      try {
        const sx = Math.round(frame.displayWidth * crop.x);
        const sy = Math.round(frame.displayHeight * crop.y);
        const sw = Math.min(frame.displayWidth - sx, Math.round(frame.displayWidth * crop.width));
        const sh = Math.min(frame.displayHeight - sy, Math.round(frame.displayHeight * crop.height));
        context.drawImage(frame, sx, sy, sw, sh, 0, 0, width, height);
        const result = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined });
        try { await writer.write(result); } finally { result.close(); }
      } finally { frame.close(); }
    }
  } catch (error) {
    if (!stopped) self.postMessage({ error: String(error) });
  } finally {
    await reader.cancel().catch(() => {});
    await writer.close().catch(() => {});
    reader.releaseLock(); writer.releaseLock();
  }
};
