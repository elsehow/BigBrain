<script lang="ts">
  import { onMount } from "svelte";
  import { telemetryState, type TelemetrySnapshot } from "../lib/telemetry";
  let metrics = $state<TelemetrySnapshot | null>(null);
  let error = $state("");
  let saving = $state(false);
  const latest = $derived(metrics?.samples.at(-1));
  async function refresh(): Promise<void> {
    try { metrics = await telemetryState(); error = ""; } catch { error = "Performance diagnostics unavailable."; }
  }
  async function consent(enabled: boolean): Promise<void> {
    saving = true;
    try { metrics = await telemetryState({ enabled }); error = ""; } catch { error = "Could not save sharing preference."; }
    finally { saving = false; }
  }
  onMount(() => { void refresh(); const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 10_000); return () => clearInterval(timer); });
</script>
{#if metrics}
  <section aria-label="Performance">
    <h2>Performance</h2>
    <p>Viewer engine only. CPU uses one core as 100%. Memory excludes the app window and model processes. GPU measurements are not available.</p>
    {#if latest}
      <dl>
        <dt>CPU</dt><dd>{latest.cpuPercent.toFixed(1)}%</dd>
        <dt>Memory</dt><dd>{latest.rssMB} MB</dd>
        <dt>Timer delay</dt><dd>{latest.timerDelayMs} ms</dd>
        <dt>State</dt><dd>{latest.foreground ? "Foreground" : "Background"} · {latest.gardening ? "Gardening" : "Gardener idle"}</dd>
        <dt>Engine running</dt><dd>{latest.ageMinutes} minutes</dd>
        <dt>Memory range</dt><dd>{Math.min(...metrics.samples.map(s => s.rssMB))}–{Math.max(...metrics.samples.map(s => s.rssMB))} MB over {metrics.samples.length} samples</dd>
      </dl>
    {:else}<p>Waiting for the first sample (up to 10 seconds).</p>{/if}
    {#if Object.keys(metrics.operations).length}
      <table><caption>Requests in the current five-minute window</caption><thead><tr><th>Operation / gardener state</th><th>Count</th><th>Mean</th><th>Max</th></tr></thead><tbody>
        {#each Object.entries(metrics.operations) as [operation, value]}
          <tr><td>{operation.replaceAll("_", " ")}</td><td>{value.count}</td><td>{Math.round(value.totalMs / value.count)} ms</td><td>{Math.round(value.maxMs)} ms</td></tr>
        {/each}
      </tbody></table>
    {/if}
    {#each Object.entries(metrics.actions) as [action, count]}
      <p>{action.replaceAll("_", " ")}: {count} in this five-minute window</p>
    {/each}
    <label><input type="checkbox" checked={metrics.enabled} disabled={saving} onchange={e => void consent(e.currentTarget.checked)} /> Share usage and performance statistics</label>
    <p>Optional. Sends numeric performance summaries and usage counts to PostHog, linked by a random installation ID. Never sends vault content, prompts, search queries, file paths, or logs. Turning this off clears unsent reports. Local measurements remain available.</p>
    <p>{!metrics.configured ? "Hosted reporting is not configured in this build." : !metrics.enabled ? "Sharing is off." : metrics.delivery === "retrying" ? "Delivery will retry. Reports are kept briefly in memory." : metrics.delivery === "sent" ? "Reports delivered." : "Sharing is on. Reports are sent every five minutes."}</p>
  </section>
{/if}
{#if error}<p role="alert">{error}</p>{/if}
<style>
  section { display: flex; flex-direction: column; gap: var(--sp-4); }
  h2 { margin: 0; font: var(--type-heading); }
  p { margin: 0; color: var(--text-muted); font: var(--type-meta); max-width: 700px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: var(--sp-2) var(--sp-6); margin: 0; }
  dd { margin: 0; } table { text-align: left; font: var(--type-meta); } th, td { padding: var(--sp-2); } caption { text-align: left; }
</style>
