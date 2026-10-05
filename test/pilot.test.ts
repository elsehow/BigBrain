import { saveWorkPermissions } from "../lib/workPermissions";
/** pilot.test.ts — the pilot's doors (#770).
 *
 * The invariants: the key lives in the vault's .env and is read fresh; the
 * page never sees it (the mint sends it to OpenAI and hands back a client
 * secret); the tool table is the MCP readers verbatim plus the pilot's own,
 * and never the gardener's; a drop or directive the pilot lands is AGENT
 * voice; a conversation lands as one agent-chat-shaped segment when it
 * settles, and the spool survives until it does.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import { dispatch } from "../lib/httpx";
import { readEnvValues } from "../lib/envFile";
import { mcpToolList } from "../lib/mcp";
import {
  mintPilotSecret,
  PILOT_ENV,
  PILOT_MODEL,
  pilotInstructions,
  pilotKey,
  pilotRoutes,
  pilotSession,
  pilotState,
  pilotToolCall,
  pilotTools,
  PilotError,
  setPilotKey,
  setPilotEnabled,
} from "../lib/pilot";
import {
  appendPilotTurn,
  buildPilotItem,
  parseTurn,
  pilotSpoolDir,
  readPilotTurns,
  settlePilotConversation,
  sweepPilotSpool,
  type PilotTurn,
} from "../lib/pilotTranscript";
import { readSourceInsertionLog } from "../lib/insertionLog";
import { nativeVault, NATIVE_YAML } from "./support/vault";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const vault = (): string => {
  const root = nativeVault({
    prefix: "bb-pilot-",
    files: {
      "vault.yaml": NATIVE_YAML,
      "memory/MEMORY.md": "# Memory index\n- [[memory/ridgeways]]\n",
      "memory/ridgeways.md": "# Ridgeways\nWhere the ridgeways stood.\n",
    },
  });
  scratch.push(root);
  return root;
};

const KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";

/** Drive one route the way the server would: a request with a JSON body,
 * a response that captures status and body. */
async function call(
  routes: ReturnType<typeof pilotRoutes>,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    url: path,
    method,
    headers: {},
  });
  let status = 0;
  let text = "";
  const done = new Promise<void>((resolve) => {
    const res = {
      writeHead: (code: number) => {
        status = code;
      },
      end: (b: string) => {
        text = b;
        resolve();
      },
    };
    expect(dispatch(routes, req as never, res as never)).toBe(true);
  });
  await done;
  return { status, json: JSON.parse(text) as Record<string, unknown> };
}

describe("the key", () => {
  test("absent ⇒ not configured; set ⇒ configured, and readable back from .env", () => {
    const root = vault();
    expect(pilotState(root)).toEqual({ configured: false, enabled: false, status: "unconfigured", model: PILOT_MODEL, voice: "marin", permissions: { version: 2, folders: [] } });
    expect(setPilotKey(root, `  ${KEY}\n`).configured).toBe(true);
    expect(pilotKey(root)).toBe(KEY);
    expect(readEnvValues(root)[PILOT_ENV]).toBe(KEY);
  });

  test("a key with spaces or too short is refused; empty removes", () => {
    const root = vault();
    setPilotKey(root, KEY);
    expect(() => setPilotKey(root, "sk-abc def")).toThrow(PilotError);
    expect(() => setPilotKey(root, "short")).toThrow(/does not look like/);
    expect(() => setPilotKey(root, 42)).toThrow(/string/);
    expect(pilotKey(root)).toBe(KEY);
    expect(setPilotKey(root, "").configured).toBe(false);
    expect(pilotKey(root)).toBeUndefined();
  });

  test("the file is re-read on every call — an edit by hand lands without a restart", () => {
    const root = vault();
    expect(pilotState(root).configured).toBe(false);
    writeFileSync(join(root, ".env"), `${PILOT_ENV}=${KEY}\n`);
    expect(pilotState(root).configured).toBe(true);
  });
});

