<script lang="ts">
  // SETTINGS → THEMES. The palettes the design system carries (the comp's
  // tokens/themes.css, ported into design/tokens.css), offered as what they
  // are: whole colour schemes, chosen the way a terminal's is — and after
  // them this machine's own SKINS, YAML files in ~/.config/bigbrain/themes/
  // (lib/themes.ts on the engine side, lib/theme.ts here).
  //
  // Every swatch is PAINTED IN THE THEME IT OFFERS — data-theme on the box,
  // which is exactly how the app wears one — so the card is the thing
  // itself rather than a description of it. Three dots show the background,
  // foreground, and the one activity accent.
  //

  // The caption sits OUTSIDE the swatch, in the app's own ink, so "current"
  // reads the same on every card — a tick inside a card wearing its own
  // palette is legible on some and lost on others.
  //
  // The choice is this machine's (localStorage, lib/theme.ts): a viewer
  // preference, not vault content. The pairs lead: each follows the OS, its
  // card split between its light and dark halves. Ink is the default — what
  // an unset record means and what a first launch does.
  //
  // Below the grid, the skins' own card: where the files go, two acts
  // (WRITE EXAMPLE SKIN drops a full palette to copy; OPEN FOLDER shows the
  // folder in the OS), and every file that could not be read, named with
  // its reason — a skin that does not show up must say why.
  import { revealThemes, writeExampleSkin, type SkinsReport } from "../lib/skins";
  import {
    isPair,
    labelFor,
    loadSkins,
    PAIR_IDS,
    PAIRS,
    setChoice,
    skins,
    storedChoice,
    systemPrefersDark,
    THEME_LABEL,
    THEMES,
    type ThemeChoice,
  } from "../lib/theme";

  let choice = $state<ThemeChoice>(storedChoice());
  // which half a pair resolves to right now, named in the tab's reading
  const systemIs = $derived(systemPrefersDark() ? "dark" : "light");

  // undefined = not asked yet; null = no door (a headless host's viewer)
  let report = $state<SkinsReport | null | undefined>(undefined);
  let revealedPath = $state<string | null>(null); // the engine could not open it: show the path
  let wrote = $state<string | null>(null);

  async function load(): Promise<void> {
    try {
      report = await loadSkins();
      // a chosen skin the engine has only now told us about (a cold cache)
      // already paints the root — the ring must agree
      choice = storedChoice();
    } catch {
      /* the engine is not answering — keep what was last shown */
    }
  }
  // on mount, and again whenever the window is focused: a file saved in an
  // editor shows on the next click into the app
  $effect(() => {
    void load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  });
  const mine = $derived(report?.skins ?? skins());
  // the tab's reading: re-derived with the skins, so a skin's name is on it
  // as soon as the skin is known
  const reading = $derived(
    isPair(choice) ? `${labelFor(choice)} · ${systemIs}` : (mine.find((s) => s.id === choice)?.label ?? labelFor(choice))
  );

  function pick(next: ThemeChoice): void {
    choice = next;
    setChoice(next); // writes the record and repaints the root
  }
  async function reveal(): Promise<void> {
    const r = await revealThemes();
    revealedPath = r.ok ? null : r.path;
  }
  async function example(): Promise<void> {
    const r = await writeExampleSkin();
    wrote = r.existed ? `${r.path} was already there — left as it is.` : `Wrote ${r.path}.`;
    await load();
  }
</script>

