<script lang="ts">
  import { goto } from "../lib/store.svelte";
</script>
<!-- Home before anything has landed. DropZone (App) accepts a drop anywhere,
     so this only says so; the link is the one interactive thing here. -->
<div class="empty-vault">
  <h1>Drop something</h1>
  <p>Drag and drop an item to add it to your vault. <span>(Or connect some <a href="#/integrations" onclick={e => { e.preventDefault(); goto("integrations"); }}>Integrations</a>.)</span></p>
</div>
<style>
  /* FirstRun's heading and intro: this is the screen right after it. */
  .empty-vault { position: fixed; inset: 0; z-index: 1; display: grid; place-content: center; justify-items: center; gap: 18px;
    padding: 0 var(--app-gutter, 16px); text-align: center; pointer-events: none; }
  h1 { margin: 0; font-size: 38px; font-weight: 550; line-height: 1.15; letter-spacing: -.025em; }
  p { margin: 0; max-width: 46ch; font-size: 17px; line-height: 1.6; color: var(--text-muted); }
  p span { display: block; }
  a { color: var(--text-strong); text-underline-offset: 3px; pointer-events: auto; }
</style>
