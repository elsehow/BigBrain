/**
 * tooltip.ts — `use:tooltip={"text"}`, the app's one tooltip idiom: tippy.js
 * under a theme driven by the same CSS variables as everything else, near-
 * instant instead of the ~1s native `title` delay. Pass undefined/"" to
 * disable; the action tracks updates, so dynamic strings just work.
 * The `stier` theme lives in app.css (tippy portals to <body>, so the
 * styling must be global).
 *
 * The ONLY one, since 2026-09-06: every hover hint in the viewer is this
 * action. Until then half the chrome still wore native `title`s — the
 * gear and the X beside a tippy on the mode button — and the OS's own box
 * next to tippy's read as two apps (Nick: "one, app-wide tooltip lib
 * please"). An icon-only button keeps an aria-label beside the tooltip:
 * tippy describes, it does not name.
 */

import tippy, { type Instance } from "tippy.js";
import "tippy.js/dist/tippy.css";
import type { Action } from "svelte/action";

export const tooltip: Action<HTMLElement, string | undefined> = (node, text) => {
  const t: Instance = tippy(node, {
    content: text ?? "",
    theme: "stier",
    delay: [80, 0],
    duration: [120, 90],
    offset: [0, 8],
    maxWidth: 300,
  });
  const sync = (v?: string): void => {
    if (v) {
      t.setContent(v);
      t.enable();
    } else t.disable();
  };
  sync(text);
  return { update: sync, destroy: () => t.destroy() };
};
