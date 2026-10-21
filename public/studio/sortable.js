// Pointer sorting keeps the live card and a precise insertion placeholder. DOM
// order is committed once on release, so forms and previews survive the drag.
export function attachSortable(container, { selector, id, commit }) {
  let drag = null, frame = 0, suppressClick = false;
  const cards = () => [...container.querySelectorAll(selector)].filter(card => card !== drag?.card);
  function move() {
    if (!drag?.active) return;
    if (!drag.card.isConnected || !drag.placeholder.isConnected) { finish(false); return; }
    const { card, placeholder, y, offset } = drag;
    card.style.top = `${y - offset}px`;
    const next = cards().find(card => {
      const rect = card.getBoundingClientRect();
      return y < rect.top + rect.height / 2;
    });
    if (next) container.insertBefore(placeholder, next);
    else container.append(placeholder);
  }
  function scroll() {
    if (!drag?.active) return;
    const rect = drag.scroller === document.scrollingElement
      ? { top: 0, bottom: innerHeight } : drag.scroller.getBoundingClientRect();
    const edge = Math.max(20, Math.min(40, (rect.bottom - rect.top) / 4));
    const delta = drag.y < rect.top + edge ? -Math.min(20, Math.max(6, (rect.top + edge - drag.y) / 2))
      : drag.y > rect.bottom - edge ? Math.min(20, Math.max(6, (drag.y - rect.bottom + edge) / 2)) : 0;
    if (delta) { drag.scroller.scrollTop += delta; move(); }
    frame = requestAnimationFrame(scroll);
  }
  function finish(save) {
    if (!drag) return;
    const current = drag; drag = null;
    cancelAnimationFrame(frame);
    if (current.active) {
      const intact = current.card.isConnected && current.placeholder.isConnected;
      current.placeholder.replaceWith(current.card);
      current.card.classList.remove('sorting-source');
      if (current.style === null) current.card.removeAttribute('style');
      else current.card.setAttribute('style', current.style);
      if (!save && intact) for (const card of current.original) container.append(card);
      const order = [...container.querySelectorAll(selector)].map(id);
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      if (save && intact && order.some((value, index) => value !== current.ids[index])) commit(order);
    }
    if (container.hasPointerCapture(current.pointer)) container.releasePointerCapture(current.pointer);
  }
  container.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || drag) return;
    const card = event.target.closest(selector);
    if (!card || !container.contains(card)) return;
    const handle = event.target.closest('[data-sort-handle]');
    if (!handle && event.target.closest('input,textarea,select,button,[contenteditable]')) return;
    if (handle) event.preventDefault();
    const original = [...container.querySelectorAll(selector)];
    drag = { card, pointer: event.pointerId, x: event.clientX, y: event.clientY, startY: event.clientY,
      original, ids: original.map(id), style: card.getAttribute('style'), active: false };
  });
  window.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag.y = event.clientY;
    if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.startY) < 5) return;
    if (!drag.active) {
      const rect = drag.card.getBoundingClientRect();
      const placeholder = document.createElement('div');
      placeholder.className = 'sort-placeholder'; placeholder.style.height = `${rect.height}px`;
      drag.card.before(placeholder);
      Object.assign(drag, { active: true, placeholder, offset: drag.startY - rect.top });
      drag.card.classList.add('sorting-source');
      Object.assign(drag.card.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
        width: `${rect.width}px`, height: `${rect.height}px`, margin: '0', pointerEvents: 'none', zIndex: '1000' });
      let scroller = container;
      while (scroller !== document.documentElement &&
        !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
      drag.scroller = scroller === document.documentElement ? document.scrollingElement : scroller;
      container.setPointerCapture(event.pointerId);
      frame = requestAnimationFrame(scroll);
    }
    event.preventDefault(); move();
  }, { passive: false });
  window.addEventListener('pointerup', event => { if (event.pointerId === drag?.pointer) finish(true); });
  window.addEventListener('pointercancel', event => { if (event.pointerId === drag?.pointer) finish(false); });
  container.addEventListener('lostpointercapture', event => { if (event.pointerId === drag?.pointer) finish(false); });
  window.addEventListener('blur', () => finish(false));
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && drag?.active) { event.preventDefault(); finish(false); } });
  container.addEventListener('click', event => {
    if (suppressClick || event.target.closest('[data-sort-handle]')) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  container.addEventListener('keydown', event => {
    if (!event.target.closest('[data-sort-handle]') || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const all = [...container.querySelectorAll(selector)], index = all.indexOf(event.target.closest(selector));
    const target = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (target < 0 || target >= all.length) return;
    const selectedId = id(all[index]), order = all.map(id);
    [order[index], order[target]] = [order[target], order[index]]; commit(order);
    [...container.querySelectorAll(selector)].find(card => id(card) === selectedId)?.querySelector('[data-sort-handle]')?.focus();
  });
}
