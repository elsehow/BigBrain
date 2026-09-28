/**
 * connect.ts — `bigbrain connect`: wire THIS machine's Claude Code to the
 * vault it hosts (#487). The self-host twin of the hosted connect card
 * (control/connect.ts, retired — tag hosted-multitenant-final): the plugin needs ONE credential in the client
 * store, keyed by the API base it should talk to, and a self-hosted
 * machine had no way to get one — the plugin only ever shipped inside the
 * hosted installer script.
 *
 * What one connect does, in order:
 *
 * 1. Supersede: revoke every live token already named for this machine
 *    (`claude code on <hostname>`), so reconnecting never leaves an old
 *    credential live (#303's rule, same as the hosted redeem).
 * 2. Mint an agent-kind token — the owner's delegate, so its drops land
 *    `from: claude code` and never as the person — with the connect
 *    scopes, stamped `via: connect` for the agents tab.
 * 3. Save it in the client store under the local API base, which is where
 *    `clients/claude-plugin/scripts/bb.sh` looks. The name keeps the
 *    `claude code` prefix on purpose: bb.sh's tiebreak among several
 *    vaults matches on exactly that prefix.
 *
 * Installing the plugin itself is a shell step (`claude plugin …`) that
 * bin/connect.ts runs; the commands are built here so a test can pin
 * their shape without spawning `claude`.
 */

import { hostname } from "node:os";
import { join } from "node:path";
import {
  clientTokensPath,
  listTokens,
  mintToken,
  revokeToken,
  saveClientToken,
  tokenStorePath,
} from "./auth";

/** The label prefix bb.sh tiebreaks on — identical to the hosted card's. */
export const CONNECT_TOKEN_NAME = "claude code";
/** What the plugin needs: read the vault, drop into it. Never `tend`. */
export const CONNECT_TOKEN_SCOPES = ["inbox:write", "vault:read"] as const;
/** bin/api.ts's default bind — the base a same-machine plugin talks to. */
export const LOCAL_API_BASE = "http://127.0.0.1:4748";

/** The machine half of a per-machine credential name — the hostname,
 * sanitized the same way everywhere (the hosted card used this exact
 * form, so a machine that connected both ways carried one name in both
 * stores). Empty when the hostname sanitizes to nothing. */
export function machineLabel(machine: string = hostname()): string {
  return machine
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 40);
}

/** `claude code on <machine>`. lib/pair.ts names a paired browser the same
 * way (`chrome on <machine>`), so the two cards read alike. */
export function connectTokenName(machine: string = hostname(), agent: "claude" | "codex" = "claude"): string {
  const host = machineLabel(machine);
  const prefix = agent === "codex" ? "codex" : CONNECT_TOKEN_NAME;
  return host ? `${prefix} on ${host}` : prefix;
}

export interface ConnectOptions {
  agent?: "claude" | "codex";
  /** The vault root this machine hosts. */
  root: string;
  /** Whose delegate the token is — required for an agent-kind credential. */
  owner: string;
  /** API base the token is saved under; default the local bind. */
  url?: string;
  /** Machine label; default os.hostname(). */
  machine?: string;
  /** Host-side token store; default tokenStorePath(root). Tests inject. */
  storePath?: string;
  /** Client store; default clientTokensPath(). Tests inject. */
  clientPath?: string;
}

export interface ConnectResult {
  id: string;
  name: string;
  url: string;
  /** The secret — returned ONCE so the caller can verify it against
   * /v1/whoami; never logged, never kept (the store holds its sha256). */
  token: string;
  /** Ids of same-name tokens revoked by this connect. */
  superseded: string[];
}

export function connectLocal(opts: ConnectOptions): ConnectResult {
  const url = (opts.url ?? LOCAL_API_BASE).replace(/\/+$/, "");
  const storePath = opts.storePath ?? tokenStorePath(opts.root);
  const clientPath = opts.clientPath ?? clientTokensPath(opts.agent);
  const name = connectTokenName(opts.machine, opts.agent);

  const superseded = listTokens(storePath)
    .filter((t) => t.name === name && !t.revoked)
    .map((t) => t.id);
  for (const id of superseded) revokeToken(storePath, id);

  const { token, record } = mintToken(storePath, opts.root, name, [...CONNECT_TOKEN_SCOPES], {
    owner: opts.owner,
    kind: "agent",
    via: "connect",
  });
  saveClientToken(url, token, name, clientPath);
  return { id: record.id, name, url, token, superseded };
}

/** The `claude plugin` invocations that install the plugin from the
 * engine's own tree — a directory source, never a clone (verified
 * 2026-08-10 with git absent from PATH; see clients/claude-plugin/README)
 * — AND bring an existing install up to this engine. `marketplace add`
 * re-points a `bigbrain` marketplace already registered at another path
 * (an old checkout, an old app) at this one; `install` is a no-op when
 * installed; `update` re-copies when plugin.json's version moved, and
 * says "already at the latest version" otherwise (both verified
 * 2026-08-28 — lib/pluginState.ts has the consequences). `--yes`: update
 * refuses to run without a TTY otherwise, and connect has none from the
 * app. */
export function pluginInstallCommands(engineRoot: string): string[][] {
  const dir = join(engineRoot, "clients", "claude-plugin");
  return [
    ["claude", "plugin", "marketplace", "add", dir],
    ["claude", "plugin", "install", "bigbrain@bigbrain", "--scope", "user"],
    ["claude", "plugin", "marketplace", "update", "bigbrain"],
    ["claude", "plugin", "update", "bigbrain@bigbrain", "--scope", "user", "--yes"],
  ];
}

/** The refresh alone — for a plugin already installed: re-point, update. */
export function pluginRefreshCommands(engineRoot: string): string[][] {
  return pluginInstallCommands(engineRoot).filter((argv) => argv[2] !== "install");
}
