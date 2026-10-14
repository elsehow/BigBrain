/**
 * mcpHttp.ts — MCP over HTTP, as both doors serve it: the shared vault's
 * `/mcp` (lib/sharedMcp.ts) and the local API's (lib/localMcp.ts).
 *
 * Streamable HTTP, stateless: every POST builds a fresh SDK `Server` and a
 * web-standard transport in JSON-response mode, answers, and is gone — no
 * session, no SSE stream, nothing held between requests, so it lives inside
 * a door's pure (Request) => Response handler and tests need no socket. The
 * door has verified the credential before this reads a byte of the body,
 * and checks it again on every request: revoking a credential closes it.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readCapped } from "./sharedOAuth";

/** JSON-RPC requests are small; a body this big is not one. */
export const MAX_MCP_BODY_BYTES = 1024 * 1024;

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

export const rpcError = (status: number, code: number, message: string, headers: Record<string, string> = {}): Response =>
  new Response(`${JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null })}\n`, {
    status,
    headers: { "Content-Type": "application/json", ...HEADERS, ...headers },
  });

export interface McpTool { name: string; description: string; inputSchema: object; annotations?: object }
export type McpToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface StatelessMcp {
  name: string;
  instructions: string;
  tools: () => McpTool[];
  /** One call's answer. A refusal the model should read comes back with
   * `isError`; a throw is a protocol error. */
  call: (name: string, args: Record<string, unknown>) => McpToolResult | Promise<McpToolResult>;
}

/** Answer one `/mcp` request for an already-verified caller. */
export async function serveStatelessMcp(req: Request, mcp: StatelessMcp): Promise<Response> {
  // Stateless: there is no session to stream to (GET) or end (DELETE).
  if (req.method !== "POST") return rpcError(405, -32000, "Method not allowed: this server is stateless; POST JSON-RPC to it.", { Allow: "POST" });
  const raw = await readCapped(req, MAX_MCP_BODY_BYTES);
  if (raw === null) return rpcError(413, -32600, `Request body exceeds ${MAX_MCP_BODY_BYTES} bytes.`);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return rpcError(400, ErrorCode.ParseError, "Parse error: the body is not JSON.");
  }

  const server = new Server({ name: mcp.name, version: "1.0.0" }, { capabilities: { tools: {} }, instructions: mcp.instructions });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: mcp.tools() as never }));
  server.setRequestHandler(CallToolRequestSchema, (request) => mcp.call(request.params.name, request.params.arguments ?? {}));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req, { parsedBody: body });
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  } finally {
    await server.close();
  }
}
