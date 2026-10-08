#!/usr/bin/env bun
/**
 * shared.ts — `bigbrain shared`: operate ONE shared vault (docs/shared-vault.md).
 *
 * The shared vault is named EXPLICITLY, always: `--vault <dir>` or
 * `BIGBRAIN_SHARED_VAULT`. It is never discovered the way the personal
 * vault is (no walk-up, no pointer file), because serving a vault to other
 * people is not something to do by accident — an operator who forgot the
 * flag gets usage, not their own vault on a port.
 *
 * Members and credentials live OUTSIDE the vault (`--members <file>`,
 * `BIGBRAIN_SHARED_MEMBERS`, else ~/.config/bigbrain/shared-members/<hash>.json),
 * and are managed HERE, on the host, by whoever holds the host account —
 * the root of trust, exactly as for `bigbrain auth`. The HTTP door has no
 * member-management routes on purpose: a leaked owner credential cannot
 * mint more credentials.
 *
 * Usage:
 *   bigbrain shared init      --vault <dir> --owner <handle> [--display <name>] [--members <file>]
 *   bigbrain shared member add <handle> [--display <name>] [--permissions read,write] [--email <addr>]
 *   bigbrain shared member list
 *   bigbrain shared member set <handle> [--permissions read[,write]] [--email <addr> | --clear-email]
 *   bigbrain shared member revoke <handle>
 *   bigbrain shared credential mint <handle> --name <label> [--kind person|agent] [--scopes read,write]
 *   bigbrain shared credential list [<handle>]
 *   bigbrain shared credential revoke <id>
 *   bigbrain shared inspect
 *   bigbrain shared serve     [--host 127.0.0.1] [--port 4749] [--public-url https://vault.example.com]
 *
 * `--public-url` (or BIGBRAIN_SHARED_PUBLIC_URL) turns on the Claude
 * connector — OAuth sign-in and a read-only `/mcp` (docs/shared-vault-connector.md);
 * BIGBRAIN_SHARED_GOOGLE_CLIENT_ID / _SECRET add "Sign in with Google".
 * A member's email is what that sign-in matches, once, before binding.
 *
 * A secret is printed ONCE, at mint time; only its sha256 is stored.
 * `--json` on any command prints machine-readable output (the smoke
 * scenario parses it).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { flagValue, hasFlag, positionals } from "../lib/cliflags";
import { ensureDir } from "../lib/fsx";
import { sharedGoogleClientId, sharedGoogleClientSecret, sharedMemberStore, sharedPort, sharedPublicUrl, sharedVaultOverride } from "../lib/env";
import {
  addMember,
  initMemberStore,
  listCredentials,
  listMembers,
  memberStorePath,
  mintCredential,
  revokeCredential,
  revokeMember,
  setMemberEmail,
  setMemberPermissions,
  SharedMemberError,
  type SharedCredentialKind,
} from "../lib/sharedMembers";
import { holdSharedVault, SharedVault, SHARED_FEED_DIR, sharedServerLock } from "../lib/sharedVault";
import { makeSharedApiHandler, MAX_SHARED_REQUEST_BYTES } from "../lib/sharedVaultApi";
import { MCP_PATH, parsePublicUrl, type SharedConnectorConfig } from "../lib/sharedOAuth";

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["vault", "members", "owner", "display", "permissions", "name", "kind", "scopes", "host", "port", "email", "public-url"]);
const words = positionals(argv, VALUE_FLAGS);
const [cmd, sub, ...restWords] = words;
const asJson = hasFlag(argv, "json");

function usage(code: number): never {
  console.error(`usage: bigbrain shared <command> --vault <dir> [--members <file>] [--json]
  init --owner <handle> [--display <name>]          (the member store must be OUTSIDE the vault)
  member add <handle> [--display <name>] [--permissions read,write] [--email <addr>]
  member list | member set <handle> [--permissions …] [--email <addr> | --clear-email] | member revoke <handle>
  credential mint <handle> --name <label> [--kind person|agent] [--scopes read,write]
  credential list [<handle>] | credential revoke <id>
  inspect
  serve [--host 127.0.0.1] [--port ${sharedPort()}] [--remote]   (--remote: bind off loopback, TLS in front)
        [--public-url https://vault.example.com]           (turns on the Claude connector)`);
  process.exit(code);
}

function fail(message: string): never {
  console.error(`shared: ${message}`);
  process.exit(1);
}

function out(human: string, machine: unknown): void {
  if (asJson) console.log(JSON.stringify(machine));
  else console.log(human);
}

/** Explicit, or nothing. */
function vaultRoot(): string {
  const flag = flagValue(argv, "vault") ?? sharedVaultOverride();
  if (!flag) {
    console.error("shared: name the shared vault with --vault <dir> (or BIGBRAIN_SHARED_VAULT) — it is never discovered");
    usage(2);
  }
  return resolve(flag);
}

