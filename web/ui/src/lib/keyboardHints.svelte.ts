const KEY = "bigbrain.show-keyboard-hints";
function stored(): boolean {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
}

export const keyboardHints = $state({ show: stored() });
export function setKeyboardHints(show: boolean): void {
  keyboardHints.show = show;
  try { localStorage.setItem(KEY, show ? "on" : "off"); } catch { /* Keep the choice for this window. */ }
}
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key === KEY || event.key === null) keyboardHints.show = stored();
});