describe("the enabled switch", () => {
  test("existing keys default on; disabling preserves the key and blocks minting", async () => {
    const root = vault();
    expect(setPilotKey(root, KEY).enabled).toBe(true);
    expect(setPilotEnabled(root, false)).toMatchObject({ configured: true, enabled: false, status: "disabled" });
    expect(pilotKey(root)).toBe(KEY);
    let calls = 0;
    const result = await mintPilotSecret(root, { fetch: (async () => { calls++; return new Response("{}"); }) as typeof fetch });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(calls).toBe(0);
    expect(setPilotKey(root, KEY).enabled).toBe(false);
    expect(setPilotEnabled(root, true)).toMatchObject({ configured: true, enabled: true, status: "ready" });
  });

  test("can enable setup before saving a key; route rejects non-booleans", async () => {
    const root = vault();
    const routes = pilotRoutes(root, { setPermissions: async value => saveWorkPermissions(root, value) });
    expect((await call(routes, "POST", "/api/pilot/enabled", { enabled: true })).json).toMatchObject({ configured: false, enabled: true });
    expect((await call(routes, "POST", "/api/pilot/secret")).status).toBe(409);
    expect((await call(routes, "POST", "/api/pilot/enabled", { enabled: "false" })).status).toBe(400);
    expect(pilotState(root).enabled).toBe(true);
    expect(setPilotKey(root, KEY)).toMatchObject({ configured: true, enabled: true });
  });
});

describe("the tool table", () => {
  test("is the MCP readers first, then the pilot's own, each a well-formed function", () => {
    const tools = pilotTools();
    expect(tools.slice(0, 3).map((t) => t.name)).toEqual(["load_memory", "search_vault", "read_note"]);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const t of tools) {
      expect(t.type).toBe("function");
      expect(t.description.length).toBeGreaterThan(10);
      expect((t.parameters as { type: string }).type).toBe("object");
    }
    const mcp = new Map(mcpToolList().map((t) => [t.name, t]));
    for (const name of ["load_memory", "search_vault", "read_note", "drop"]) {
      const ours = tools.find((t) => t.name === name)!;
      expect(ours.description).toBe(mcp.get(name)!.description);
      expect(ours.parameters).toEqual(mcp.get(name)!.inputSchema);
    }
    expect(tools.some((t) => ["next", "open", "submit"].includes(t.name))).toBe(false);
  });

  test("readers delegate to lib/mcp.ts: load_memory reads the working set", async () => {
    const root = vault();
    expect(await pilotToolCall(root, "load_memory", {})).toContain("[[memory/ridgeways]]");
  });

  test("an unknown tool, and a reader's refusal, come back as PilotError for the model", async () => {
    const root = vault();
    await expect(pilotToolCall(root, "submit", { items: [] })).rejects.toThrow(/no such tool: submit/);
    await expect(pilotToolCall(root, "search_vault", {})).rejects.toThrow(PilotError);
    await expect(pilotToolCall(root, "search_vault", {})).rejects.toThrow(/missing query/);
  });

  test("drop lands as the pilot's agent voice, and recent then shows it", async () => {
    const root = vault();
    const r = (await pilotToolCall(root, "drop", { title: "Spoken idea", body: "Try the ridgeways on Tuesday." })) as {
      id: string;
      path: string;
    };
    expect(r.id).toBeTruthy();
    const events = readSourceInsertionLog(root);
    const ev = events.find((e) => e.source_id === r.id)!;
    const env = ev.envelope as Record<string, unknown>;
    expect(env["source"]).toBe("pilot");
    expect(env["from"]).toBe("pilot");
    expect(env["from_kind"]).toBe("agent");
    const recent = (await pilotToolCall(root, "recent", { limit: 5 })) as { total: number; recent: { title?: string }[] };
    expect(recent.total).toBeGreaterThanOrEqual(1);
    expect(recent.recent.some((e) => e.title === "Spoken idea")).toBe(true);
  });

  test("status reports due counts and the newest run (none yet)", async () => {
    const root = vault();
    const s = (await pilotToolCall(root, "status", {})) as { due: { intake: number; staged: number }; last_run: unknown };
    expect(s.due).toEqual({ intake: 0, staged: 0 });
    expect(s.last_run).toBeNull();
  });

  test("directive lands a voice arrival; one about nothing in the record is refused", async () => {
    const root = vault();
    const r = (await pilotToolCall(root, "directive", { text: "Skip the newsletter sender." })) as { id: string; path: string };
    expect(r.id).toMatch(/^ins_/);
    await expect(pilotToolCall(root, "directive", { text: "flag it", about: ["nope-not-here"] })).rejects.toThrow(
      /names nothing in the record/
    );
    await expect(pilotToolCall(root, "directive", {})).rejects.toThrow(/missing text/);
  });
});