function storePath(root: string): string {
  const flag = flagValue(argv, "members");
  const path = flag ? resolve(flag) : (sharedMemberStore() ?? memberStorePath(root));
  // Credentials are not content: a store inside the vault would be served,
  // synced and backed up with it.
  const rel = relative(root, path);
  const inside = rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  if (inside) fail(`the member store must live outside the vault (got ${path} under ${root})`);
  return path;
}

/** Only a vault that `bigbrain shared init` marked may be served: a
 * personal vault has a vault.yaml too, and pointing this door at one would
 * hand its whole insertion log to the members. */
function requireSharedMarker(root: string): void {
  const manifest = join(root, "vault.yaml");
  if (!existsSync(manifest)) fail(`${root} is not a shared vault — \`bigbrain shared init --vault ${root} --owner <handle>\` first`);
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(manifest, "utf8"));
  } catch {
    parsed = undefined;
  }
  if (!(typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>)["shared"] === true))
    fail(`${manifest} does not say \`shared: true\` — this door serves only a vault created by \`bigbrain shared init\`, never a personal one`);
}

const splitList = (raw: string | undefined): string[] | undefined =>
  raw === undefined ? undefined : raw.split(",").map((s) => s.trim()).filter(Boolean);

function runMember(store: string): void {
  const handle = restWords[0];
  if (sub === "add") {
    if (!handle) fail("member add: <handle> is required");
    const email = flagValue(argv, "email");
    const m = addMember(store, { handle, display: flagValue(argv, "display"), permissions: splitList(flagValue(argv, "permissions")), ...(email !== undefined ? { email } : {}) });
    out(`added ${m.handle} (${m.id}) permissions ${m.permissions.join(",")}${m.email ? ` email ${m.email}` : ""}`, m);
  } else if (sub === "list") {
    const rows = listMembers(store);
    out(
      rows.map((m) => `${m.handle.padEnd(20)} ${m.role.padEnd(7)} ${m.permissions.join(",").padEnd(11)} ${m.revoked ? `revoked ${m.revoked}` : "live"}${m.email ? `  ${m.email}${m.identity ? " (signed in)" : m.pending ? " (pending)" : ""}` : ""}`).join("\n") || "(no members)",
      rows
    );
  } else if (sub === "set") {
    const perms = splitList(flagValue(argv, "permissions"));
    const email = flagValue(argv, "email");
    const clear = hasFlag(argv, "clear-email");
    if (!handle || (!perms && email === undefined && !clear) || (email !== undefined && clear))
      fail("member set: <handle> [--permissions read[,write]] [--email <addr> | --clear-email]");
    let m = perms ? setMemberPermissions(store, handle, perms) : undefined;
    // Changing or clearing an email unbinds the account that signed in with it.
    if (email !== undefined || clear) m = setMemberEmail(store, handle, clear ? null : email!);
    out(`${m!.handle} permissions ${m!.permissions.join(",")}${m!.email ? ` email ${m!.email}` : " no email"}`, m);
  } else if (sub === "revoke") {
    if (!handle) fail("member revoke: <handle> is required");
    const m = revokeMember(store, handle);
    out(`revoked ${m.handle} and every credential they held (${m.revoked})`, m);
  } else usage(2);
}

