import { vaultFetch as fetch } from "./vaultScope";
export { claudeProviderConnected } from "../../../../lib/providerConnection";
/**
 * setup.ts — what the app knows about its own first run (#575).
 *
 * Three facts decide whether a person is set up: is there a vault, does it
 * know whose it is (#572), and has a Claude Code ever been connected to it.
 * Everything else
 * on the first-run screens (Claude Code installed? signed in? did the
 * folder they named hold something else?) is what the shell found on the
 * way to those two, and it is here so the screen can say the true thing
 * instead of offering a button that will fail.
 *
 * Served by the supervisor as `/api/setup` once the desktop shell has a
 * first-run door; the workbench fabricates it (src/dev/fakeApi.ts) so the
 * states can be looked at before that exists. A viewer with no such route
 * (a headless host, an older engine) gets `null` from `setupStatus()` and
 * renders the app as it always has — the CLI path (`/setup`, `bigbrain
 * init`, `bigbrain connect`) needs nothing from here.
 *
 * The same two pieces of UI serve first run and settings: VaultPicker and
 * ClaudeConnect read this shape, and FirstRun / VaultSettingsView /
 * AgentsView only decide where to put them.
 */

export interface SetupAgent {
  name: string;
  connected: string;
  /** Null until the credential has made its first request. */
  lastUsed: string | null;
  /** Null while live. A revoked record STAYS: it is what tells first run
   * apart from a person who set up months ago and just revoked — the
   * former gets the wizard, the latter gets the agents card. */
  revoked: string | null;
}

export interface PluginStatus {
  shipped: string;
  installed: string | null;
  marketplace: string | null;
  /** Installed at the shipped version, from this engine's directory. */
  current: boolean;
}

/** What a refresh did, on the answer to `refreshPlugin()`. `problem` is the
 * failing command and its output — the one thing the card cannot work out
 * for itself from the state that comes back with it. */
export interface PluginRefresh {
  outcome: "absent" | "current" | "refreshed" | "failed";
  problem?: string;
}

import type { SubscriptionStatus } from "../../../../lib/providerConnection";
export type { SubscriptionStatus, SubscriptionProvider } from "../../../../lib/providerConnection";
export interface SetupState {
  onboarding?:"vault"|"providers"|"integrations"|"clients"|"analytics"|"complete";
  chatgpt?: SubscriptionStatus;
  anthropic?: SubscriptionStatus;
  codex?: { supported?: boolean; installed: string | false; account: string | null; connected: boolean; everConnected?: boolean; plugin: string | null; connectionStage?: "models" | "plugin" | "saving" };
  /** The vault the engine is running against. Null while none has been
   * chosen — the shell is up, answering, and holding the door. */
  vault: { path: string; created: string | null } | null;
  /** Who this vault is about, from the newest declaration in its logs.
   * Null when nobody has said — which is what the name screen is for.
   * Absent from an engine too old to answer, and read as "don't ask". */
  identity?: { name: string; entity_id: string } | null;
  /** The folder the shell would suggest — where the app was pointed at
   * with nothing there. First run's field starts on it. */
  suggested?: string;
  /** What the shell found when it looked at the folder the person named.
   * Set only while nothing has been created: a problem with a folder that
   * IS the vault would be a different screen (the app's own). */
  pick?: { path: string; problem: string };
  /** `installed` is the version string, or false. `account` is who is
   * signed in (from Claude Code's own config) — null when nobody is, or
   * when the shell could see a credential but not a name. */
  claude: {
    connected?: boolean;
    installed: string | false;
    account: string | null;
    /** The `bigbrain` plugin in that Claude Code against the one this
     * engine ships. Absent from an older engine's answer; null while Claude
     * Code is not installed. */
    plugin?: PluginStatus | null;
  };
  /** The credential this machine's Claude Code holds for the vault — the
   * `claude code on <host>` token `bigbrain connect` mints. Null until one
   * has ever existed. */
  agent: SetupAgent | null;
}

/** Set up means a vault, a name for whose it is, and an agent that has
 * existed. Nothing else retires the first-run screens — not a dismissed
 * banner, not a day passing — and nothing brings them back, a revoke
 * included.
 *
 * `identity === undefined` means the engine is older than #572 and cannot
 * answer; that is not the same as "nobody has said", and it must not put a
 * working install back into a wizard. Only an explicit null asks. */
