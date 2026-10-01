<script lang="ts">
  import { goto } from "../lib/store.svelte";
</script>
<!-- Home before anything has landed. DropZone (App) accepts a drop anywhere,
     so this only says so; the link is the one interactive thing here. -->
<div class="empty-vault">
  <h1>Drop <em>something</em></h1>
  <p>Drag and drop an item to add it to your vault. <span>(Or connect some <a href="#/integrations" onclick={e => { e.preventDefault(); goto("integrations"); }}>Integrations</a>.)</span></p>
</div>
<style>
  .empty-vault { position: fixed; inset: 0; z-index: 1; display: grid; place-content: center; justify-items: center; gap: var(--sp-6);
    padding: 0 var(--app-gutter, 16px); text-align: center; pointer-events: none; animation: arrive 420ms cubic-bezier(.2,.8,.2,1) both; }
  h1 { margin: 0; font: 400 clamp(52px, 9vw, 96px)/.95 var(--font-display); letter-spacing: -.015em; color: var(--text-strong); }
  p { margin: 0; max-width: 46ch; font: var(--fw-regular) var(--fs-lead)/1.5 var(--font-app); color: var(--text-muted); text-wrap: balance; }
  p span { display: block; }
  a { color: var(--text-strong); text-decoration: underline; text-decoration-color: var(--activity); text-decoration-thickness: 2px; text-underline-offset: 4px; pointer-events: auto; }
  a:hover { color: var(--activity); }
  @keyframes arrive { from { opacity: 0; transform: translateY(6px); } }
</style>
