<script lang="ts">
  // A rule as written, its @mentions marked.
  import { parseMentions } from "../../../../lib/pilotMentions";
  let { text }: { text: string } = $props();
</script>
{#each parseMentions(text) as part}{#if "text" in part}{part.text}{:else}<span class="mention">@{part.mention.title}</span>{/if}{/each}
<style>.mention { border-bottom: 1px solid var(--rule); color: var(--text-strong); }</style>
