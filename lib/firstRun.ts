import { modelRecommendations } from "./modelRecommendations";
import { modelPreferences, setModelPreference } from "./modelPreferenceRefresh";
import { setupProgress, saveSetupProgress, type SetupProgress } from "./setupProgress";
import { mcpServerEntry } from "./mcpRegister";
import { curationModels, type ModelSources } from "./modelCatalog";
import { loadManifest } from "./manifest";
import { subscriptionConnections, type SubscriptionStatus } from "./subscriptionConnection";
/**
 * firstRun.ts — the desktop app's setup door (#575): what the app knows
 * about its own first run, and the steps that finish it.
 *
 * Two facts decide whether a person is set up — is there a vault, and has
 * a subscription been connected — and this module answers them
 * as one `SetupState` (the shape web/ui/src/lib/setup.ts reads; keep the
 * two in step). Everything else in the state is what the shell found on
 * the way: is Claude Code installed, signed in as whom, and what the
 * folder the person named turned out to hold.
 *
 * Served two ways, by design:
 *
 *   - bin/desktop.ts, with NO vault: a door on the web port that serves the
 *     viewer and these routes, so the app can open on a machine that has
 *     nothing yet instead of dying at import. `createVault` is what its
 *     POST does; the door then hands the port to the real engine.
 *   - web/server.ts, with a vault, under the app (BIGBRAIN_DESKTOP): the
 *     same GET, `connectMachine` for the agents card, `createVault` +
 *     the pointer for a switch from settings.
 *
 * An engine run from the CLI with no app (`bun bin/desktop.ts`, or the
 * scripts by hand) gets none of this: there the CLI is the door (`bigbrain
 * init`, `bigbrain connect`), and the viewer's cards say so. So this module
 * must import nothing that
 * needs a vault at import time — no manifest, no remote, no preflight's
 * VAULT_ROOT — because the first caller has none.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { listTokens, tokenStorePath } from "./auth";
import { connectTokenName } from "./connect";
import type { PluginStatus } from "./pluginState";
import { ENGINE_ROOT, vaultPointer } from "./engine";
import { writeAtomic } from "./fsx";
import { jobsPath } from "./preflight";
import { declareUserIdentity, latestUserIdentity, legacyUserLabels } from "./userIdentity";
import { json, readBody, type Route } from "./httpx";
import type { ServerResponse } from "node:http";

export interface SetupAgent {
  name: string;
  connected: string;
  lastUsed: string | null;
  /** Null while live. A revoked record STAYS in the state: it is what
   * tells first run apart from a person who set up months ago and just
   * revoked — the former gets the wizard, the latter the agents card. */
  revoked: string | null;
}

export interface SetupState {
  onboarding?: SetupProgress;
  chatgpt?: SubscriptionStatus;
  anthropic?: SubscriptionStatus;
  codex?: { installed: string | false; supported?: boolean; account: string | null; connected: boolean; everConnected?: boolean; plugin: string | null };
  vault: { path: string; created: string | null } | null;
  /** Who this vault is about, from the newest identity declaration in its
   * logs (#572). Null when nobody has said — the state a new vault is in,
   * and the one first run's name screen exists to leave. */
  identity: { name: string; entity_id: string } | null;
  /** The folder the shell would suggest — where the app was pointed at
   * (BIGBRAIN_VAULT, or the shell's ~/vault default) with nothing there. */
  suggested?: string;
  /** The verdict on a folder the person named, pinned to that path. */
  pick?: { path: string; problem: string };
  claude: {
    connected?: boolean;
    installed: string | false;
    account: string | null;
    /** The `bigbrain` plugin in that Claude Code against the one this
     * engine ships — null while Claude Code is not installed. */
    plugin: PluginStatus | null;
  };
  agent: SetupAgent | null;
}

// ── Claude Code on this machine ─────────────────────────────────────────────

/** Who Claude Code is signed in as, from its own config (`~/.claude.json`
 * → oauthAccount.emailAddress). Null when the file or the field is absent —
 * a subscription login writes it; an API-key setup does not. */
