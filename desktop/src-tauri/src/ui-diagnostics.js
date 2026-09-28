// Injected only when BIGBRAIN_UI_DIAGNOSTICS=on|graph-off. Local native log only.
(() => {
  const mode = window.__BIGBRAIN_UI_DIAGNOSTICS_MODE__;
  const origin = performance.now();
  let sequence = 0, inputs = 0, frames = 0, renders = 0, renderMax = 0;
  let lastPulse = performance.now(), lastFrame = 0, lastRender = 0, outstanding = 0;
  const send = (event, id = 0, values = []) => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke || outstanding >= 32) return;
    outstanding++;
    void invoke('ui_diagnostic', { sample: { event, id, values: values.map(v => Math.round(v * 100) / 100) } })
      .catch(() => {}).finally(() => outstanding--);
  };
  window.__BIGBRAIN_UI_DIAGNOSTICS__ = {
    graphOff: mode === 'graph-off',
    probe: id => send('native_probe', id, [performance.now() - origin, document.hidden ? 1 : 0]),
    render: (phase, ms = 0) => {
      if (phase === 'error') send('render_error');
      if (phase === 'end') { renders++; renderMax = Math.max(renderMax, ms); lastRender = performance.now(); }
    },
  };
  const input = event => {
    // Do not collect event.key, target text/attributes, coordinates or contents.
    if (!event.isTrusted) return;
    inputs++;
    // Bound diagnostic overhead during scrolling/key repeat.
    const now = performance.now();
    if (now - (input.last || -Infinity) < 100) return;
    input.last = now;
    const id = ++sequence;
    const kinds = { pointerdown: 'input_pointer', keydown: 'input_key', click: 'input_click', wheel: 'input_wheel' };
    const delay = event.timeStamp > 0 && event.timeStamp <= now ? now - event.timeStamp : -1;
    send(kinds[event.type], id, [now - origin, delay]);
    requestAnimationFrame(() => {
      send('input_frame', id, [performance.now() - now]);
      requestAnimationFrame(() => send('input_settled', id, [performance.now() - now]));
    });
  };
  for (const name of ['pointerdown', 'keydown', 'click', 'wheel'])
    window.addEventListener(name, input, { capture: true, passive: true });
  window.addEventListener('error', e => send('error', 0, [e.lineno || 0, e.colno || 0]), true);
  window.addEventListener('unhandledrejection', () => send('rejection'));
  document.addEventListener('webglcontextlost', () => send('context_lost'), true);
  document.addEventListener('webglcontextrestored', () => send('context_restored'), true);
  document.addEventListener('visibilitychange', () => {
    lastPulse = performance.now(); send('visibility', 0, [document.hidden ? 1 : 0]);
  });
  // One frame probe per second, not a permanent 60 Hz animation loop.
  setInterval(() => {
    const now = performance.now();
    send('heartbeat', 0, [now - origin, now - lastPulse, inputs, frames, renders, renderMax,
      lastFrame ? now - lastFrame : -1, lastRender ? now - lastRender : -1,
      document.hidden ? 1 : 0, document.hasFocus() ? 1 : 0]);
    lastPulse = now; inputs = frames = renders = renderMax = 0;
    if (!document.hidden) requestAnimationFrame(() => { frames++; lastFrame = performance.now(); });
  }, 1000);
  window.addEventListener('DOMContentLoaded', () => send('start', 0, [mode === 'graph-off' ? 1 : 0]), { once: true });
})();
