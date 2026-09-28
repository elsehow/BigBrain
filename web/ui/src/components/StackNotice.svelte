<script lang="ts">
  import { onMount } from 'svelte';
  import { registerNotice, type StackNotice } from '../lib/notificationStack.svelte';
  let { id, title, kind, children, status, hasInput, onopen, onclear }: StackNotice = $props();
  onMount(() => registerNotice({ id, get title() { return title; }, kind,
    get children() { return children; }, get status() { return status; },
    get hasInput() { return hasInput; }, get onopen() { return onopen; },
    onclear: () => onclear() }));
</script>