function runCredential(store: string): void {
  if (sub === "mint") {
    const handle = restWords[0];
    const name = flagValue(argv, "name");
    if (!handle || !name) fail("credential mint: <handle> --name <label> are required");
    const kind = (flagValue(argv, "kind") ?? "person") as SharedCredentialKind;
    const r = mintCredential(store, handle, { name, kind, scopes: splitList(flagValue(argv, "scopes")) });
    out(
      `credential ${r.credential.id} for ${handle} (${r.credential.name}, ${r.credential.kind}, ${r.credential.scopes.join(",")}) — printed once:\n${r.token}`,
      { credential: r.credential, token: r.token }
    );
  } else if (sub === "list") {
    const rows = listCredentials(store, restWords[0]);
    out(
      rows.map((c) => `${c.id}  ${c.name.padEnd(20)} ${c.kind.padEnd(6)} ${c.scopes.join(",").padEnd(11)} ${c.revoked ? `revoked ${c.revoked}` : `live, last used ${c.last_used ?? "never"}`}`).join("\n") || "(no credentials)",
      rows
    );
  } else if (sub === "revoke") {
    const id = restWords[0];
    if (!id) fail("credential revoke: <id> is required");
    if (!revokeCredential(store, id)) fail(`credential revoke: no credential ${id}`);
    out(`revoked credential ${id}`, { id, revoked: true });
  } else usage(2);
}

/** The Claude connector, when the operator asked for it: a public URL from
 * `--public-url` or the environment, and Google only when BOTH halves of
 * its client are set — half a client is a mistake to name, not to ignore. */