export function claudeAccount(home: string = homedir()): string | null {
  try {
    const cfg = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
      oauthAccount?: { emailAddress?: unknown };
    };
    const email = cfg.oauthAccount?.emailAddress;
    return typeof email === "string" && email.trim() ? email.trim() : null;
  } catch {
    return null;
  }
}

export function expandPath(p: string, home: string = homedir()): string {
  const t = p.trim();
  if (t === "~") return home;
  if (t.startsWith("~/")) return join(home, t.slice(2));
  return isAbsolute(t) ? resolve(t) : resolve(home, t);
}

export type FolderVerdict =
  | { ok: true; path: string; kind: "new" | "empty" | "vault" }
  | { ok: false; path: string; problem: string };

/** What a folder the person named would become. Missing → created; empty →
 * a new vault; holds vault.yaml → adopted as it is. Anything else is
 * reported, not fixed: a `git init` over somebody's existing notes folder,
 * or over their home directory, is the one thing first run must never do. */
export function inspectFolder(raw: string, home: string = homedir(), engineRoot: string = ENGINE_ROOT): FolderVerdict {
  const path = expandPath(raw, home);
  const shown = raw.trim();
  if (path === resolve(home)) return { ok: false, path, problem: `${shown} is your home folder — pick a folder inside it.` };
  if (path === resolve(engineRoot))
    return { ok: false, path, problem: `${shown} is the BigBrain engine, not a place for notes — pick another folder.` };
  if (!existsSync(path)) return { ok: true, path, kind: "new" };
  if (!statSync(path).isDirectory()) return { ok: false, path, problem: `${shown} is a file, not a folder.` };
  if (existsSync(join(path, "vault.yaml"))) return { ok: true, path, kind: "vault" };
  const entries = readdirSync(path).filter((e) => e !== ".DS_Store");
  if (entries.length === 0) return { ok: true, path, kind: "empty" };
  return { ok: false, path, problem: `${shown} is not a valid vault — pick an empty folder or an existing BigBrain vault.` };
}

// ── the vault and its agent ──────────────────────────────────────────────────

/** When the vault was made — init stamps `.state/init.json`. Null for a
 * vault made some other way. */
export function vaultCreated(root: string): string | null {
  try {
    const at = (JSON.parse(readFileSync(join(root, ".state", "init.json"), "utf8")) as { at?: unknown }).at;
    return typeof at === "string" ? at : null;
  } catch {
    return null;
  }
}

/** This machine's Claude Code credential, from the vault's token store:
 * the newest `claude code on <host>` record `bigbrain connect` (or the
 * app) minted, revoked or not. Null when none has ever existed. */
export function agentStatus(root: string, storePath: string = tokenStorePath(root), machine?: string): SetupAgent | null {
  const name = connectTokenName(machine);
  const mine = listTokens(storePath).filter((t) => t.via === "connect" && t.name === name);
  if (!mine.length) return null;
  mine.sort((a, b) => (a.created < b.created ? 1 : -1));
  const live = mine.find((t) => !t.revoked) ?? mine[0]!;
  return { name: live.name, connected: live.created, lastUsed: live.last_used, revoked: live.revoked };
}

/** The whole state. `root` null ⇒ no vault yet (the door). */
export function setupState(root: string | null, opts: { suggested?: string; pick?: SetupState["pick"] } = {}): SetupState {
  return {
    vault: root ? { path: root, created: vaultCreated(root) } : null,
    ...(root ? { onboarding: setupProgress(root) } : {}),
    identity: root ? identityOf(root) : null,
    ...(root ? {} : opts.suggested ? { suggested: opts.suggested } : {}),
    ...(opts.pick ? { pick: opts.pick } : {}),
    claude: { installed: false, account: null, plugin: null, connected: false },
    chatgpt: root ? subscriptionConnections.chatgpt.status(root) : { connected: false, phase: "idle" },
    anthropic: root ? subscriptionConnections.anthropic.status(root) : { connected: false, phase: "idle" },
    agent: root ? agentStatus(root) : null,
  };
}

// ── the two acts ─────────────────────────────────────────────────────────────

