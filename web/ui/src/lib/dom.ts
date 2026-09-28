/** Is this event target something the user is typing INTO — an input, a
 * textarea, or a contenteditable region? Every list-navigation keydown
 * handler (SearchTab, TopBar, RecentTab, NoteTab) guards on this so a
 * keystroke meant for a field never doubles as a list command. The four
 * were byte-identical before this consolidation (#265). */
export function editable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/** Is the user typing in a field whose popup listbox — the composer's @
 * mention menu — is open? An open popup owns Escape: the first press
 * dismisses it, and only the next one leaves the conversation. The
 * composer sets aria-controls on its editor exactly while the menu shows. */
export function popupOpen(t: EventTarget | null): boolean {
  return t instanceof Element && t.getAttribute("aria-haspopup") === "listbox" && t.hasAttribute("aria-controls");
}

/** Is this a Mac — where ⌘ is the command modifier and Ctrl is the emacs
 * one every text field honours (Ctrl+K kills to end of line, Ctrl+A goes
 * home…)? Read from the UA the way the shortcuts screen always did; the
 * argument is for tests. */
export function isMac(nav: Pick<Navigator, "platform" | "userAgent"> = navigator): boolean {
  return /Mac/.test(nav.platform || nav.userAgent);
}

/** Keep floating UI out of ancestors that clip or transform fixed elements. */
export function portalToBody(node: HTMLElement) {
  document.body.appendChild(node);
  return { destroy() { node.remove(); } };
}