function connectorConfig(): SharedConnectorConfig | undefined {
  const raw = flagValue(argv, "public-url") ?? sharedPublicUrl();
  const id = sharedGoogleClientId();
  const secret = sharedGoogleClientSecret();
  if (!raw) {
    if (id || secret) console.error("shared: BIGBRAIN_SHARED_GOOGLE_* is set but no public URL — the connector stays off");
    return undefined;
  }
  try {
    parsePublicUrl(raw);
  } catch (error) {
    fail(`serve: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (Boolean(id) !== Boolean(secret)) fail("serve: set both BIGBRAIN_SHARED_GOOGLE_CLIENT_ID and BIGBRAIN_SHARED_GOOGLE_CLIENT_SECRET, or neither");
  return { publicUrl: raw, ...(id && secret ? { google: { clientId: id, clientSecret: secret } } : {}) };
}

function run(): void {
  if (!cmd) usage(0);
  const root = vaultRoot();
  const store = storePath(root);

  switch (cmd) {
    case "init": {
      const owner = flagValue(argv, "owner");
      if (!owner) fail("init: --owner <handle> is required — the one operator of this vault");
      if (existsSync(root) && !statSync(root).isDirectory()) fail(`init: ${root} is not a directory`);
      mkdirSync(join(root, SHARED_FEED_DIR), { recursive: true });
      if (!existsSync(join(root, "vault.yaml")))
        writeFileSync(join(root, "vault.yaml"), "# a shared vault — served by `bigbrain shared serve` (docs/shared-vault.md)\nshared: true\n");
      const r = initMemberStore(store, root, { handle: owner, display: flagValue(argv, "display") });
      out(
        `initialized shared vault ${root}\nmembers: ${store}\nowner ${r.member.handle} (${r.member.id})\ncredential ${r.credential.id} (${r.credential.name}) — printed once:\n${r.token}`,
        { vault: root, members: store, member: r.member, credential: r.credential, token: r.token }
      );
      return;
    }
    case "member":
      return runMember(store);
    case "credential":
      return runCredential(store);
    case "inspect": {
      requireSharedMarker(root);
      const vault = new SharedVault(root);
      const evidence = vault.listEvidence({ limit: 200 });
      const assertions = vault.listAssertions({ limit: 200, includeRevoked: true });
      const live = assertions.items.filter((a) => !a.revocation).length;
      const missing = vault.missingFromFeed();
      const summary = {
        vault: root,
        members: store,
        feed_head: vault.head(),
        evidence: evidence.items.length,
        assertions: assertions.items.length,
        live_assertions: live,
        revoked_assertions: assertions.items.length - live,
        /** events on disk the feed does not carry (a crash between appends; a retry heals it) */
        feed_missing: missing,
      };
      out(
        `${root}\nfeed head ${summary.feed_head} · ${summary.evidence} evidence · ${summary.assertions} assertions (${live} live, ${summary.revoked_assertions} revoked)${missing.length ? `\nWARNING ${missing.length} event(s) missing from the feed: ${missing.join(", ")}` : ""}`,
        summary
      );
      return;
    }
    case "serve": {
      requireSharedMarker(root);
      if (!existsSync(store)) fail(`serve: no member store at ${store} — init first`);
      const hostname = flagValue(argv, "host") ?? "127.0.0.1";
      const port = Number(flagValue(argv, "port") ?? sharedPort());
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`serve: bad port ${port}`);
      const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
      // The door speaks plaintext HTTP and bearer secrets ride in it. Off
      // loopback it belongs behind TLS (docs/shared-vault.md); binding a
      // reachable address is an explicit, named decision.
      if (!loopback && !hasFlag(argv, "remote"))
        fail(`serve: refusing to bind ${hostname} without --remote — bearer credentials would cross the network in plaintext; front the door with TLS and pass --remote (docs/shared-vault.md)`);
      if (!loopback) console.error(`shared: binding ${hostname} (--remote) — this is plaintext HTTP; TLS must terminate in front of it`);
      const connector = connectorConfig();
      // Held for as long as this process serves; the OS lets it go the
      // moment the process dies, however it dies (lib/sqliteLock.ts).
      ensureDir(join(root, ".state"));
      const lock = holdSharedVault(root, "shared");
      if (!lock) fail(`serve: another server holds ${sharedServerLock(root)}`);
      const vault = new SharedVault(root);
      vault.recoverPending();
      const handler = makeSharedApiHandler({ root, storePath: store, vault, ...(connector ? { connector } : {}) });
      let server: ReturnType<typeof Bun.serve>;
      try {
        server = Bun.serve({ hostname, port, maxRequestBodySize: MAX_SHARED_REQUEST_BYTES, idleTimeout: 30, fetch: handler });
      } catch (error) {
        lock.release();
        const message = error instanceof Error ? error.message : String(error);
        // Bun reports a refused bind (a sandbox without listen permission,
        // EPERM) as EADDRINUSE; on port 0 "in use" is impossible, so name
        // the real cause rather than send the operator hunting for a port.
        const cause = port === 0 || /EPERM|EACCES/u.test(message) ? " (the environment refused to bind a socket — a sandbox without network-listen permission, or a privileged port)" : "";
        fail(`serve: cannot listen on ${hostname}:${port} — ${message}${cause}`);
      }
      const stop = (): void => {
        server.stop(true);
        lock.release();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      // One line, machine-readable, so a supervisor or a test learns the
      // bound port (port 0 = ephemeral) without parsing prose.
      console.log(JSON.stringify({ shared: "listening", hostname, port: server.port, vault: root, members: store, feed_head: vault.head(),
        ...(connector ? { connector: `${parsePublicUrl(connector.publicUrl)}${MCP_PATH}`, google: Boolean(connector.google) } : {}) }));
      return;
    }
    default:
      usage(2);
  }
}

try {
  run();
} catch (error) {
  if (error instanceof SharedMemberError) fail(error.message);
  throw error;
}
