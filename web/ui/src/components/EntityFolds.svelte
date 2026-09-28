<script lang="ts">
  // ENTITY FOLDS (#728): the labels the memory pass thinks are one thing,
  // one group per row, for the operator to settle. The pass proposes; the
  // person decides — an alias is a rule for every future claim, and a
  // wrong one is silent, so nothing here changes the record until ACCEPT.
  //
  // One group is a row of pills. The filled pill is the label that stays
  // (click another to move it — a radio, in effect); the × on a pill says
  // "not the same thing", which is a REJECT the record remembers for the
  // pair so the pass never proposes it again; ACCEPT aliases every pill
  // still standing into the filled one. A group left with one pill has
  // nothing to fold and leaves. Pure presentation: the owner does the
  // writes through `onaccept` / `onreject` and holds the proposals.
  import { untrack } from "svelte";
  import type { FoldGroup, FoldMember } from "../lib/types";
  import { tooltip } from "../lib/tooltip";

  const { groups, onaccept, onreject }: {
    groups: FoldGroup[];
    /** alias every `others` label into `canonical`. The row settles only
     * once this resolves; a rejection leaves it open (the owner says why). */
    onaccept: (canonical: FoldMember, others: FoldMember[]) => void | Promise<void>;
    /** `member` is not the same thing as `others` — every remaining pill.
     * The pill leaves only once this resolves. */
    onreject: (member: FoldMember, others: FoldMember[]) => void | Promise<void>;
  } = $props();

  interface Row {
    key: string;
    members: FoldMember[];
    canonical: string;
    /** the pass's one-line reason — kept for the CLI and the journal, not
     * shown here: the pills say it (Nick, 2026-09-03) */
    why: string;
    /** the row after ACCEPT — kept in place, quiet, so the eye can check */
    folded: FoldMember | null;
    /** an act is in flight: the row is dimmed and takes no second click */
    busy: boolean;
  }
  // Working copies, RECONCILED — never reset — when the prop changes: the
  // owner re-reads after every act and on every live ping, and a re-read
  // must not lose the pill you just picked or the FOLDED line you just
  // earned. A server group is matched to a row by any shared member. The
  // members are the server's (an act changes them only once the server
  // has said so — see accept/drop), the pick stays while it is still a
  // member, and a FOLDED row is sticky: a re-read that lists its group
  // again is stale (the swr cache, a ping racing the act's own re-read —
  // Nick saw the accepted group flash back and vanish, 2026-09-03), and
  // one that no longer lists it is the record catching up. Either way the
  // line stays until this mounts again.
  let rows = $state<Row[]>([]);
  const fresh = (g: FoldGroup): Row => ({
    key: g.members.map((m) => m.id).join("+"),
    members: [...g.members],
    canonical: g.canonical,
    why: g.why,
    folded: null,
    busy: false,
  });
  $effect(() => {
    const prev = untrack(() => rows);
    const matched = new Set<Row>();
    const next: Row[] = [];
    for (const g of groups) {
      const old = prev.find((r) => r.members.some((m) => g.members.some((x) => x.id === m.id)));
      if (!old) { next.push(fresh(g)); continue; }
      if (matched.has(old)) continue; // two server groups on one row: the first wins
      matched.add(old);
      if (old.folded) { next.push(old); continue; }
      next.push({
        ...old,
        members: [...g.members],
        canonical: g.members.some((m) => m.id === old.canonical) ? old.canonical : g.canonical,
        why: g.why,
      });
    }
    for (const r of prev) if (r.folded && !matched.has(r)) next.push(r);
    rows = next;
  });

  const open = $derived(rows.filter((r) => !r.folded && r.members.length > 1));
  const done = $derived(rows.filter((r) => r.folded));

  function keep(row: Row, m: FoldMember): void {
    if (!row.busy) row.canonical = m.id;
  }
  // The two acts apply AFTER the owner's promise resolves, and to the row
  // as it is THEN (by key — a re-read during the wait may have rebuilt
  // it, or, for an accept the record has already caught up on, dropped
  // it; the FOLDED line is owed either way). A rejection leaves the row as
  // it was: the owner shows why.
  const byKey = (key: string): Row | undefined => rows.find((r) => r.key === key);
  async function drop(row: Row, m: FoldMember): Promise<void> {
    if (row.busy) return;
    const key = row.key;
    row.busy = true;
    try {
      await onreject(m, row.members.filter((held) => held.id !== m.id));
    } catch {
      const cur = byKey(key);
      if (cur) cur.busy = false;
      return;
    }
    const cur = byKey(key);
    if (!cur) return;
    cur.busy = false;
    cur.members = cur.members.filter((held) => held.id !== m.id);
    // the kept label left: the most-cited of what remains stands in
    if (cur.canonical === m.id && cur.members[0]) cur.canonical = cur.members[0].id;
  }
  async function accept(row: Row): Promise<void> {
    const canonical = kept(row);
    if (!canonical || row.busy) return;
    const { key, why } = row;
    const members = [...row.members];
    row.busy = true;
    try {
      await onaccept(canonical, members.filter((m) => m.id !== canonical.id));
    } catch {
      const cur = byKey(key);
      if (cur) cur.busy = false;
      return;
    }
    const cur = byKey(key);
    if (cur) {
      cur.busy = false;
      cur.folded = canonical;
    } else rows.push({ key, members, canonical: canonical.id, why, folded: canonical, busy: false });
  }
  const kept = (row: Row): FoldMember | undefined => row.members.find((m) => m.id === row.canonical);
  const others = (row: Row): FoldMember[] => row.members.filter((m) => m.id !== row.canonical);
