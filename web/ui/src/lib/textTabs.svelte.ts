import { app, goto } from "./store.svelte";
import { hold } from "./stage.svelte";

/** Closing the selection leaves the graph overview and its top bar. */
export function closeNoteTab(): void {
  app.noteTab = null;
  goto("home");
  hold();
}
