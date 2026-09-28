<script lang="ts">
  const { label = "Loading" }: { label?: string } = $props();
</script>
<span class="loading-spinner" role="status" aria-label={label}></span>
<style>
  .loading-spinner { display: inline-block; flex: none; width: 14px; height: 14px;
    box-sizing: border-box; border: 1.5px solid var(--rule); border-top-color: var(--text-muted);
    border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .loading-spinner { animation: none; } }
</style>
