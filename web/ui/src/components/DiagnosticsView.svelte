<script lang="ts">
  // SETTINGS → DIAGNOSTICS (#710). The facts a stalled vault's owner needs
  // — where the engine and the vault are, whether `claude` is on the jobs
  // PATH and signed in, when each job fires next, whether an intake round
  // holds the lock — and the tail of every log the app writes, on one
  // screen. Then three acts: COPY DEBUG BUNDLE puts all of it on the
  // clipboard as text (a tester pastes it into a message — the webview
  // cannot download, and a text thread wants text); RUN CHECK makes the
  // one call every stalled-intake report comes down to, `claude -p` as the
  // scheduled tick spawns it; REVEAL LOGS opens the folder in the OS.
  //
  // Give people enough context to report a stalled ingestion.
  // Nothing here is new evidence — every line shown was already being
  // written; it was in two places nobody finds.
  import PerformanceDiagnostics from "./PerformanceDiagnostics.svelte";
  import SettingsPage from "./SettingsPage.svelte";
  import { diagnosticsReport, diagnosticsText, revealLogs, runProbe, type DiagnosticsReport, type ProbeResult } from "../lib/diagnostics";
  import { appVersion } from "../lib/native";
  import { app } from "../lib/store.svelte";

  // undefined = not answered yet; null = no door (a headless host's viewer)
  let report = $state<DiagnosticsReport | null | undefined>(undefined);
  let version = $state<string | null>(null);
  let copied = $state(false);
  let probing = $state(false);
  let probe = $state<ProbeResult | null>(null);
  let revealedPath = $state<string | null>(null); // the engine could not open it: show the path

  async function load(): Promise<void> {
    try {
      report = await diagnosticsReport();
    } catch {
      /* the engine is not answering — keep what was last shown */
    }
  }
  // on mount and on every live ping — the logs move with the vault
  $effect(() => { void app.rev; void load(); });
  $effect(() => { void appVersion().then((v) => { version = v; }); });

  async function copy(): Promise<void> {
    const text = await diagnosticsText(version);
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => { copied = false; }, 1600);
    } catch {
      /* clipboard unavailable (non-secure context) — the button just doesn't confirm */
    }
  }
  async function check(): Promise<void> {
    probing = true;
    probe = null;
    try {
      probe = await runProbe();
    } catch (e) {
      probe = { name: "claude-probe", ok: false, level: "fail", detail: e instanceof Error ? e.message : String(e) };
    } finally {
      probing = false;
    }
  }
  async function reveal(): Promise<void> {
    const r = await revealLogs();
    revealedPath = r.ok ? null : r.path;
  }

  // "in 3m" / "now", against the report's own clock so a stale report
  // does not count down on screen
  const fmtIn = (ms: number): string => {
    const m = Math.round(ms / 60_000);
    return m <= 0 ? "now" : m < 90 ? `in ${m}m` : `in ${Math.floor(m / 60)}h ${m % 60}m`;
  };
  const fmtAgo = (ms: number): string => {
    const m = Math.round(ms / 60_000);
    if (m <= 0) return "just now";
    if (m < 90) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return h < 48 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ago`;
  };
  function fires(f: DiagnosticsReport["facts"]): string {
    if (!f.nextFires) return "no live supervisor keeps the clock";
    const at = Date.parse(f.at);
    const rows = Object.entries(f.nextFires).map(([job, t]) => `${job} ${fmtIn(t - at)}`);
    return rows.join(" · ") || "none scheduled";
  }
  // the memory pass: last fold, next sweep, and the last attempt when it
  // failed — a failed run takes the interval's slot without a word
  // anywhere else (lib/memoryRun.ts), so this row is the word
  function memory(f: DiagnosticsReport["facts"]): string {
    const m = f.memory!;
    if (!m.lastRunAt && !m.nextRunAt && !m.failed) return "never run — the first run is bigbrain tend --force";
    const at = Date.parse(f.at);
    const parts = [
      m.lastRunAt ? `last folded ${fmtAgo(at - Date.parse(m.lastRunAt))}` : "never folded",
      m.nextRunAt ? `next ${fmtIn(Date.parse(m.nextRunAt) - at)}` : "not on the clock",
    ];
    if (m.failed)
      parts.push(`last attempt failed${m.failed.at ? ` ${fmtAgo(at - Date.parse(m.failed.at))}` : ""}: ${m.failed.error}`);
    return parts.join(" · ");
  }
  const facts = $derived.by(() => {
    const f = report?.facts;
    if (!f) return [];
    return [
      ["engine", f.engine + (f.bundle ? ` (${f.bundle.replace(/\n/g, ", ")})` : " (checkout)")],
      ["vault", f.vault],
      ["supervisor", f.supervisor === null ? "none" : `pid ${f.supervisor} (${f.supervisorAlive ? "alive" : "gone"})`],
      ["platform", `${f.platform} · bun ${f.bun}`],
      ["model", `${f.connection?.provider ?? "unknown"} · Pi · ${f.connection?.connected ? "connected" : "check Models settings"}`],
      ...(f.memory ? [["memory", memory(f)]] : []),
      ["jobs PATH", f.jobsPath],
      ["next fires", fires(f)],
      ["intake", f.intake.running ? `running (lock pid ${f.intake.lockPid})` : f.intake.lockPid ? `idle (stale lock from pid ${f.intake.lockPid})` : "idle"],
    ] as [string, string][];
  });
  // the gardener cannot run: no claude, a signed-out one under max, no key under api, or no supervisor
  const warn = $derived.by(() => {
    const f = report?.facts;
    if (!f) return false;
    return !f.connection?.connected || !f.supervisorAlive;
  });
  const fmtWhen = (iso: string | null): string => (iso ? new Date(iso).toLocaleTimeString() : "");
</script>

<SettingsPage active="diagnostics" title="DIAGNOSTICS" value={version ?? undefined}>
  {#if report === null}
    <p class="status">
      This screen needs the desktop app. On a headless host the job logs are in the vault's
      <code>.state/logs/</code> and there is no shell log.
    </p>
  {:else if report === undefined}
    <p class="status">reading the logs…</p>
  {:else}
    {#if report.facts.memory?.rebuildRecommended}
      <div class="item" role="status">
        <span class="name">Memory update available</span>
        <p class="status">BigBrain’s memory instructions have improved. Rebuild your memory
          from the source record to use them fully. Your current memory will be backed up.
          Regular updates will continue until you choose to rebuild.</p>
        <p class="status">Run in a terminal: <code>bigbrain memory --from-scratch</code></p>
      </div>
    {/if}
    <PerformanceDiagnostics />
    <div class="item">
      <span class="name">This machine</span>
      <dl class="facts" class:warn>
        {#each facts as [k, v] (k)}
          <dt>{k}</dt>
          <dd>{v}</dd>
        {/each}
      </dl>
      <div class="acts">
        <button class="btn-save" onclick={copy}>{copied ? "COPIED" : "COPY DEBUG BUNDLE"}</button>
        <button class="btn-ghost" onclick={check} disabled={probing}>{probing ? "CHECKING…" : "RUN CHECK"}</button>
        <button class="btn-ghost" onclick={reveal}>REVEAL LOGS</button>
        <button class="btn-ghost" onclick={load}>REFRESH</button>
      </div>
      {#if probing}
        <p class="status">Checking the curation agent with a short model call — up to two minutes.</p>
      {:else if probe}
        <p class="status" class:ok={probe.ok} class:bad={!probe.ok}>
          {probe.ok ? "The curation agent answered." : probe.detail}{#if !probe.ok && probe.fix}<br />{probe.fix}{/if}
        </p>
      {/if}
      {#if revealedPath}
        <p class="status">Could not open a folder here — the logs are in <code>{revealedPath}</code>.</p>
      {/if}
    </div>

    {#each report.logs as log (log.name)}
      <section class="log" aria-label={`${log.name} log`}>
        <div class="log-head">
          <span class="log-name">{log.name}</span>
          <span class="log-meta">
            {#if log.missing}
              nothing written yet · {log.path}
            {:else}
              last {log.lines.length}{log.total !== null ? ` of ${log.total}` : ""} lines · {Math.max(1, Math.round(log.bytes / 1024))}KB · {fmtWhen(log.modified)} · {log.path}
            {/if}
          </span>
        </div>
        {#if !log.missing}
          <pre class="tail">{log.lines.length ? log.lines.join("\n") : "(empty)"}</pre>
        {/if}
      </section>
    {/each}
  {/if}
</SettingsPage>

<style>
  .item { display: flex; flex-direction: column; gap: var(--sp-5); }
  .name { font: var(--type-heading); letter-spacing: var(--ls-heading); color: var(--text-strong); }
  .status { margin: 0; font: var(--type-meta); color: var(--text-muted); max-width: 640px; }
  .status.ok { color: var(--accent-3); }
  .status.bad { color: var(--warn); }
  code { font: var(--type-mono); }

  /* the facts: label | value, the value in the machine's mono voice and
     free to wrap — a jobs PATH is long and must never scroll the page */
  .facts { display: grid; grid-template-columns: max-content 1fr; gap: var(--sp-2) var(--sp-6); margin: 0; }
  .facts dt { font: var(--type-eyebrow); letter-spacing: var(--ls-eyebrow); color: var(--text-faint); padding-top: 2px; }
  .facts dd { margin: 0; font: var(--type-mono); color: var(--text); overflow-wrap: anywhere; }

  .acts { display: flex; flex-wrap: wrap; gap: var(--sp-3); }

  .log { display: flex; flex-direction: column; gap: var(--sp-3); }
  .log-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2) var(--sp-4); }
  .log-name { font: var(--type-heading); letter-spacing: var(--ls-heading); color: var(--text-strong); }
  .log-meta { font: var(--type-meta); color: var(--text-faint); overflow-wrap: anywhere; }
  /* the tail scrolls inside its own box, both ways: a log line is as long
     as the process made it */
  .tail { margin: 0; max-height: 280px; overflow: auto; padding: var(--sp-4);
    background: var(--well); border-radius: var(--r-sm); font: var(--type-mono);
    font-size: 12px; line-height: 1.5; color: var(--text); white-space: pre; }
</style>
