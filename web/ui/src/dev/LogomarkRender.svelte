<script lang="ts">
  // THE RENDER STAGE — the mark alone (or the lockup), one theme, one
  // pose, nothing else on the page that matters: what bin/renderLogomark.cjs
  // screenshots frame by frame to cut the moving mark as video. The
  // configuration rides the query string; the time is set from outside,
  // through window.__logomarkFrame, so every frame is exact and the page
  // never runs a clock of its own.
  //
  //   ?c=logomark&s=render&theme=dusk&loop=flip&size=1024&wordmark=1&bg=1
  import Logomark from "../components/Logomark.svelte";
  import { FLIP, LOOPS, poseAt, SOLVED, TURN, type LoopName, type Pose } from "../lib/logomark";
  import { THEME_LABEL, THEMES } from "../lib/theme";

  const q = new URLSearchParams(location.search);
  // the theme by its id or by the name Settings › Theme shows for it
  const want = (q.get("theme") ?? "default").trim().toLowerCase();
  const theme = THEMES.find((t) => t === want || THEME_LABEL[t].toLowerCase() === want) ?? "default";
  const known = THEMES.some((t) => t === want || THEME_LABEL[t].toLowerCase() === want);
  const loop = LOOPS[(q.get("loop") ?? "flip") as LoopName] ?? FLIP;
  const size = Math.max(16, Number(q.get("size")) || 1024);
  const wordmark = q.get("wordmark") === "1";
  const opaque = q.get("bg") === "1";
  const turn = { turnMs: Number(q.get("turn")) || TURN.turnMs, holdMs: Number(q.get("hold")) || TURN.holdMs };
  let pose = $state<Pose>(SOLVED);
  // one pass of the loop, in ms — the renderer's default length
  const period = loop.reduce((ms, m) => ms + turn.holdMs + turn.turnMs * (Math.abs(m.by) > 90 ? 1.5 : 1), 0);
  $effect(() => {
    const w = window as unknown as {
      __logomarkFrame?: (t: number) => void; __logomarkPeriod?: number;
      __logomarkThemes?: { id: string; label: string }[]; __logomarkTheme?: string | null;
    };
    w.__logomarkFrame = (t: number) => { pose = poseAt(t, turn, loop); };
    w.__logomarkPeriod = period;
    w.__logomarkThemes = THEMES.map((id) => ({ id, label: THEME_LABEL[id] }));
    w.__logomarkTheme = known ? theme : null;
    // the page behind the stage goes clear, so a screenshot that omits
    // the document background gets true transparency around the mark
    document.documentElement.classList.add("logomark-render");
    return () => {
      delete w.__logomarkFrame; delete w.__logomarkPeriod; delete w.__logomarkThemes; delete w.__logomarkTheme;
      document.documentElement.classList.remove("logomark-render");
    };
  });
</script>

<div class="render" data-theme={theme} class:opaque style:--s="{size}px">
  <Logomark {size} {pose} />
  {#if wordmark}<span class="word">BigBrain</span>{/if}
</div>
<p class="how">theme {THEME_LABEL[theme]} ({theme}){known ? "" : " — not a theme; the default stands in"} · loop {loop === FLIP ? "flip" : q.get("loop")} · {size}px · one pass {period} ms — <code>bun run logomark:render</code> drives this.</p>

<style>
  :global(html.logomark-render), :global(html.logomark-render body), :global(html.logomark-render .wb), :global(html.logomark-render main) { background: transparent !important; }
  /* the lockup's proportions are the workbench's: a 56px mark beside the
     34px title, 16px apart — scaled with the mark */
  .render { display: inline-flex; align-items: center; gap: calc(var(--s) * 16 / 56); padding: 0; background: transparent; color: var(--fg); }
  .render.opaque { background: var(--bg); }
  .word { font: var(--fw-medium) calc(var(--s) * 34 / 56) / 1 var(--font-app); letter-spacing: var(--ls-title); color: var(--text-strong); padding-right: calc(var(--s) * 0.08); white-space: nowrap; }
  .how { font: var(--type-meta); color: var(--text-faint); margin: 16px 0 0; }
</style>
