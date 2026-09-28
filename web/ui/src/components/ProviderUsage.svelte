<script lang="ts">
  import type { ProviderMonitor } from "../../../../lib/run/monitorTypes";
  let { monitor, name }: { monitor?: ProviderMonitor; name: string } = $props();
  const roles = $derived(monitor?.roles ?? []);
  const total = $derived(roles.reduce((n, r) => n + r.tokens, 0));
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const number = (value: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  const date = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const label = (role: string) => role === "quick" ? "Quick" : role.charAt(0).toUpperCase() + role.slice(1);
  const color = (index: number) => `color-mix(in srgb, var(--activity) ${35 + index % 4 * 20}%, var(--bg))`;
</script>

<section class="monitor" aria-label={`${name} usage`}>
  <p class="title">BigBrain usage <span>· runs started in the last 7 days</span></p>
  {#if !monitor}
    <p class="meta">Usage monitoring is unavailable.</p>
  {:else if !roles.length}
    <p class="meta">No runs recorded yet. Usage appears as BigBrain works.</p>
  {:else}
    {#if total > 0}
      <div class="track" role="img" aria-label={`${number(total)} recorded tokens by role`}>
        {#each roles as role, index}
          <span style:width={`${role.tokens / total * 100}%`} style:background={color(index)} title={`${label(role.role)}: ${role.tokens.toLocaleString()} tokens`}></span>
        {/each}
      </div>
    {/if}
    <ul>
      {#each roles as role, index}
        <li><span class="role"><span class="swatch" style:background={color(index)}></span>{label(role.role)}</span><span>{role.measuredRuns ? `${number(role.tokens)} tokens` : 'Usage unavailable'} · {role.runs} run{role.runs === 1 ? '' : 's'}{role.partial ? ' · partial' : ''}</span></li>
      {/each}
    </ul>
    <p class="meta">Reported input, output, and cache tokens.</p>
    {#if roles.some(r => r.partial)}<p class="meta">Partial counts include only usage received so far; interrupted runs or missing reports may leave gaps.</p>{/if}
    {#if monitor.asOf}<p class="meta">As of {date(monitor.asOf)}</p>{/if}
  {/if}
  {#if monitor?.quota.windows.length}
    {#each monitor.quota.windows as quota}
      <p class="title">Account usage <span>· {quota.window.replaceAll('_', ' ')} · {pct(quota.used)} used</span></p>
      <div class="track" class:stale={quota.stale ?? monitor.quota.state === 'stale'} role="img" aria-label={`${pct(quota.used)} account usage, ${quota.window.replaceAll('_', ' ')}`}>
        <span class="account" style:width={`${quota.used * 100}%`}></span>
      </div>
      <p class="meta">{(quota.stale ?? monitor.quota.state === 'stale') ? 'Last reading' : 'As of'} {date(quota.asOf)} · reset {date(quota.resetsAt)}</p>
    {/each}
    <p class="meta">Provider-reported usage for the recorded account, including activity outside BigBrain.</p>
  {:else if monitor}
    <p class="meta">{monitor.quota.state === 'unsupported' ? 'Account quota is not available from this connection.' : monitor.accountIdentity === 'multiple' ? 'Usage spans multiple accounts; account quota is not combined.' : 'No account quota reading available yet.'}</p>
    {#if monitor.quota.state === 'unavailable'}
      <p class="meta">Quota readings use your connected subscription when the provider makes them available.</p>
    {/if}
  {/if}
</section>

<style>
  .monitor { display: flex; flex-direction: column; gap: var(--sp-2); width: 100%; max-width: 560px; }
  p { margin: 0; }
  .title { font: var(--type-body); color: var(--text-strong); }
  .title span, .meta { font: var(--type-meta); color: var(--text-muted); }
  .track { height: 10px; display: flex; border-radius: 999px; background: var(--chip-neutral); overflow: hidden; }
  .track span { display: block; flex: none; }
  .account { background: var(--accent); }
  .stale { opacity: .5; }
  .role { display: inline-flex; align-items: center; gap: 6px; }
  .swatch { width: 8px; height: 8px; border-radius: 2px; }
  ul { display: flex; flex-direction: column; gap: var(--sp-2); list-style: none; margin: 0; padding: 0; }
  li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--sp-2); font: var(--type-meta); color: var(--text); font-variant-numeric: tabular-nums; }
</style>
