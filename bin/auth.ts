/**
 * auth.ts — the credential handshake: mint drop tokens for the HTTP intake
 * API (bin/api.ts). Tokens are minted where the vault lives — possession
 * of the machine's account is the root of trust. The secret is printed ONCE
 * at mint time; only its sha256 is kept (lib/auth.ts), so neither list nor
 * any file can ever show it again.
 *
 * Usage:
 *   bigbrain auth create --name "chrome extension" [--scope inbox:write]...
 *                        [--owner <email>] [--kind person-device|agent]
 *   bigbrain auth list
 *   bigbrain auth revoke <id>
 *
 * Identity: --owner names the person the credential belongs to; intake
 * stamps it as the item's `from:` on person-kind tokens. --kind agent makes
 * the token an agent credential — items stamp `from:` with the token's NAME
 * (the agent's chosen identity), owned by --owner. Legacy tokens (neither
 * flag) stamp no principal.
 *
 * Provenance (`via`) is stamped by the CONSENT surfaces that mint —
 * `bigbrain connect` writes "connect", browser pairing writes "pair" — and
 * the agents card lists only credentials carrying one (#141). A token
 * minted by hand here carries none, which is right: an operator-minted
 * token is not a consented one. The `--via` flag that let the hosted
 * provisioner claim otherwise, and the `--json` output it parsed, went with
 * the control plane (retired 2026-08-26; both deleted 2026-08-30).
 *
 * Scopes: inbox:write (drop) · vault:read (the web read path — a bearer
 * credential for non-browser API clients) · tend (the gardener door, #479 —
 * claim and submit the vault's due work; ONE designated machine per vault
 * holds it). Default inbox:write. (`outbox:write` retired with email,
 * 2026-08-10.)
 */

import { VAULT_ROOT } from "../lib/vaultRoot";
import { listTokens, mintToken, revokeToken, tokenStorePath } from "../lib/auth";
import { flagValue, flagValues, positionals } from "../lib/cliflags";

const [cmd, ...rest] = process.argv.slice(2);

const KNOWN_SCOPES = ["inbox:write", "vault:read", "tend"];

function usage(code: number): never {
  console.error(
    "usage: bigbrain auth create --name <label> [--scope inbox:write]... [--owner <email>] [--kind person-device|agent]"
  );
  console.error("       bigbrain auth list");
  console.error("       bigbrain auth revoke <id>");
  process.exit(code);
}

// ── create / list / revoke ──────────────────────────────────────────────────

function runCreate(): void {
  const storePath = tokenStorePath(VAULT_ROOT);
  const name = flagValue(rest, "name");
  if (!name) {
    console.error(
      'auth create: --name is required — a label you\'ll recognize in `auth list` ("chrome extension", "laptop")'
    );
    usage(2);
  }
  const scopes = flagValues(rest, "scope").filter(Boolean);
  if (!scopes.length) scopes.push("inbox:write");
  for (const s of scopes)
    if (!KNOWN_SCOPES.includes(s)) {
      console.error(
        `auth create: unknown scope ${JSON.stringify(s)} — known: ${KNOWN_SCOPES.join(", ")}`
      );
      process.exit(2);
    }

  const owner = flagValue(rest, "owner");
  const kind = flagValue(rest, "kind");
  if (kind !== undefined && kind !== "person-device" && kind !== "agent") {
    console.error(
      `auth create: --kind must be person-device or agent, got ${JSON.stringify(kind)}`
    );
    process.exit(2);
  }
  if (kind === "agent" && !owner) {
    console.error(
      "auth create: an agent token needs --owner — every agent acts as someone's delegate"
    );
    process.exit(2);
  }

  const { token, record } = mintToken(storePath, VAULT_ROOT, name, scopes, { owner, kind });

  const who =
    kind === "agent" ? `agent "${name}" for ${owner}` : owner ? `${owner}'s ${name}` : name;
  console.log(`auth: minted ${record.id} (${who}) — scopes: ${scopes.join(", ")}`);
  console.log("");
  console.log(`  ${token}`);
  console.log("");
  console.log("auth: store this now — it is never shown again (only its hash is kept).");
  console.log("auth: in the extension, paste it into its options page.");
  console.log(`auth: revoke any time with \`bigbrain auth revoke ${record.id}\`.`);
}

function runList(): void {
  const storePath = tokenStorePath(VAULT_ROOT);
  const tokens = listTokens(storePath);
  if (!tokens.length) {
    console.log(`auth: no tokens minted yet (store: ${storePath})`);
    process.exit(0);
  }
  const rows = tokens.map((t) => [
    t.id,
    t.name,
    t.kind === "agent" ? "agent" : "person",
    t.owner ?? "—",
    t.scopes.join(","),
    t.created.slice(0, 10),
    t.last_used ? t.last_used.slice(0, 16).replace("T", " ") : "never",
    t.revoked ? `REVOKED ${t.revoked.slice(0, 10)}` : "active",
  ]);
  const header = ["id", "name", "kind", "owner", "scopes", "created", "last used", "status"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log(fmt(header));
  for (const r of rows) console.log(fmt(r));
}

function runRevoke(): void {
  const storePath = tokenStorePath(VAULT_ROOT);
  const id = positionals(rest)[0];
  if (!id) usage(2);
  if (!revokeToken(storePath, id)) {
    console.error(
      `auth revoke: no token with id ${JSON.stringify(id)} — see \`bigbrain auth list\``
    );
    process.exit(1);
  }
  console.log(`auth: ${id} revoked — the API refuses it starting with its next request`);
}

if (cmd === "create") runCreate();
else if (cmd === "list") runList();
else if (cmd === "revoke") runRevoke();
else usage(cmd ? 2 : 0);
