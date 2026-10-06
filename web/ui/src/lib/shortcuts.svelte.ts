/**
 * shortcuts.svelte.ts — the one keyboard: every shortcut the app answers is
 * registered here, by the component that answers it, for as long as it is
 * mounted.
 *
 * A component calls `registerShortcuts(scope)` on mount and the returned
 * function on destroy; one window listener dispatches to whatever is
 * registered. The `?` sheet and every on-screen key chip read the same
 * registry, so nothing can list a key nobody handles, or handle one nobody
 * lists — the failure #129 found, where a stack's keys died with the
 * dispatcher it relied on while its chips kept advertising them.
 * test/shortcutGuard.test.ts keeps components from reading keys any other
 * way; shortcutKeys.ts is the arithmetic.
 */
import { untrack } from "svelte";
import { dispatch, keyLabel, shortcutGroups as groupsOf, type Scope } from "./shortcutKeys";
export { keyLabel, RANK, type Binding, type Scope, type Shortcut } from "./shortcutKeys";

let scopes = $state.raw<Scope[]>([]);

export function registerShortcuts(scope: Scope): () => void {
  // untracked: a caller's $effect must not come to depend on the list it adds to
  return untrack(() => {
    scopes = [...scopes, scope];
    if (scopes.length === 1) window.addEventListener("keydown", onWindowKey);
    return () => untrack(() => {
      scopes = scopes.filter((s) => s !== scope);
      if (!scopes.length) window.removeEventListener("keydown", onWindowKey);
    });
  });
}

function onWindowKey(e: KeyboardEvent): void { dispatch(e, scopes); }

/** The first way to press a registered shortcut, as it reads — or "" when
 * nothing mounted answers it, so a chip for a dead key draws nothing. */
export function keyText(id: string): string {
  for (const s of scopes) for (const sc of s.shortcuts) if (sc.id === id) return keyLabel(sc.keys[0]!);
  return "";
}

/** What the ? sheet lists: everything registered now. */
export const shortcutGroups = () => groupsOf(scopes);