/** `bigbrain init` for the app: a host vault, `auth: max` (the gardener is
 * Pi after the person connects a subscription), no scheduler jobs (the app IS the scheduler),
 * and Claude Code NOT required yet — it is step 2. Does NOT claim the
 * machine's default-vault pointer unless the machine has none — init stopped
 * retargeting silently in #604 — so a caller that IS the person choosing
 * (the setup door) calls `pointAt` itself. Throws with init's own reason
 * when it refuses. */
export function createVault(path: string, engineRoot: string = ENGINE_ROOT): string {
  // Authentication is the next setup step. Init's optional inference probe
  // and its normal credential preflight are separate; neither should block
  // creation of an empty vault before a provider has been chosen.
  const spec = { auth: "max", install: false };
  const r = spawnSync(process.execPath, [join(engineRoot, "bin", "init.ts"), "--json"], {
    input: JSON.stringify(spec),
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, BIGBRAIN_VAULT: path, PATH: jobsPath() },
  });
  const line = (r.stdout ?? "").trim().split("\n").filter(Boolean).at(-1) ?? "";
  let result: { ok?: boolean; error?: string } = {};
  try {
    result = JSON.parse(line) as typeof result;
  } catch {
    /* no JSON — init died before reporting */
  }
  if (!result.ok) {
    const why = result.error ?? (r.stderr ?? "").trim().split("\n").at(-1) ?? `init exited ${r.status}`;
    throw new Error(why);
  }
  saveSetupProgress(path, "vault");
  return path;
}

/** Point the machine at a vault: what `bigbrain init` does last. The app
 * reads it on the next launch (desktop/src-tauri/src/lib.rs vault_root). */
export function pointAt(root: string): void {
  writeAtomic(vaultPointer(), root + "\n");
}

/** Whose delegate this machine's Claude Code is. The account Claude Code is
 * signed in as is the truest answer; the vault's git identity next; and a
 * machine with neither still gets a name, because an agent token must have
 * an owner. */
export function ownerFor(root: string, claudeEmail: string | null): string {
  if (claudeEmail) return claudeEmail;
  const r = spawnSync("git", ["config", "user.email"], { cwd: root, encoding: "utf8", timeout: 10_000 });
  const git = (r.stdout ?? "").trim();
  if (r.status === 0 && git) return git;
  return `${userInfo().username}@${hostname()}`;
}

// ── the door, as routes ──────────────────────────────────────────────────────

/** How one mount of the setup door differs from the other. Everything else
 * — the four routes, their refusals, the body cap, the order of inspect →
 * create → point — is the same act in both places, and used to be written
 * twice with answers that had drifted apart (#639). */
export interface SetupDoor {
  modelSources?: ModelSources;
  /** The vault these routes speak for. `null` is bin/desktop.ts's door,
   * open before a vault exists: connecting a machine has nothing to
   * connect TO, so that route refuses. */
  root: string | null;
  /** The state to answer with, recomputed per request because a route may
   * have just changed it. Each mount owns what it carries: the door opens
   * holding the verdict of an engine start that failed, the viewer holds
   * nothing. */
  state: () => SetupState;
  /** A folder just became this machine's vault. The door closes and lets
   * the engine come up on it; the viewer asks the supervisor to restart
   * onto it. Called AFTER the reply is sent, so the caller may take the
   * port away. */
  onVault: (verdict: Extract<FolderVerdict, { ok: true }>) => void;
  /** The person just named a folder. The door opens carrying a verdict
   * from an engine start that failed, shown under the rows — and any
   * choice makes that stale, whatever this one turns out to be. Neither
   * mount remembers a FRESH refusal: it rides the reply and is gone. */
  onChoice?: () => void;
  /** The intake API a connected machine is pointed at. Unused at the door,
   * which cannot connect anything. */
  apiBase?: string;
  engineRoot?: string;
}

/** web/ui/src/lib/errText, spelled out. This module's header is a list of
 * things it must not import, and the viewer's own tree — which lib/ has
 * never reached into — is a worse precedent than one expression. */
