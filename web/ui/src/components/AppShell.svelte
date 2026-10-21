<script lang="ts">
  import { setContext, untrack } from "svelte";
  import Base from "./Base.svelte";
  import { SOURCE_STUDY, type SourceStudy } from "../lib/sourceStudy";

  // The same production base in the app and the workbench. Optional study
  // content is supplied only by the fabricated-vault entry point.
  let { sourceStudy }: { sourceStudy?: SourceStudy } = $props();
  setContext(SOURCE_STUDY, untrack(() => sourceStudy));
</script>

<Base />
