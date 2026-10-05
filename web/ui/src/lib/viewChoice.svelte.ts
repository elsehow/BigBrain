// Which view sits on the base (components/Base.svelte): Field (the v2 view)
// or Classic (the app shell with the sidebar). A per-device preference, set in
// Settings → General; `?view=` in the address overrides it for that window
// (Field's "Open in app" links reach Classic that way).

export type ViewKind = "field" | "classic";
const KEY = "bb:view";
const isKind = (v: unknown): v is ViewKind => v === "field" || v === "classic";

function stored(): ViewKind {
  try { const v = localStorage.getItem(KEY); if (isKind(v)) return v; } catch { /* storage may be blocked */ }
  return "field";
}
const forced = (() => { try { const v = new URL(location.href).searchParams.get("view"); return isKind(v) ? v : null; } catch { return null; } })();

export const viewChoice = $state<{ kind: ViewKind; saved: ViewKind }>({ kind: forced ?? stored(), saved: stored() });

/** Choose the view for this device, and show it now. */
export function chooseView(kind: ViewKind): void {
  viewChoice.kind = viewChoice.saved = kind;
  try { localStorage.setItem(KEY, kind); } catch { /* the choice still holds for this window */ }
}
