// Injected before the production AppShell by profileNativeHomeWalk.cjs only.
(() => {
  const fetchLocal = window.fetch.bind(window), raf = window.requestAnimationFrame.bind(window);
  const config = window.nativeWalkConfig;
  const data = { intervals: [], callbacks: [], sizes: [], keyToFrame: [], errors: [], selections: new Set() };
  let active = false, previous;
  window.addEventListener('error', () => data.errors.push('page error'));
  window.addEventListener('unhandledrejection', () => data.errors.push('unhandled rejection'));
  window.requestAnimationFrame = callback => raf(time => {
    const start = performance.now();
    try { callback(time); } finally { if (active) data.callbacks.push(performance.now() - start); }
  });
  const sample = time => {
    if (active) {
      if (previous !== undefined) data.intervals.push(time - previous);
      data.sizes.push([innerWidth, innerHeight, devicePixelRatio, document.hidden, document.hasFocus()]);
    }
    previous = active ? time : undefined;
    raf(sample);
  };
  raf(sample);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const post = (type, value) => fetchLocal('/__native-profile-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, value }) });
  const press = key => {
    const start = performance.now();
    window.dispatchEvent(new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key, code: `Key${key.toUpperCase()}`, bubbles: true }));
    if (active) raf(() => data.keyToFrame.push(performance.now() - start));
  };
  void (async () => {
    for (let i = 0; config.probe !== 'blank' && i < 600; i++) {
      const layout = JSON.parse(sessionStorage.getItem('bb:overview-layout:1') || 'null');
      if (document.querySelector('.lg-wrap canvas') && layout?.positions?.length >= config.nodes - 10) break;
      if (i === 599) throw Error('Graph layout did not finish');
      await pause(100);
    }
    if (!window.__TAURI__) throw Error('Expected the native Tauri shell');
    for (let i = 0; i < 100; i++) {
      const response = await post('ready', { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, focused: document.hasFocus(), hidden: document.hidden });
      if ((await response.json()).start) break;
      if (i === 99) throw Error('Could not fix the native viewport');
      await pause(250);
    }
    await pause(2500);
    if (config.probe !== 'blank') { press('j'); await pause(200); press('k'); await pause(1200); }
    const canvas = document.querySelector('.graph-renderer canvas');
    const beforeEffects = canvas?.profileStats.effectDrawCalls ?? 0, beforeBreathing = canvas?.profileStats.breathingDrawCalls ?? 0;
    active = true;
    for (const key of [...Array(12).fill('j'), ...Array(12).fill('k')]) {
      if (config.probe !== 'blank') press(key);
      await pause(180);
      data.selections.add(document.querySelector('.workspace-menu [aria-current="true"] .title')?.textContent || '');
    }
    active = false;
    await post('result', { ...data, selections: data.selections.size,
      workingAgents: canvas?.profilePresentation().nodes.filter(n => n.phase === 'working').length ?? 0,
      effect: canvas?.profilePresentation().effects ?? 'none',
      effectDrawCalls: (canvas?.profileStats.effectDrawCalls ?? 0) - beforeEffects,
      breathingDrawCalls: (canvas?.profileStats.breathingDrawCalls ?? 0) - beforeBreathing,
      theme: document.documentElement.dataset.theme,
      provenance: document.querySelector('#preview-provenance')?.textContent,
      native: !!window.__TAURI__, userAgent: navigator.userAgent,
      canvases: [...document.querySelectorAll('.lg-wrap > canvas')].map(c => ({ width: c.width, height: c.height, cssWidth: c.clientWidth, cssHeight: c.clientHeight })),
      renderer: config.probe === 'blank' ? 'blank' : document.querySelector('.graph-renderer') ? 'webgl' : 'baseline',
    });
  })().catch(error => post('failure', { message: String(error) }));
})();
