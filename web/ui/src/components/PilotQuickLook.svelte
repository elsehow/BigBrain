<script lang="ts">
  import { untrack } from 'svelte';
  import { chatSessions, loadChatDetail } from '../lib/pilotChat.svelte';
  import { pilotRoster } from '../lib/pilotAttention';
  import { mentionText, parseMentions } from '../../../../lib/pilotMentions';
  import type { GraphData } from '../lib/types';
  let { id, graph }: { id: string; graph: GraphData | null } = $props();
  const session = $derived(chatSessions().find(s => s.id === id));
  const entry = $derived(pilotRoster(session ? [session] : [])[0]);
  const text = $derived(session ? entry?.preview || session.live || (session.phase === 'draft' ? mentionText(parseMentions(session.draft)) : '')
    || session.messages?.findLast(m => m.role === 'assistant')?.text || session.messages?.at(-1)?.text || '' : '');
  const connections = $derived((session?.context ?? []).map(key => graph?.nodes.find(n => n.id === key || n.path === key)?.title ?? key));
  let loading = $state(false);
  let error = $state('');
  $effect(() => {
    const selected = id;
    let cancelled = false;
    loading = true; error = '';
    untrack(() => void loadChatDetail(selected).catch(() => {
      if (!cancelled) error = 'Could not load this conversation.';
    }).finally(() => { if (!cancelled) loading = false; }));
    return () => { cancelled = true; };
  });
</script>
<header class="hud-header"><h1 class="note-title">{entry?.title ?? session?.title ?? 'Agent'}</h1></header>
<div class="agent-preview">
  {#if text}<p class="preview-text">{text}</p>
  {:else}<p class="empty">{loading ? 'Loading conversation…' : error || 'No messages yet.'}</p>{/if}
  {#if connections.length}<p class="connections">Attached to {connections.join(" · ")}</p>{/if}
</div>
<style>
  .note-title { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; line-clamp:2; overflow:hidden; margin:0; font:600 16px/1.4 var(--font-app); }
  .agent-preview { padding:12px 20px; font:var(--type-body); color:var(--text-strong); }
  p { margin:0; }
  .preview-text { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:3; line-clamp:3; overflow:hidden; white-space:normal; overflow-wrap:anywhere; line-height:1.5; }
  .empty, .connections { color:var(--text-muted); }
  .connections { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:10px; font:var(--type-meta); }
</style>
