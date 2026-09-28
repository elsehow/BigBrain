// The home screen's chrome, and whether it is up.
//
// At rest the home screen is the graph and nothing else (Nick, 2026-09-05:
// "there is ONLY the maximized view … even the search bar could be hidden
// … that makes it look JUST like the gemini image"). The chrome — the bar,
// the recent list — is up ALL TOGETHER or not at all
// (Nick: "the WHOLE UI is activated or NONE of it is"): for ⌘K or a focused
// field, for a pointer at the top edge, on the bar, at the
// bottom edge or on the list (`peek`, HomeView's pointer rule), and HELD
// up by j/k, a click in the list or a focused row until Escape or a click
// on the graph. HomeView drives the pointer and the hold, TopBar the focus;
// both read the one answer. Off the home view the bar is simply up.
//
// Window sizing belongs to the desktop shell; chrome always uses these reveal rules.
import { app } from "./store.svelte";

export const stage = $state({
  sessionOpen: false,
  pilotsOpen: false,
  pilotPreviewId: null as string | null,
  /** the omnibox has focus (TopBar) */
  searchFocused: false,
  /** held up until Escape or a click on the graph */
  held: false,
  /** the pointer is where the chrome is, or would be (HomeView) */
  peek: false,
});

/** Reveal the chrome when the pointer or keyboard asks for it. */
export const chromeUp = (): boolean => stage.pilotsOpen || stage.searchFocused || stage.held || stage.peek;
/** The bar is up: always, off the home view. */
export const barUp = (): boolean => stage.sessionOpen || !!app.activeNote || !["home", "top", "graph"].includes(app.view) || chromeUp();
export function hold(): void { stage.held = true; }
export function release(): void { stage.held = false; }
