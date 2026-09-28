<script lang="ts">
  import type { ProjectGrant } from '../../../../lib/worker/projects';
  let { grant }: { grant?: ProjectGrant } = $props();
</script>
{#if grant}
  <dl><dt>Project</dt><dd>{grant.path}</dd><dt>Access</dt><dd>{grant.mode === 'work' ? 'Edits, local deletion, and commands' : 'Read and propose; scratch writes only'}</dd><dt>Read-only folders</dt><dd>{grant.references.join(', ') || 'None'}</dd><dt>Network domains</dt><dd>{grant.network === 'public' ? 'Public internet' : grant.domains.join(', ') || 'Off'}</dd><dt>Command credentials</dt><dd>{grant.credentials?.join(', ') || 'None'}</dd><dt>Live sources</dt><dd>{grant.accounts.map(a=>`${a.integration}: ${a.account}`).join(', ') || 'None'}</dd></dl>
{:else}<p>Private task scratch only; network off; no live sources.</p>{/if}
<style>dl { display:grid; grid-template-columns:auto 1fr; gap:var(--sp-2) var(--sp-3); font:var(--type-caption); } dt { color:var(--text-muted); } dd { margin:0; overflow-wrap:anywhere; } p { color:var(--text-muted); }</style>