const problemText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The vault's own answer to "who is this about", or null. Reads the logs,
 * never `.state/` — and cheaply on a vault with no declaration, which is
 * every vault this matters for (lib/userIdentity.ts). A vault whose logs
 * cannot be read is not a crash here: the setup door must answer even when
 * the record is mid-write. */
export function identityOf(root: string): SetupState["identity"] {
  try {
    const me = latestUserIdentity(root);
    return me ? { name: me.name, entity_id: me.entity_id } : null;
  } catch {
    return null;
  }
}

/** The email the doors offer as the owner's, in the order a local machine
 * actually knows it: what the vault's own git says, then who Claude Code is
 * signed in as. Both are the person's own machine talking about itself —
 * asserted, not verified, which is the grade a local declaration carries. */
export function suggestedOwnerEmail(root: string, home: string = homedir()): string | null {
  const git = spawnSync("git", ["config", "user.email"], { cwd: root, encoding: "utf8" });
  const fromGit = git.status === 0 ? (git.stdout ?? "").trim() : "";
  return fromGit || claudeAccount(home);
}

export function setupRoutes(door: SetupDoor): Route[] {
  // A folder that cannot become a vault is not an error: the card shows
  // the reason under the rows and the person picks again. The verdict
  // rides this one reply — it is not part of the state.
  const refusePick = (res: ServerResponse, pick: NonNullable<SetupState["pick"]>): void =>
    json(res, 200, { ...door.state(), pick });

  return [
    { method: "GET", path: "/api/setup/mcp", handler: ({ res }) => {
      if (!door.root) return json(res, 409, { error: "Choose a vault first." });
      const entry=mcpServerEntry(door.root);entry.args.push("--connection","local-config");
      return json(res, 200, { mcpServers: { bigbrain: entry } });
    } },
    ...Object.entries(subscriptionConnections).flatMap(([provider, connection]): Route[] => [
    { method: "GET", path: `/api/setup/${provider}`, handler: ({ res }) => {
      if (!door.root) return json(res, 409, { error: "Choose a vault first." });
      return json(res, 200, connection.status(door.root));
    } },
    { method: "POST", path: `/api/setup/${provider}/login`, handler: ({ res }) => {
      if (!door.root) return json(res, 409, { error: "Choose a vault first." });
      try { return json(res, 200, connection.start(door.root)); }
      catch (e) { return json(res, 409, { error: problemText(e) }); }
    } },
    { method: "POST", path: `/api/setup/${provider}/cancel`, handler: async ({ res }) => {
      if (!door.root) return json(res, 409, { error: "Choose a vault first." });
      await connection.cancel(door.root);
      return json(res, 200, connection.status(door.root));
    } },
    { method: "POST", path: `/api/setup/${provider}/callback`, handler: async ({ req, res }) => {
      if (!door.root) return json(res, 409, { error: "Choose a vault first." });
      try {
        const body = JSON.parse(await readBody(req, 8192));
        if (typeof body.url !== "string") throw new Error("Paste the complete callback URL from your browser.");
        connection.answer(door.root, body.url);
        return json(res, 200, connection.status(door.root));
      } catch { return json(res, 400, { error: "Could not accept that callback. Paste the complete URL from your browser or restart sign-in." }); }
    } },
    ]),
    { method: "GET", path: "/api/agents/models", handler: async ({ res }) => {
      const agents = await curationModels(door.state(), door.modelSources);
      return json(res, 200, { agents, recommendations: modelRecommendations(agents, door.root ? loadManifest(door.root).auth : "max"), preferences: door.root ? modelPreferences(door.root) : {} });
    } },
    { method: "POST", path: "/api/models/preference", handler: async ({ req, res }) => {
      if (!door.root) return json(res, 409, { error: "Choose a vault first." });
      try {
        const body = JSON.parse(await readBody(req, 8192));
        const catalog = body.preference === "recommended" ? await curationModels(door.state(), door.modelSources) : [];
        setModelPreference(door.root, body.role, body.preference, catalog);
        return json(res, 200, { preferences: modelPreferences(door.root) });
      } catch (error) { return json(res, 400, { error: problemText(error) }); }
    } },
    ...["codex/login", "codex/login/cancel", "codex/plugin", "codex/connect", "connect", "plugin"].map(path => ({ method: "POST", path: `/api/setup/${path}`, handler: ({res}: Parameters<Route["handler"]>[0]) => json(res, 410, {error:"Native setup is retired. Connect a subscription in Models, or add an external client in Connected Clients."}) } as Route)),
    { method: "GET", path: "/api/setup", handler: ({ res }) => json(res, 200, door.state()) },
    { method: "POST", path: "/api/setup/progress", handler: async ({ req, res }) => {
      if (!door.root) return json(res, 409, { error: "Choose a vault first." });
      try {
        const body = JSON.parse(await readBody(req));
        if (!["vault", "providers", "integrations", "clients", "analytics", "complete"].includes(body.step)) throw Error("Choose a setup step.");
        const state = door.state();
        if (body.step !== "vault" && !state.identity) throw Error("Set your name first.");
        if (["clients", "integrations", "analytics", "complete"].includes(body.step) && !(state.chatgpt?.connected || state.anthropic?.connected)) throw Error("Connect a provider first.");
        saveSetupProgress(door.root, body.step);
        return json(res, 200, door.state());
      } catch (e) { return json(res, 400, { error: problemText(e) }); }
    } },

    // The name screen (#572). A vault that cannot say who it is about
    // makes its gardener work blind: the tend prompt is handed "No
    // vault-owner identity labels were supplied", the graph draws the self
    // node it exists to hide, and the memory pass re-derives the person
    // from the record every run. So first run asks, once, before anything
    // is added — and this writes the declaration the readers already know
    // how to find. The email is not asked for: git and Claude Code already
    // know it, and a wrong one costs an alias, not a name.
    {
      method: "POST",
      path: "/api/setup/identity",
      handler: async ({ req, res }) => {
        const root = door.root;
        if (root === null) return json(res, 409, { error: "no vault yet — choose a folder first" });
        // readBody hands back the raw string; until 0.1.17 this line read
        // `.name` off it, so every name — typed or not — was "required".
        let body: { name?: unknown; email?: unknown } = {};
        try {
          body = JSON.parse(await readBody(req, 4096)) as typeof body;
        } catch {
          // not JSON: no name in it
        }
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) return json(res, 400, { error: "a name is required" });
        const email = typeof body.email === "string" && body.email.trim()
          ? body.email.trim()
          : suggestedOwnerEmail(root);
        if (!email)
          return json(res, 409, {
            error: "no email found on this machine — enter your email below to attribute this vault to you",
          });
        try {
          // A hosted-era vault's `human_user` dossier rides along (#683):
          // its aliases join the declaration, so nothing it said is lost.
          declareUserIdentity(root, { name, email, aliases: legacyUserLabels(root) });
        } catch (error) {
          return json(res, 400, { error: problemText(error) });
        }
        return json(res, 200, door.state());
      },
    },

    // First run's step 1, and the same act from settings against a
    // different folder: inspect what the person named, create a vault there
    // if it is not one already, and make it this machine's. The pointer
    // moves BEFORE the reply, and whatever has to happen to the port
    // happens after it (onVault) — this is the last thing either server
    // says on the old vault.
    {
      method: "POST",
      path: "/api/setup/vault",
      handler: ({ req, res }) => {
        void (async () => {
          let asked = "";
          try {
            const body = JSON.parse(await readBody(req, 4096)) as { path?: unknown };
            if (typeof body.path !== "string" || !body.path.trim())
              return json(res, 400, { error: "path is required" });
            asked = body.path;
            door.onChoice?.();
            const v = inspectFolder(asked);
            if (!v.ok) return refusePick(res, { path: asked, problem: v.problem });
            if (v.kind !== "vault") createVault(v.path);
            // The person picked this one, so the machine opens it from now
            // on — including when they ADOPTED an existing vault, which
            // creates nothing and so wrote no pointer. Without this the
            // door reopens on every launch (#604).
            pointAt(v.path);
            json(res, 200, setupState(v.path));
            door.onVault(v);
          } catch (error) {
            refusePick(res, { path: asked, problem: problemText(error) });
          }
        })();
      },
    },
  ];
}
