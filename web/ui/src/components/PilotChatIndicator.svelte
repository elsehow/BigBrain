<script lang="ts">
  import type { PilotVisualPhase } from "../lib/pilotAppearance";
  import NodeIndicator from "./NodeIndicator.svelte";
  const { phase }: { phase: PilotVisualPhase } = $props();
</script>
<NodeIndicator state={phase} size={28} />