describe("the session and the mint", () => {
  test("the speech session has no tools, no automatic turn detection, and today's date", () => {
    const now = new Date(2026, 8, 6, 15, 30);
    const s = pilotSession(now) as { model: string; tools: unknown[]; audio: { input: { turn_detection: unknown } }; instructions: string };
    expect(s.model).toBe(PILOT_MODEL);
    expect(s.tools).toHaveLength(0);
    expect(s.audio.input.turn_detection).toBeNull();
    expect(s.instructions).toContain("Today is 2026-09-06.");
    expect(pilotInstructions(now)).toContain("Never independently answer");
  });

  test("no key ⇒ 409 and OpenAI is never called", async () => {
    const root = vault();
    let calls = 0;
    const r = await mintPilotSecret(root, { fetch: (async () => { calls++; return new Response("{}"); }) as typeof fetch });
    expect(r).toEqual({ ok: false, status: 409, error: expect.stringMatching(/no OpenAI key/) });
    expect(calls).toBe(0);
  });

  test("the mint sends the key to OpenAI only, with the session baked in, and returns the secret", async () => {
    const root = vault();
    setPilotKey(root, KEY);
    let seen: { url: string; init: RequestInit } | null = null;
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ value: "ek_test_123", expires_at: 1_700_000_600, session: {} }), { status: 200 });
    }) as typeof fetch;
    const r = await mintPilotSecret(root, { fetch: fake });
    expect(r).toEqual({ ok: true, secret: { value: "ek_test_123", expires_at: 1_700_000_600, model: PILOT_MODEL } });
    expect(seen!.url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(seen!.init.body)) as { expires_after: unknown; session: { model: string; tools: unknown[] } };
    expect(body.expires_after).toEqual({ anchor: "created_at", seconds: 600 });
    expect(body.session.model).toBe(PILOT_MODEL);
    expect(body.session.tools).toHaveLength(0);
    expect(String(seen!.init.body)).not.toContain("memory/ridgeways");
    expect(String(seen!.init.body)).not.toContain("Where the ridgeways stood");
  });

  test("OpenAI refusing the key is a concise 401; any other upstream failure a 502", async () => {
    const root = vault();
    setPilotKey(root, KEY);
    const refuse = (async () =>
      new Response(JSON.stringify({ error: { message: "Incorrect API key provided" } }), { status: 401 })) as typeof fetch;
    expect(await mintPilotSecret(root, { fetch: refuse })).toEqual({
      ok: false,
      status: 401,
      error: "OpenAI key rejected",
    });
    const down = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch;
    const r = await mintPilotSecret(root, { fetch: down });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(502);
    const unreachable = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const u = await mintPilotSecret(root, { fetch: unreachable });
    expect(u).toEqual({ ok: false, status: 502, error: expect.stringMatching(/could not reach OpenAI/) });
  });
});

describe("the routes", () => {
  test("permission settings persist without replacing credentials and reject invalid directory inputs", async () => {
    const root = vault(); setPilotKey(root, KEY);
    const routes = pilotRoutes(root, { setPermissions: async value => saveWorkPermissions(root, value) });
    const saved = await call(routes, "POST", "/api/pilot/permissions", { directories: [root], cowboy: false });
    expect(saved.status).toBe(200);
    expect(saved.json.permissions.folders).toHaveLength(1);
    const cowboy = await call(routes, "POST", "/api/pilot/permissions", { directories: [root], cowboy: true });
    expect(cowboy.status).toBe(400);
    expect(readEnvValues(root)[PILOT_ENV]).toBe(KEY);
    expect((await call(routes, "POST", "/api/pilot/permissions", { directories: ["relative"], cowboy: false })).status).toBe(400);
    expect((await call(routes, "GET", "/api/pilot")).json.permissions.version).toBe(2);
  });
  test("GET /api/pilot, POST key, POST secret — the page's whole door", async () => {
    const root = vault();
    const fake = (async () => new Response(JSON.stringify({ value: "ek_x", expires_at: 1 }))) as typeof fetch;
    const routes = pilotRoutes(root, { setPermissions: async value => saveWorkPermissions(root, value), fetch: fake });
    expect((await call(routes, "GET", "/api/pilot")).json).toEqual({ configured: false, enabled: false, status: "unconfigured", model: PILOT_MODEL, voice: "marin", permissions: { version: 2, folders: [] } });
    expect((await call(routes, "POST", "/api/pilot/secret")).status).toBe(409);
    expect((await call(routes, "POST", "/api/pilot/key", { key: KEY })).json).toMatchObject({ configured: true });
    const s = await call(routes, "POST", "/api/pilot/secret");
    expect(s.status).toBe(200);
    expect(s.json).toEqual({ value: "ek_x", expires_at: 1, model: PILOT_MODEL });
    expect(routes.some(r => r.path === "/api/pilot/tool")).toBe(false);
    expect(routes.some(r => r.path.includes("handoff"))).toBe(false);
    expect((await call(routes, "POST", "/api/pilot/key", { key: "x y" })).status).toBe(400);
  });
});

