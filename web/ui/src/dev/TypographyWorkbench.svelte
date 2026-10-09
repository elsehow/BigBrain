<script lang="ts">
  let frame = $state<HTMLIFrameElement>();
  let proposed = $state(true);
  let theme = $state('default');
  let status = $state('Pilot');
  let layout = $state('compact');
  const themes = ['default','dusk','kind-of-blue-light','kind-of-blue-dark','web','somethings-gotta-give','moegiiro','adzukiiro','asagiiro'];
  function apply() {
    const root = frame?.contentDocument?.documentElement;
    if (root) {root.dataset.typeStudy = proposed ? 'proposed' : 'current';root.dataset.theme = theme;root.dataset.studyDock = layout === 'bottom' ? 'bottom' : 'side';}
  }
  $effect(() => {void proposed;void theme;void layout;apply();});
  function arrange(next: string) {
    layout = next;
    apply();
    frame?.contentDocument?.querySelector<HTMLButtonElement>(`button[aria-label="${next === 'compact' ? 'Standard text tab' : 'Expand text tab'}"]`)?.click();
  }
  function loaded() {
    apply();
    const doc = frame?.contentDocument;
    if (doc) {
      const observer = new MutationObserver(() => {
        if (!doc.querySelector('.pilot-panel')) return;
        observer.disconnect(); arrange(layout);
      });
      if (doc.querySelector('.pilot-panel')) arrange(layout);
      else observer.observe(doc.body, {childList:true, subtree:true});
    }
    const win = frame?.contentWindow;
    win?.addEventListener("hashchange", () => {
      status = win.location.hash.startsWith("#/session/") ? "Pilot" : "Note";
      if (status === 'Pilot') win.setTimeout(() => arrange(layout), 0);
    });
  }
  function navigate(view: string) {
    const doc = frame?.contentDocument, win = frame?.contentWindow;
    if (!doc || !win) return;
    win.location.hash = view === 'Pilot' ? doc.documentElement.dataset.pilotRoute! : '/vault/memory/project.md';
    status = view;
  }
</script>
<div class="study">
  <header>
    <strong>Text tab / Pilot</strong><span class="label">Real app · sample data · dev only</span>
    <nav aria-label="Preview specimen"><button class:active={status === 'Pilot'} onclick={() => navigate('Pilot')}>Pilot</button><button class:active={status === 'Note'} onclick={() => navigate('Note')}>Note</button></nav>
    <nav aria-label="Typography comparison"><button class:active={!proposed} onclick={() => proposed = false}>Current</button><button class:active={proposed} onclick={() => proposed = true}>Typography study</button></nav>
    <nav aria-label="Expanded layout"><button class:active={layout === 'compact'} onclick={() => arrange('compact')}>Compact</button><button class:active={layout === 'bottom'} onclick={() => arrange('bottom')}>Expanded bottom</button><button class:active={layout === 'side'} onclick={() => arrange('side')}>Expanded left</button></nav>
    <select aria-label="Palette" bind:value={theme}>{#each themes as t}<option value={t}>{t}</option>{/each}</select>
  </header>
  <iframe title="Production BigBrain interface with sample data" src="/type-app.html" bind:this={frame} onload={loaded}></iframe>
  <footer>Same app and content. Compact bottom tab; Pilot’s ↑ expands left and ↓ returns to compact. Side layout falls back to bottom below 1050px. Sample replies; no agent runs.</footer>
</div>
<style>
  .study{height:100dvh;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font-family:var(--font-app)}
  header{display:flex;align-items:center;gap:16px;padding:10px 20px;border-bottom:1px solid var(--rule);flex-wrap:wrap;font-size:13px}strong{font-size:15px}.label{opacity:.6;margin-right:auto}nav{display:flex;gap:4px}
  button,select{font:inherit;padding:7px 10px;border:1px solid var(--rule);border-radius:5px;background:var(--bg);color:var(--fg);cursor:pointer}button.active{background:var(--fg);color:var(--bg)}
  iframe{width:100%;flex:1;min-height:0;border:0}footer{font-size:12px;color:var(--text-muted);padding:8px 20px;border-top:1px solid var(--rule)}
</style>
