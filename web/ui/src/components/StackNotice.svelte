<script lang="ts">
  import { onMount } from 'svelte';
  import { registerNotice, type StackNotice } from '../lib/notificationStack.svelte';
  let { id, title, kind, children, status, hasInput, action, onclear }: StackNotice = $props();
  onMount(() => registerNotice({ id, get title() { return title; }, kind,
    get children() { return children; }, get status() { return status; },
    get hasInput() { return hasInput; }, get action() { return action; },
    onclear: () => onclear() }));
</script>