export const vaultSetupDone = (s: SetupState): boolean =>
  s.vault !== null && s.identity !== null && (!!s.claude.connected || s.agent !== null || !!s.chatgpt?.connected || !!s.anthropic?.connected || !!s.codex?.connected || !!s.codex?.everConnected);

export const setupDone = (s:SetupState):boolean => vaultSetupDone(s) && (!s.onboarding || s.onboarding === "complete");

/** Is a Claude Code connected right now? */
export const agentLive = (s: SetupState): boolean => s.agent !== null && s.agent.revoked === null;

/** Which screen a not-done state is on. The name comes before the agent on
 * purpose: connecting Claude Code is what starts the gardener, and the
 * first thing it files should already know whose vault this is. */
export const setupStep = (s: SetupState): 1 | 2 | 3 =>
  !s.vault ? 1 : s.identity === null ? 2 : 3;

/** Total steps for the eyebrow — an engine that cannot answer about
 * identity never shows the name screen, so it must not count it. */
export const setupSteps = (s: SetupState): 2 | 3 => (s.identity === undefined ? 2 : 3);

/** Can the connect button do anything? Claude Code has to be there and
 * signed in, or the plugin install has nothing to install into and the
 * gardener nothing to run as. */
export const claudeReady = (s: SetupState): boolean => !!s.claude.installed && s.claude.account !== null;

/** Is there a plugin update to offer? Something installed, behind what this
 * engine ships (or installed from another tree), and a Claude Code already
 * connected — before that CONNECT is on screen and does the refresh itself,
 * so a second button would be two ways to say one thing. An engine too old
 * to report the plugin (`undefined`) offers nothing. */
export const pluginUpdatable = (s: SetupState): boolean => {
  const p = s.claude.plugin;
  return agentLive(s) && !!p && p.installed !== null && !p.current;
};

/** `null` ⇒ no first-run door here (a headless host, an older engine —
 * the route answers 404): render the app. Throws when the engine did not
 * answer at all — the door handing the port to the engine, a restart —
 * which is NOT the same thing: the caller keeps what it knew, or waits. */
export async function setupStatus(): Promise<SetupState | null> {
  const r = await fetch("/api/setup", { headers: { Accept: "application/json" } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`setup answered ${r.status}`);
  return (await r.json()) as SetupState;
}

/** Create the vault at `path`, or adopt the one already there — `bigbrain
 * init` behind a route. The answer is the next SetupState: either the
 * vault exists now, or `pick` says why not. */
export async function pickVault(path: string): Promise<SetupState> {
  const r = await fetch("/api/setup/vault", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!r.ok) throw new Error(`could not use that folder (${r.status})`);
  return (await r.json()) as SetupState;
}

/** Say who this vault is about. Appends the declaration — the person's own
 * words as an arrival, and one assertion citing it — and answers the next
 * state. The email is the door's business: git and Claude Code already know
 * it. */
export async function declareName(name: string, email?: string): Promise<SetupState> {
  const r = await fetch("/api/setup/identity", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email }),
  });
  if (!r.ok) {
    const problem = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(problem.error ?? `could not save that name (${r.status})`);
  }
  return (await r.json()) as SetupState;
}

/** Install the plugin into this machine's Claude Code and mint its
 * credential — `bigbrain connect` behind a route. */
export async function connectClaude(): Promise<SetupState> {
  const r = await fetch("/api/setup/connect", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error(`could not connect (${r.status})`);
  return (await r.json()) as SetupState;
}

/** Update this machine's Claude Code copy of the plugin to the one this
 * engine ships — the refresh the app runs at launch, on a click, so nobody
 * has to quit the app to get it. The answer is the next SetupState (its
 * `claude.plugin` is the state AFTER the attempt) plus what happened; a
 * refresh that failed comes back 200 with `pluginRefresh.problem`. */
export async function refreshPlugin(): Promise<SetupState & { pluginRefresh?: PluginRefresh }> {
  const r = await fetch("/api/setup/plugin", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error(`could not update the plugin (${r.status})`);
  return (await r.json()) as SetupState & { pluginRefresh?: PluginRefresh };
}

/** A home path, the way a person would type it. */
export const shortPath = (p: string): string =>
  p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");

export async function codexAction(action: "connect" | "plugin" | "login" | "login/cancel"): Promise<any> {
  const r = await fetch(`/api/setup/codex/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `Codex ${action} failed`);
  return data;
}
