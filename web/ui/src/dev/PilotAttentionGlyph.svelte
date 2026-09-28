<script lang="ts">
  import Glyph from "../components/PilotAttentionGlyph.svelte";
  let { state = "idle", size = 32, pulse = true }: { state?: "waiting" | "running" | "idle"; size?: number; pulse?: boolean } = $props();
</script>
<Glyph {state} {size} {pulse} />
