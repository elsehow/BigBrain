import { vaultFetch as fetch } from "./vaultScope";
/**
 * connect.ts — the agents tab's client for credentials.
 *
 * The list and the revoke are the engine's own `/api/tokens` routes
 * (web/server.ts) — every credential minted for this vault, hashes left
 * out; each card picks its rows by provenance (`via`).
 *
 * The rest of this file was the retired control plane's — claim codes, the
 * install one-liner and its script hash, the tend line and its designation
 * — reporting absence as `null` so the tab degraded rather than erroring.
 * Nothing has served /connect since 2026-08-26, so it was answering `null`
 * forever; it went on 2026-08-30. Connecting is local (lib/setup.ts).
 */

export interface Connection {
  id: string;
  name: string;
  kind: "person-device" | "agent" | "legacy";
  /** Provenance — set only by a consent surface: the connect handoff
   * (`isConnection`) or a browser pairing (pair.ts `isBrowser`). */
  via?: "connect" | "pair";
  scopes: string[];
  created: string;
  /** Null until this credential has made its first request. */
  last_used: string | null;
  /** Null while live. Revoked rows stay in the list as an audit trail. */
  revoked: string | null;
}

/**
 * Is this a machine the user connected on the agents card?
 *
 * The test is provenance, not shape. `kind: "agent"` was the old test and it
 * was wrong (#141): a credential the PROVISIONER minted for the pre-#96 web
 * shell is also `kind: agent` — correctly so, because an internal reader must
 * never write as the person — and the tab reported it as a connected laptop on
 * a vault nobody had ever connected to, with a live REVOKE button beside it.
 *
 * `kind` answers "what principal does this write as". This card asks a
 * different question — "did a human authorize this here?" — and only the mint
 * path can answer it. So the rule is positive: show what we can name, and
 * nothing else. A credential minted for some future internal purpose is then
 * invisible here by default, rather than by our remembering to exclude it.
 */
export const isConnection = (c: Connection): boolean => c.via === "connect";

/** Credentials belong to one agent; a Codex token never connects Claude. */
export function connectionAgent(c: Connection): "claude" | "codex" | null {
  if (!isConnection(c)) return null;
  if (c.name === "claude code" || c.name.startsWith("claude code on ")) return "claude";
  if (c.name === "codex" || c.name.startsWith("codex on ")) return "codex";
  return null;
}

/** `null` ⇒ no such route here (an older host's viewer, or offline). */
export async function connections(): Promise<Connection[] | null> {
  try {
    const r = await fetch("/api/tokens", { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    return ((await r.json()) as { tokens: Connection[] }).tokens;
  } catch {
    return null;
  }
}

export async function revoke(id: string): Promise<void> {
  const r = await fetch("/api/tokens/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!r.ok) throw new Error(`could not revoke (${r.status})`);
}