<section class="themes" aria-label="Themes">
  <h2>Themes <span class="status">{reading}</span></h2>
  <div class="grid">
    {#each PAIR_IDS as id (id)}
      {@const pair = PAIRS[id]}
      <button class="card" class:on={choice === id} onclick={() => pick(id)}
        aria-pressed={choice === id}>
        <!-- the two it chooses between, split down the middle -->
        <div class="swatch split">
          <div class="half" data-theme={pair.light}><div class="line t"></div><div class="line"></div></div>
          <div class="half" data-theme={pair.dark}><div class="line t"></div><div class="line"></div></div>
        </div>
        <span class="cap">
          {pair.label}
          <span class="state">{choice === id ? "current" : "light + dark"}</span>
        </span>
      </button>
    {/each}

    {#each [...THEMES.map((t) => ({ id: t, label: THEME_LABEL[t] })), ...mine] as t (t.id)}
      <button class="card" class:on={choice === t.id} onclick={() => pick(t.id)}
        aria-pressed={choice === t.id}>
        <div class="swatch" data-theme={t.id}>
          <div class="line t"></div>
          <div class="line"></div>
          <div class="line short"></div>
          <div class="dots">
            <span style="background: var(--bg); border: 1px solid var(--rule)"></span>
            <span style="background: var(--fg)"></span>
            <span style="background: var(--activity)"></span>
          </div>
        </div>
        <span class="cap">
          {t.label}
          {#if choice === t.id}<span class="state">current</span>{/if}
        </span>
      </button>
    {/each}
  </div>

  {#if report !== null}
    <div class="item">
      <span class="name">Your skins</span>
      <p class="status">
        A skin is a YAML file in <code>{report?.dir ?? "~/.config/bigbrain/themes"}</code>:
        a name, three colours, and it is on this screen as soon as it is saved.
        The example is a whole palette to copy.
      </p>
      <div class="acts">
        <button class="btn-save" onclick={example}>WRITE EXAMPLE SKIN</button>
        <button class="btn-ghost" onclick={reveal}>OPEN FOLDER</button>
      </div>
      {#if wrote}
        <p class="status">{wrote}</p>
      {/if}
      {#if revealedPath}
        <p class="status">Could not open a folder here — it is <code>{revealedPath}</code>.</p>
      {/if}
      {#if report?.errors.length}
        <ul class="errors" aria-label="skins that could not be read">
          {#each report.errors as e (e.file)}
            <li><code>{e.file}</code> — {e.error}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</section>

<style>
  .themes { display:flex; flex-direction:column; gap:var(--sp-5); }
  h2 { font:var(--type-heading); margin:0; }
  /* auto-fill, so the cards reflow with the window rather than at breakpoints */
  .grid { display: grid; gap: var(--sp-5); grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); }
  .card { display: flex; flex-direction: column; gap: 7px; padding: 0;
    border: none; background: none; text-align: left; cursor: pointer; }

  /* the swatch IS the palette: its own --bg, its own rule, its own ink */
  .swatch { height: 84px; padding: 10px 11px; border-radius: var(--r-card);
    border: 1px solid var(--rule); background: var(--bg);
    display: flex; flex-direction: column; gap: 7px; overflow: hidden; }
  .swatch.split { flex-direction: row; gap: 0; padding: 0; }
  .half { flex: 1; min-width: 0; padding: 10px 9px; background: var(--bg);
    display: flex; flex-direction: column; gap: 7px; }

  /* mock text: a heading in strong ink, body in muted, so the card shows the
     palette's CONTRAST and not only its paper */
  .line { height: 5px; border-radius: 3px; background: var(--text-muted); width: 100%; }
  .line.t { background: var(--text-strong); width: 62%; height: 6px; }
  .line.short { width: 44%; }
  .dots { margin-top: auto; display: flex; gap: 5px; }
  .dots span { width: 9px; height: 9px; border-radius: var(--r-full); }

  .cap { display: flex; align-items: baseline; gap: var(--sp-3);
    font: var(--type-body); color: var(--text-faint); }
  .card:hover .cap { color: var(--text); }
  .card.on .cap { color: var(--text-strong); }
  /* the ring is the app's ink, not the card's: selection has to read the
     same across the palettes */
  .card.on .swatch { outline: 2px solid var(--text-strong); outline-offset: 2px; }
  .state { font: var(--type-meta); color: var(--text-muted); }

  /* the skins' card — the diagnostics screen's voice: a heading, a note,
     a row of acts */
  .item { display: flex; flex-direction: column; gap: var(--sp-5); }
  .name { font: var(--type-heading); letter-spacing: var(--ls-heading); color: var(--text-strong); }
  .status { margin: 0; font: var(--type-meta); color: var(--text-muted); max-width: 640px; }
  code { font: var(--type-mono); overflow-wrap: anywhere; }
  .acts { display: flex; flex-wrap: wrap; gap: var(--sp-3); }
  .errors { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--sp-2);
    font: var(--type-meta); color: var(--warn); }
</style>
