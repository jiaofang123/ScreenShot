// Executed inside the actual Tauri WKWebView, with production IPC and worker.
if (window.parent === window) window.addEventListener('DOMContentLoaded', async () => {
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const wait = async predicate => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 60)); }
    throw Error('Embedded editor condition timed out: ' + predicate.toString());
  };
  try {
    const root = window.__STUDIO_QA.projectRoot;
    localStorage.setItem('screenshot-studio-last-project', root);
    const tab = await wait(() => [...document.querySelectorAll('.mode-tabs button')].find(button => button.textContent === '视频制作'));
    tab.click();
    const frame = await wait(() => document.querySelector('iframe[title="视频制作"]')?.contentWindow);
    await wait(() => frame.document.querySelector('[data-delete-segment-id="native-segment"]'));
    const doc = frame.document;
    const nativeConfirm = frame.confirm('Embedded confirm regression probe');
    doc.querySelector('[data-delete-segment-id="native-segment"]').click();
    await wait(() => doc.getElementById('deleteSegmentDialog').open);
    doc.querySelector('#deleteSegmentDialog button[value="cancel"]').click();
    await wait(() => !doc.getElementById('deleteSegmentDialog').open);
    if (!doc.querySelector('[data-segment-id="native-segment"]')) throw Error('Cancellation removed transcript');
    doc.querySelector('[data-delete-segment-id="native-segment"]').click();
    await wait(() => doc.getElementById('deleteSegmentDialog').open);
    doc.querySelector('#deleteSegmentDialog button[value="delete"]').click();
    await wait(() => !doc.querySelector('[data-segment-id="native-segment"]'));
    await wait(() => doc.querySelector('[data-text-overlay-list-id]'));
    doc.querySelector('[data-text-overlay-list-id]').click();
    const input = doc.getElementById('textOverlayText');
    input.value = '本机详情编辑\n第二行'; input.dispatchEvent(new frame.Event('input', {bubbles:true}));
    const start = doc.getElementById('textStartTime');start.value = '.5';start.dispatchEvent(new frame.Event('change', {bubbles:true}));
    const duration = doc.getElementById('textDuration');duration.value = '1.2';duration.dispatchEvent(new frame.Event('change', {bubbles:true}));
    const project = await wait(async () => {
      const data = await invoke('studio_call', {method:'project:openFolder',payload:{targetRoot:root}});
      return data.assets[0].segments.length === 0 && data.assets[0].textOverlays[0].text === input.value && data.assets[0].textOverlays[0].end === 1.7 ? data : null;
    });
    await invoke('qa_done', {result:{ok:true,nativeConfirm,cancelRetainedCard:true,deleteRemovedCard:true,detailsText:project.assets[0].textOverlays[0]}});
  } catch (error) { await invoke('qa_done', {result:{ok:false,error:String(error)+'\n'+(error.stack || '')}}); }
});
