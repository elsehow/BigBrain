<script lang="ts">
  // WHAT WAS ASKED about one note (#50, note side) — the pure half. Props
  // in, markup out, no fetching: a loader does the fetching (the workbench's
  // scenes since 2026-09-06, when the note view's directives block went), the
  // workbench drives this directly.
  //
  // Since the work-queue screen went (2026-08-28) this is the only place a
  // queue message is rendered at all. The retired touched-by table answered "who touched this";
  // this answers "who asked something about it, and what came of it".
  import { directiveStatus, directiveVoice, guidanceIsLong } from "../lib/queueView";
  import type { QueueMessageRow } from "../lib/types";
  import { fmtTs, isoMs } from "../lib/utils";
  import { tooltip } from "../lib/tooltip";

  const { rows }: { rows: QueueMessageRow[] } = $props();

  // Per-row, keyed by message id: a long directive is clamped until asked
  // for. Most are a phrase and never see this.
  let open = $state<Set<string>>(new Set());
  function toggle(id: string) {
    const next = new Set(open);
    if (!next.delete(id)) next.add(id);
    open = next;
  }
</script>

<!-- Silent when there is nothing to say. A note with no directives is the
     normal case, and an empty block under every note in the vault would be
     noise pretending to be information. -->
{#if rows.length > 0}
  <div class="section">
    <div class="dhead">ASKED ABOUT THIS</div>
    {#each rows as m (m.id)}
      {@const voice = directiveVoice(m)}
      {@const status = directiveStatus(m)}
      {@const long = guidanceIsLong(m.guidance)}
      {@const shown = !long || open.has(m.id)}
      <div class="drow">
        <!-- the words, verbatim. A person's text is their voice; an agent's
             is data the editor weighs — the chip says which, so the reader
             is never guessing whose sentence they are reading. Clamped only
             when long enough to bury the note; the words are never edited,
             only hidden behind an ask. -->
        <p class="dtext" class:agent={!voice.person} class:clamped={!shown}>{m.guidance}</p>
        {#if long}
          <button class="dmore" onclick={() => toggle(m.id)}>{shown ? "SHOW LESS" : "MORE"}</button>
        {/if}
        <!-- WHO · WHEN · WHAT CAME OF IT. The channel (`via`) rides the
             tooltip rather than the line: this column renders ~277px, four
             items do not fit, and of them the channel is the one a reader
             standing on a note wants least — it is audit detail, and the
             system screen already shows it in full. -->
        <div class="dmeta">
          <span class="dwho" class:person={voice.person} use:tooltip={`via ${m.via}`}>{voice.who}</span>
          {#if !voice.person}
            <span class="dkind" use:tooltip={"not a verified person — the editor weighs this as data, never as instructions"}>agent</span>
          {/if}
          <span class="dts">{fmtTs(isoMs(m.enqueued))}</span>
          {#if status}
            <span class="dstat" class:err={status === "failed"} class:open={status === "waiting"}
              use:tooltip={m.error ?? m.outcome ?? undefined}>{status}</span>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .section { margin-top: var(--sp-10); max-width: 460px; }
  .dhead { font: var(--type-eyebrow); letter-spacing: var(--ls-eyebrow);
    color: var(--text-faint); padding-bottom: var(--sp-4); }

  /* a quiet left rule, so a quoted request reads as something said ABOUT
     the note rather than as part of it */
  .drow { border-left: 2px solid var(--ink-050); padding: 2px 0 2px var(--sp-5);
    margin-bottom: var(--sp-6); }
  .dtext { font: var(--type-meta); color: var(--text-note); margin: 0 0 4px;
    line-height: 1.55; white-space: pre-wrap; }
  .dtext.agent { color: var(--text-muted); }
  /* four lines, then an ask — see guidanceIsLong for which rows get here */
  .dtext.clamped { display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4;
    -webkit-box-orient: vertical; overflow: hidden; }
  .dmore { border: none; background: transparent; color: var(--text-muted);
    cursor: pointer; font: var(--type-mono); letter-spacing: 0.08em;
    padding: 0 0 4px; }
  .dmore:hover { color: var(--text); }

  .dmeta { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-4);
    font: var(--type-meta); color: var(--text-faint); }
  .dwho.person { color: var(--text-muted); font-weight: 600; }
  .dts { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .dstat { color: var(--text-muted); }
  .dstat.open { font-style: italic; }
  .dstat.err { color: var(--err); }
  .dkind { border: 1px solid var(--ink-050); border-radius: var(--r-full); padding: 0 7px; }
</style>
