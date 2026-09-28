<script lang="ts">
  // Global microphone/keyboard lifecycle. Conversation content lives in the text tab.
  import { app } from "../lib/store.svelte";
  import { onMount } from "svelte";
  import { stage } from "../lib/stage.svelte";
  import { editable } from "../lib/dom";
  import { isTalkKey } from "../lib/pilot";
  import { pilot, pilotPageHide, pilotPress, pilotRefresh, pilotRelease, pilotDismiss, pilotShow, pilotStop, pilotClearContext } from "../lib/pilot.svelte";

  import PilotConversation from "./PilotConversation.svelte";

  const { compact = false }: { compact?: boolean } = $props();

  // On mount and each live ping, refresh whether voice is enabled and configured.
  $effect(() => {
    void app.rev;
    void pilotRefresh();
  });

  onMount(() => {
    const navigation = (e: KeyboardEvent) => {
      if (e.defaultPrevented || stage.pilotsOpen || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const textField = tag === "INPUT" || tag === "TEXTAREA" || !!(e.target as HTMLElement | null)?.isContentEditable;
      if (e.key === "c" && !e.repeat && pilot.open && !textField) {
        e.preventDefault(); e.stopImmediatePropagation(); pilotClearContext(); return;
      }
      if (editable(e.target)) return;
      if (e.key === "p" && !e.repeat && pilot.configured !== false) {
        e.preventDefault(); e.stopImmediatePropagation(); pilotShow();
      } else if (e.key === "Escape" && pilot.open && (compact || pilot.held)) {
        e.preventDefault(); e.stopImmediatePropagation();
        // Escape while Space is held cancels the uncommitted utterance. It
        // must not dismiss Pilot or allow a release to submit the audio.
        if (pilot.held) pilotStop();
        else pilotDismiss();
      }
    };
    window.addEventListener("keydown", navigation, true);
    return () => window.removeEventListener("keydown", navigation, true);
  });
  function onKeyDown(e: KeyboardEvent): void {
    if (!pilot.configured || !isTalkKey(e)) return;
    e.preventDefault();
    void pilotPress();
  }
  function onKeyUp(e: KeyboardEvent): void {
    if (e.code !== "Space" || !pilot.held) return;
    e.preventDefault();
    pilotRelease();
  }
</script>

<svelte:window onkeydown={onKeyDown} onkeyup={onKeyUp} onpointerup={pilotRelease} onpointercancel={pilotRelease} onblur={pilotRelease} onpagehide={pilotPageHide} />

{#if compact && pilot.open}<PilotConversation />{/if}
