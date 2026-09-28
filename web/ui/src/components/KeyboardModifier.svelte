<script lang="ts">
  let { name }: { name: 'shift' | 'option' } = $props();
</script>
<span class="modifier" aria-label={name === 'shift' ? 'Shift' : 'Option'}>{name === 'shift' ? '⇧' : '⌥'}</span>
<style>
  /* The mono face has tiny modifier glyphs. Use the platform UI face at
     an optical size that matches the adjacent key's cap height. */
  .modifier {
    display:inline-block; font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Apple Symbols",sans-serif;
    font-size:1.35em; font-weight:500; line-height:1; letter-spacing:0;
    vertical-align:-.08em; margin-right:.12em;
  }
</style>
