// Which view sits on the base (components/Base.svelte): Field (the v2 view),
// always. Classic (the app shell with the sidebar) is no longer offered in
// Settings; `?view=classic` in the address still reaches it for that window,
// which is how Field opens what it doesn't draw — a note's page, an older
// pilot's conversation.

export type ViewKind = "field" | "classic";
const isKind = (v: unknown): v is ViewKind => v === "field" || v === "classic";

export const viewKind: ViewKind = (() => {
  try { const v = new URL(location.href).searchParams.get("view"); return isKind(v) ? v : "field"; } catch { return "field"; }
})();