describe("the transcript", () => {
  const turn = (over: Partial<PilotTurn> & { speaker: PilotTurn["speaker"] }): PilotTurn => ({
    text: "",
    at: "2026-09-06T22:00:00.000Z",
    ...over,
  });

  test("parseTurn refuses the malformed and defaults `at` to now", () => {
    const now = new Date("2026-09-06T22:05:00Z");
    expect(() => parseTurn({ speaker: "narrator", text: "hi" }, now)).toThrow(/speaker/);
    expect(() => parseTurn({ speaker: "user", text: "  " }, now)).toThrow(/text or tools/);
    expect(() => parseTurn({ speaker: "user", text: "hi", at: "yesterday" }, now)).toThrow(/ISO/);
    expect(parseTurn({ speaker: "pilot", tools: ["search_vault"] }, now)).toEqual({
      speaker: "pilot",
      text: "",
      at: now.toISOString(),
      tools: ["search_vault"],
    });
  });

  test("the item is agent-chat's shape: agent-composed, turns labeled, tools named", () => {
    const item = buildPilotItem(
      "conv_0123456789",
      [
        turn({ speaker: "user", text: "anything new today?", at: "2026-09-06T22:00:00.000Z" }),
        turn({ speaker: "pilot", text: "Two things landed.", tools: ["recent", "status"], at: "2026-09-06T22:00:09.000Z" }),
      ],
      new Date("2026-09-06T22:10:00Z")
    );
    expect(item.name).toMatch(/^\d{4}-\d{2}-\d{2}-pilot-conv_012\.md$/);
    expect(item.content).toContain("source: pilot\nfrom: pilot\nfrom_kind: agent\nkind: pilot-chat");
    expect(item.content).toContain("stream: pilot\nkey: conv_0123456789\nseq: 1788732000000");
    expect(item.content).toContain("user: anything new today?");
    expect(item.content).toContain("pilot: Two things landed. [tool: recent] [tool: status]");
    expect(item.content).toContain("recognized speech");
  });

  test("turns spool durably, settle lands one segment, and the spool clears", async () => {
    const root = vault();
    expect(appendPilotTurn(root, "conv_aaaaaaaa", turn({ speaker: "user", text: "hello" }))).toBe(1);
    expect(appendPilotTurn(root, "conv_aaaaaaaa", turn({ speaker: "pilot", text: "Hi. Nothing new." }))).toBe(2);
    const file = join(pilotSpoolDir(root), "conv_aaaaaaaa.jsonl");
    expect(existsSync(file)).toBe(true);
    expect(readPilotTurns(root, "conv_aaaaaaaa")).toHaveLength(2);
    const receipt = await settlePilotConversation(root, "conv_aaaaaaaa", new Date("2026-09-06T22:10:00Z"));
    expect(receipt?.path).toMatch(/^log\/insertions\//);
    expect(existsSync(file)).toBe(false);
    const ev = readSourceInsertionLog(root).find((e) => e.id === receipt!.insertionId)!;
    const env = ev.envelope as Record<string, unknown>;
    expect(env["source"]).toBe("pilot");
    expect(env["from_kind"]).toBe("agent");
    expect(String(ev.body ?? readFileSync(join(root, receipt!.path), "utf8"))).toContain("user: hello");
    expect(await settlePilotConversation(root, "conv_aaaaaaaa")).toBeNull();
  });

  test("the sweep lands only conversations quiet past the settle window", async () => {
    const root = vault();
    appendPilotTurn(root, "conv_stale000", turn({ speaker: "user", text: "old" }));
    appendPilotTurn(root, "conv_fresh000", turn({ speaker: "user", text: "new" }));
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(pilotSpoolDir(root), "conv_stale000.jsonl"), old, old);
    expect(await sweepPilotSpool(root, new Date(), 5 * 60_000)).toEqual(["conv_stale000"]);
    expect(readPilotTurns(root, "conv_fresh000")).toHaveLength(1);
  });


});
