// Layout preference belongs to this machine, not the video project.
export function attachMergePanelResize(stage, divider, onResize) {
  const storageKey = 'screenshot-studio-merge-height';
  const heading = stage.querySelector('.preview-head');
  let preferred = null, height = 0, drag = null, frame = 0;
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved > 0) preferred = saved;
  } catch { /* Resizing remains available without persistent storage. */ }

  function bounds() {
    const available = Math.max(0, stage.clientHeight - heading.getBoundingClientRect().height - divider.offsetHeight);
    return { min: Math.min(140, available / 2), max: Math.max(0, available - Math.min(150, available / 2)) };
  }
  function apply() {
    if (!stage.clientHeight) return;
    const { min, max } = bounds();
    const requested = preferred ?? Math.max(200, Math.min(260, innerHeight * .28));
    height = Math.max(min, Math.min(max, requested));
    stage.style.setProperty('--merge-panel-height', `${height}px`);
    divider.setAttribute('aria-valuemin', String(Math.round(min)));
    divider.setAttribute('aria-valuemax', String(Math.round(max)));
    divider.setAttribute('aria-valuenow', String(Math.round(height)));
    divider.setAttribute('aria-valuetext', `列表高度 ${Math.round(height)} 像素`);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(onResize);
  }
  function persist() {
    try {
      if (preferred === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(preferred));
    } catch { /* The current layout still applies. */ }
  }
  function finish(save) {
    if (!drag) return;
    const current = drag; drag = null;
    preferred = save ? height : current.previous;
    document.documentElement.classList.remove('resizing-merge');
    if (divider.hasPointerCapture(current.pointer)) divider.releasePointerCapture(current.pointer);
    apply();
    if (save) persist();
  }
  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || drag) return;
    event.preventDefault();
    divider.focus({ preventScroll: true });
    drag = { pointer: event.pointerId, y: event.clientY, height, previous: preferred };
    divider.setPointerCapture(event.pointerId);
    document.documentElement.classList.add('resizing-merge');
  });
  divider.addEventListener('pointermove', event => {
    if (event.pointerId !== drag?.pointer) return;
    preferred = drag.height + drag.y - event.clientY;
    apply();
  });
  divider.addEventListener('pointerup', event => { if (event.pointerId === drag?.pointer) finish(true); });
  divider.addEventListener('pointercancel', event => { if (event.pointerId === drag?.pointer) finish(false); });
  divider.addEventListener('lostpointercapture', () => finish(false));
  window.addEventListener('blur', () => finish(false));
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); finish(false); }
  });
  divider.addEventListener('keydown', event => {
    if (drag || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const { min, max } = bounds(), step = event.shiftKey ? 40 : 20;
    preferred = event.key === 'Home' ? min : event.key === 'End' ? max : height + (event.key === 'ArrowUp' ? step : -step);
    apply(); preferred = height; persist();
  });
  divider.addEventListener('dblclick', () => { finish(false); preferred = null; apply(); persist(); });
  const observer = new ResizeObserver(apply);
  observer.observe(stage); observer.observe(heading);
  apply();
}