</script>

<!-- An admonishment (Nick, 2026-09-03): a tinted panel, since it asks for a
     decision, and nothing at all once no row is left to decide — a group
     pruned to one pill has nothing to merge and leaves with the pill. -->
{#if open.length || done.length}
<div class="folds">
  {#if open.length}
    <h2 class="title">Review duplicates</h2>
    <p class="lede">
      The following may be duplicates. If so, select the canonical and press Accept. Hit × to remove the suggestion.
    </p>
  {/if}

  {#each open as row (row.key)}
    {@const c = kept(row)}
    <section class="group" class:busy={row.busy} aria-busy={row.busy}>
      <div class="pills" role="radiogroup" aria-label="Which label stays">
        {#each row.members as m (m.id)}
          {@const on = m.id === row.canonical}
          <span class="pill" class:on>
            <button class="pick" role="radio" aria-checked={on} disabled={row.busy}
              use:tooltip={on ? "This label stays" : `Keep “${m.label}” instead`}
              onclick={() => keep(row, m)}>
              <span class="label">{m.label}</span>
              <span class="n">{m.assertions}</span>
            </button>
            <button class="drop" aria-label={`Not the same thing — remove ${m.label}`} disabled={row.busy}
              use:tooltip={"Not the same thing"} onclick={() => void drop(row, m)}>×</button>
          </span>
        {/each}
      </div>
      <div class="actions">
        {#if c}
          <span class="sum">
            {others(row).map((m) => m.label).join(", ")}
            <span class="arrow">→</span>
            <strong>{c.label}</strong>
          </span>
          <button class="btn-save" disabled={row.busy} onclick={() => void accept(row)}>ACCEPT</button>
        {/if}
      </div>
    </section>
  {/each}

  {#if done.length}
    <div class="done">
      <span class="eyebrow">FOLDED</span>
      {#each done as row (row.key)}
        <p class="done-row">
          {others(row).map((m) => m.label).join(", ")} <span class="arrow">→</span> <strong>{row.folded?.label}</strong>
        </p>
      {/each}
    </div>
  {/if}
</div>
{/if}

<style>
  /* the warning tint: the app's --warn at a wash, over whatever paper the
     theme wears, so the panel reads as "decide this" in light and dark */
  .folds { display: flex; flex-direction: column; gap: var(--sp-5);
    padding: var(--sp-6) var(--sp-7); border-radius: var(--r-ctl);
    background: var(--panel-bg); backdrop-filter: var(--panel-blur); -webkit-backdrop-filter: var(--panel-blur);
    box-shadow: inset 3px 0 0 color-mix(in srgb, var(--warn) 70%, transparent); }
  .title { font: var(--type-heading); letter-spacing: var(--ls-heading); color: var(--text-strong); margin: 0; }
  .lede { font: var(--type-body); color: var(--text-note); margin: 0; max-width: 64ch; }

  .group { display: flex; flex-direction: column; gap: var(--sp-3);
    padding: var(--sp-5) 0; border-top: 1px solid color-mix(in srgb, var(--warn) 22%, transparent); }
  .pills { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center; }
  /* an act in flight: the row waits for the record's word */
  .group.busy { opacity: 0.55; }
  .group.busy .pick, .group.busy .drop { cursor: default; }

  /* a pill is two buttons wearing one shape: the label (keep me) and the
     × (not the same thing). Filled = the one that stays. */
  .pill { display: inline-flex; align-items: stretch; border-radius: var(--r-full);
    background: var(--chip-neutral); color: var(--text); overflow: hidden;
    transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease); }
  .pill.on { background: var(--text-strong); color: var(--on-accent); }
  .pick, .drop { border: 0; background: none; color: inherit; cursor: pointer; font: var(--type-chip); }
  .pick { display: inline-flex; align-items: baseline; gap: var(--sp-2); padding: 6px 4px 6px 12px; }
  .pill:not(.on) .pick:hover { color: var(--text-strong); }
  .label { white-space: nowrap; }
  .n { font: var(--type-meta); opacity: 0.6; }
  .drop { padding: 0 10px 0 6px; font-size: 15px; line-height: 1; opacity: 0.45; }
  .drop:hover { opacity: 1; }
  .pill:not(.on) .drop:hover { color: var(--accent-5); }

  .actions { display: flex; align-items: center; gap: var(--sp-5); margin-top: var(--sp-1); }
  .sum { font: var(--type-meta); color: var(--text-note); }
  .sum strong { color: var(--text-strong); font-weight: 600; }
  .arrow { color: var(--text-faint); margin: 0 var(--sp-1); }
  /* .btn-save — app.css; the settings cards' one filled button */

  .eyebrow { font: var(--type-eyebrow); letter-spacing: var(--ls-eyebrow); color: var(--text-faint); }
  .done { display: flex; flex-direction: column; gap: var(--sp-2);
    padding-top: var(--sp-5); border-top: 1px solid color-mix(in srgb, var(--warn) 22%, transparent); }
  .done-row { font: var(--type-meta); color: var(--text-muted); margin: 0; }
  .done-row strong { color: var(--text-note); font-weight: 600; }
</style>
