/**
 * localMcp.ts — the one door (docs/plans/2026-10-13-lenses-are-the-door.md
 * §2): the local API's `/mcp`, MCP over HTTP on 127.0.0.1, offering the
 * tools the stdio server does (lib/mcp.ts) to the credentials Connected
 * Clients mints (lib/connectedClients.ts).
 *
 * The grant is the credential's scopes, checked on every request — the
 * transport is stateless (lib/mcpHttp.ts), so revoking a connection closes
 * it at the next call. `vault:read` opens the door and every read;
 * `inbox:write` adds `drop`. Nothing here edits or deletes.
 *
 * Only a credential Connected Clients lists gets in: the settings page is
 * the consent surface, so everything that can read through this door is
 * on it, with its last use, and can be revoked there. A lapsed connection
 * is still served, every tool answering where to renew it, as the stdio
 * server does — a refused connection could never tell the agent why.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { expiredMessage, hasScope, listedInConnectedClients, noteExpiredUse, touchLastUsed, verifyToken, type TokenRecord } from "./auth";
import { ConnectedClients } from "./connectedClients";
import { handleMcpTool, MCP_INSTRUCTIONS, McpToolError, mcpToolList, type McpContext } from "./mcp";
import { rpcError, serveStatelessMcp, type McpToolResult } from "./mcpHttp";

export interface LocalMcpDeps {
  root: string;
  storePath: string;
  now: () => Date;
  log: (line: string) => void;
  /** The door's per-credential rate limit, for what writes (drop). */
  takeToken: (id: string) => { ok: true } | { ok: false; retryAfter: number };
}

const text = (t: string, isError = false): McpToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** Reads of the whole vault are for this machine: a request through a
 * proxy, or a page under a rebound name, carries another Host. */
function loopbackHost(host: string | null): boolean {
  return !!host && /^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(host);
}

/** A browser page has no business here: the bearer token is the whole
 * authority, but a page that could guess one should still not be let in. */
function loopbackOrigin(origin: string | null): boolean {
  if (origin === null) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]");
  } catch {
    return false;
  }
}

/** Answer one `/mcp` request. Returns the credential it served, for the door's log. */
export async function serveLocalMcp(req: Request, deps: LocalMcpDeps): Promise<{ response: Response; record?: TokenRecord }> {
  if (!loopbackHost(req.headers.get("host") ?? new URL(req.url).host)) return { response: rpcError(403, -32000, "This door answers only on this machine (127.0.0.1).") };
  if (!loopbackOrigin(req.headers.get("origin"))) return { response: rpcError(403, -32000, "Browser pages cannot use this door.") };
  const auth = req.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const verdict = verifyToken(deps.storePath, presented, deps.now());
  const unauthorized = rpcError(401, -32001, "Unauthorized: present a connection from BigBrain → Settings → Connected agents.", { "WWW-Authenticate": "Bearer" });

  if (!verdict.ok) {
    const lapsed = verdict.expired;
    if (!lapsed || !listedInConnectedClients(lapsed)) {
      deps.log(JSON.stringify({ ts: deps.now().toISOString(), warn: "auth refused", path: "/mcp", reason: verdict.reason }));
      return { response: unauthorized };
    }
    noteExpiredUse(deps.storePath, lapsed.id, deps.now());
    const message = expiredMessage(lapsed);
    return {
      record: lapsed,
      response: await serveStatelessMcp(req, { name: "bigbrain", instructions: MCP_INSTRUCTIONS, tools: () => mcpToolList().filter((t) => hasScope(lapsed, "inbox:write") || t.name !== "drop"), call: () => text(message, true) }),
    };
  }

  const record = verdict.record;
  if (!listedInConnectedClients(record)) return { record, response: rpcError(403, -32000, "This credential is not a connected agent. Add one in BigBrain → Settings → Connected agents.") };
  if (!hasScope(record, "vault:read")) return { record, response: rpcError(403, -32000, "missing scope vault:read") };
  if (req.method === "POST") {
    touchLastUsed(deps.storePath, record.id, deps.now());
    new ConnectedClients(deps.root, deps.storePath).observed(record.id);
  }

  const ctx: McpContext = { root: deps.root, via: "api", source: "mcp", clientName: record.name, integrationToken: presented, tokenStore: deps.storePath };
  const writes = hasScope(record, "inbox:write");
  return {
    record,
    response: await serveStatelessMcp(req, {
      name: "bigbrain",
      instructions: MCP_INSTRUCTIONS,
      tools: () => mcpToolList(ctx).filter((t) => writes || t.name !== "drop"),
      call: async (name, args) => {
        if (name === "drop") {
          if (!writes) throw new McpError(ErrorCode.InvalidParams, "Unknown tool: drop");
          const rate = deps.takeToken(record.id);
          if (!rate.ok) return text(`Rate limited: try again in ${rate.retryAfter}s.`, true);
        }
        try {
          const result = await handleMcpTool(ctx, name, args);
          return text(typeof result === "string" ? result : JSON.stringify(result));
        } catch (error) {
          if (error instanceof McpToolError) return text(error.message, true);
          // Still the tool's failure, not the door's: answer the call.
          deps.log(JSON.stringify({ ts: deps.now().toISOString(), warn: "mcp tool failed", tool: name, token: record.id, error: error instanceof Error ? error.message : String(error) }));
          return text(error instanceof Error ? error.message : String(error), true);
        }
      },
    }),
  };
}
