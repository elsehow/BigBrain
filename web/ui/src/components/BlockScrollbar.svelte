<script lang="ts">
  const { viewport, label = "Scroll results", controls = "search-results" }: { viewport?: HTMLDivElement; label?: string; controls?: string } = $props();
  let height = $state(0), top = $state(0), content = $state(0), scroll = $state(0);
  let dragging = $state(false), grab = 0;
  const thumbHeight = $derived(Math.min(height, Math.max(42, height * height / Math.max(1, content))));
  const thumbTop = $derived(scroll / Math.max(1, content - height) * (height - thumbHeight));
  $effect(() => {
    if (!viewport) return;
    const el = viewport;
    const sync = () => { height = el.clientHeight; top = el.offsetTop; content = el.scrollHeight; scroll = el.scrollTop; };
    const resize = new ResizeObserver(sync); resize.observe(el);
    if (el.firstElementChild) resize.observe(el.firstElementChild);
    const mutation = new MutationObserver(sync); mutation.observe(el, { childList:true, subtree:true });
    el.addEventListener('scroll', sync, { passive:true }); sync();
    return () => { resize.disconnect(); mutation.disconnect(); el.removeEventListener('scroll', sync); };
  });
  function move(e: PointerEvent) {
    if (!viewport || !dragging) return;
    const track = e.currentTarget as HTMLElement;
    viewport.scrollTop = Math.max(0, Math.min(1, (e.clientY - track.getBoundingClientRect().top - grab) / Math.max(1, height - thumbHeight))) * (content - height);
  }
  function down(e: PointerEvent) {
    e.preventDefault();
    const track = e.currentTarget as HTMLElement;
    const y = e.clientY - track.getBoundingClientRect().top;
    grab = y >= thumbTop && y <= thumbTop + thumbHeight ? y - thumbTop : thumbHeight / 2;
    dragging = true; track.setPointerCapture(e.pointerId); move(e);
  }
  function key(e: KeyboardEvent) {
    if (!viewport) return;
    const destinations: Record<string,number> = { ArrowDown:scroll + 42, ArrowUp:scroll - 42, PageDown:scroll + height, PageUp:scroll - height, Home:0, End:content };
    if (e.key in destinations) { e.preventDefault(); e.stopPropagation(); viewport.scrollTop = destinations[e.key]; }
  }
</script>
{#if content > height + 1}
  <div class="block-scrollbar" role="scrollbar" tabindex="0" aria-label={label} aria-controls={controls} aria-orientation="vertical"
    aria-valuemin="0" aria-valuemax={Math.max(0, content-height)} aria-valuenow={Math.round(scroll)}
    style:top={`${top}px`} style:height={`${height}px`}
    onpointerdown={down} onpointermove={move} onpointerup={() => dragging=false} onpointercancel={() => dragging=false} onkeydown={key}>
    <div class="thumb" style:height={`${thumbHeight}px`} style:transform={`translateY(${thumbTop}px)`}></div>
  </div>
{/if}
<style>
  .block-scrollbar { position:absolute; right:0; width:16px; margin:0; background:var(--bg); touch-action:none; cursor:pointer; }
  .thumb { width:100%; border-radius:0; background:var(--text-strong); pointer-events:none; }
  .block-scrollbar:focus-visible { outline:1px solid var(--text-strong); outline-offset:-1px; }
</style>
