<script lang="ts">
  import { vaultFetch as fetch } from "../lib/vaultScope";

  /** An account's recent live reads, from the read log BigBrain keeps on this
   * machine (lib/readLog.ts): when, who, which tool with what, and how it
   * ended. Read-only; loaded each time it is opened. */
  const { integration, account }: { integration: string; account: string } = $props();
  type Read = { ts: string; caller: string; label: string; tool: string; args: Record<string, unknown>; outcome: "ok" | "refused" | "error"; error?: string; first?: true };
  let reads = $state<Read[] | null>(null), error = $state("");
  async function load() {
    error = "";
    try {
      const r = await fetch(`/api/integration-reads?${new URLSearchParams({ integration, account })}`);
      const v = await r.json();
      if (!r.ok) throw Error(v.error || "Could not load recent reads.");
      reads = v.reads;
    } catch (e) { error = e instanceof Error ? e.message : "Could not load recent reads."; }
  }
  /** An argument's value as the line shows it: a ref by its last characters. */
  const shown = (key: string, value: unknown): string =>
    typeof value !== "string" ? JSON.stringify(value) : /(^|_)ref$/.test(key) && value.length > 12 ? "…" + value.slice(-8) : value;
  /** What was asked, in a line; the account is left out, since this card is it. */
  function asked(args: Record<string, unknown>): string {
    const text = Object.entries(args).filter(([k]) => k !== "account").map(([k, v]) => `${k} ${shown(k, v)}`).join(" · ");
    return text.length > 90 ? text.slice(0, 89) + "…" : text;
  }
  const when = (ts: string) => new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
</script>

<details class="reads" ontoggle={e => { if ((e.currentTarget as HTMLDetailsElement).open) void load(); }}>
  <summary>Recent reads</summary>
  {#if error}<p role="alert">{error}</p>
  {:else if reads === null}<p>Loading…</p>
  {:else if !reads.length}<p>No agent has read this account through BigBrain in the last 90 days.</p>
  {:else}
    <p>{reads.length === 1 ? "The last read" : `The last ${reads.length} reads`} by Pilot and connected agents, kept on this computer for at least 90 days. What they read is never kept.</p>
    <ol>
      {#each reads as read}
        <li>
          <time datetime={read.ts}>{when(read.ts)}</time>
          <span class="who">{read.label}</span>
          <span class="what"><code>{read.tool}</code> {asked(read.args)}</span>
          {#if read.outcome !== "ok"}<span class="status {read.outcome}" title={read.error}>{read.outcome === "refused" ? "Refused" : "Failed"}</span>
          {:else if read.first}<span class="status first" title="This caller's first read of this integration">First read</span>{/if}
        </li>
      {/each}
    </ol>
  {/if}
</details>

<style>
  .reads { border-top: 1px solid var(--rule); padding-top: 20px; display: grid; gap: 12px; min-width: 0; container-type: inline-size; }
  summary { cursor: pointer; font: var(--type-body); color: var(--text-strong); }
  summary:focus-visible { outline: 2px solid var(--activity); outline-offset: 3px; }
  p { margin: 0; font: var(--type-meta); color: var(--text-muted); }
  ol { list-style: none; margin: 0; padding: 0; display: grid; }
  li { display: grid; grid-template-columns: 10.5em minmax(6em, 12em) minmax(0, 1fr) auto; grid-template-areas: "time who what status"; gap: 4px 16px; align-items: baseline; padding: 8px 0; border-bottom: 1px solid var(--rule); font: var(--type-meta); color: var(--text); min-width: 0; }
  li:last-child { border-bottom: 0; }
  time { grid-area: time; color: var(--text-muted); }
  .who { grid-area: who; }
  .what { grid-area: what; }
  .who, .what { min-width: 0; overflow-wrap: anywhere; }
  .status { grid-area: status; white-space: nowrap; }
  code { font-family: var(--font-mono); color: var(--text-strong); }
  .first { padding: 0 6px; border: 1px solid var(--rule); color: var(--text-strong); }
  .refused { color: var(--text-strong); }
  .error, [role=alert] { color: var(--err); }
  @container (max-width: 560px) { li { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "time status" "who who" "what what"; } }
</style>
