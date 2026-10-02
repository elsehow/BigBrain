<script lang="ts">
  import StackNotice from './StackNotice.svelte';
  import { mentionText, parseMentions } from '../../../../lib/pilotMentions';
  import { stackedNotifications, changeNotification, openNotification } from '../lib/notifications.svelte';
  const items = $derived(stackedNotifications());
</script>
{#each items as item (item.id)}
  <StackNotice id={`agent:${item.id}`} title={item.pilotTitle} kind="agent" onopen={() => openNotification(item.id)} onclear={() => changeNotification(item.id, 'dismiss')}>
    <p role="status">{mentionText(parseMentions(item.text))}</p>
  </StackNotice>
{/each}
<style>
  p { margin:0; font:var(--type-body); overflow-wrap:anywhere; }
</style>
