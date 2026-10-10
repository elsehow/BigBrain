// Someone who joined a server and went straight to its notes, with nothing yet
// to run the gardener (lib/setupProgress.ts `reader`, D5). FirstRunGate keeps
// this current; what adds to the vault asks for a provider first.
import { vaultFetch as fetch } from "./vaultScope";
import { app } from "./store.svelte";

export const reader = $state({ on: false, named: true });

/** They tried to add something: the regular setup flow, from its providers
 * screen, or from its first screen when the vault has no name yet. */
export async function askForProvider(): Promise<void> {
  await fetch("/api/setup/progress", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ step: reader.named ? "providers" : "vault" }) });
  app.rev++;
}
