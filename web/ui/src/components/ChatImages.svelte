<script lang="ts">
  import { chatImageUrl, type ChatImage } from "../../../../lib/chatImageTypes";
  let { images, remove }: { images: ChatImage[]; remove?: (index: number) => void } = $props();
</script>
{#if images.length}
  <div class="chat-images" aria-label={remove ? "Attached images" : "Message images"}>
    {#each images as image, index}
      <div class="attachment"><a href={chatImageUrl(image)} target="_blank" rel="noreferrer"><img src={chatImageUrl(image)} alt={image.name} /></a>
        {#if remove}<button type="button" aria-label={`Remove image ${index + 1}`} onclick={() => remove?.(index)}>×</button>{/if}
      </div>
    {/each}
  </div>
{/if}
<style>
  .chat-images { display: flex; flex-wrap: wrap; gap: 10px; padding: 10px 0; grid-column: 2; }
  .attachment { position: relative; } img { display: block; width: 150px; height: 100px; object-fit: contain; border-radius: 8px; border: 1px solid var(--rule); }
  button { position: absolute; top: 4px; right: 4px; border: 1px solid var(--rule); border-radius: 50%; background: var(--bg); color: var(--text-strong); cursor: pointer; width: 24px; height: 24px; }
</style>
