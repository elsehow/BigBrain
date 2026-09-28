<script lang="ts">
  import NodeIndicator from "../components/NodeIndicator.svelte";
  import type { ComponentProps } from "svelte";
  const props: ComponentProps<typeof NodeIndicator> = $props();
</script>
<NodeIndicator {...props} />
