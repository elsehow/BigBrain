import { ConnectedClients } from "../lib/connectedClients";
/** mcp.test.ts — the BigBrain MCP server (#87).
 *
 * The invariants: the tool listing stays under the 1k-token budget (a hard
 * line from the issue); every tool is a stateless one-shot over the same
 * engine functions the other doors run (read_note IS /v1/note's payload,
 * next/submit ARE lib/work.ts); submit mints entities host-side and rejects
 * per item; gardener traffic is ledgered as machine `via` (#502); and
 * client registration merges without clobbering a stranger's config.
 * The stdio test speaks real JSON-RPC to a spawned server — the MCP
 * Inspector round-trip, shrunk to a test.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceInsertion } from "../lib/insertionLog";
import { appendAssertionEvent, assertionEntityId, createAssertionEvent } from "../lib/assertionLog";
import { handleMcpTool, MCP_INSTRUCTIONS, mcpToolList, McpToolError, type McpContext } from "../lib/mcp";
import { handleVaultTool } from "../lib/vaultTools";
import { MCP_CLIENTS, mcpServerEntry, registerMcpClients } from "../lib/mcpRegister";
import type { IntakeJob, WorkItem } from "../lib/work";
import { insertionSeq, nativeVault, NATIVE_YAML } from "./support/vault";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const insertion = insertionSeq();

/** A native-flagged scratch vault with a memory tree and a curated note. */
const vault = (...insertions: SourceInsertion[]): string => {
  const root = nativeVault({
    prefix: "bb-mcp-",
    insertions,
    files: {
      "vault.yaml": NATIVE_YAML,
      "memory/MEMORY.md": "# Memory index\n- [[memory/ridgeways]]\n",
      "memory/ridgeways.md": "# Ridgeways\nThe topic body.\n",
      "entities/ada-lovelace.md": "# Ada Lovelace\nDossier.\n",
      "references/curated.md": "---\ntitle: Curated note\n---\nSee [[ada-lovelace]] for the dossier.\n",
    },
  });
  scratch.push(root);
  return root;
};

const ctx = (root: string, via: McpContext["via"] = "cli"): McpContext => ({
  root,
  via,
  clientName: "test-client",
});

describe("the tool listing", () => {
  test("stays under the 1k-token budget and lists the four public tools in order", () => {
    const tools = mcpToolList();
    expect(tools.map((t) => t.name)).toEqual([
      "load_memory", "search_vault", "read_note", "drop",
    ]);
    // ~4 chars/token: the full wire listing must stay under 1k tokens (#87).
    const chars = JSON.stringify(tools).length;
    expect(chars).toBeLessThan(4_000);
    expect(MCP_INSTRUCTIONS.length).toBeLessThan(1_200);
  });
});

test("public dispatch refuses maintenance tools even for a machine caller", () => {
  for (const name of ["next", "open", "submit", "read_intake", "write_memory", "edit_memory", "delete_memory"])
    expect(() => handleMcpTool(ctx(vault(), "gardener"), name, {})).toThrow("no such tool");
});

describe("load_memory", () => {
  test("returns the index, a topic, and refuses what is not there", () => {
    const root = vault();
    expect(handleMcpTool(ctx(root), "load_memory", {})).toContain("# Memory index");
    expect(handleMcpTool(ctx(root), "load_memory", { topic: "ridgeways" })).toContain("The topic body");
    expect(() => handleMcpTool(ctx(root), "load_memory", { topic: "nope" })).toThrow(McpToolError);
    expect(() => handleMcpTool(ctx(root), "load_memory", { topic: "../.env" })).toThrow(McpToolError);
  });
});

describe("search_vault", () => {
  test("a fresh flagged vault searches its drops; hits open with read_note", () => {
    const a = insertion();
    const root = vault(a);
    const r = handleMcpTool(ctx(root), "search_vault", { query: "sparse probes" }) as {
      hits: { path: string; title: string }[];
    };
    expect(r.hits.length).toBeGreaterThanOrEqual(1);
    const note = handleMcpTool(ctx(root), "read_note", { path: r.hits[0]!.path }) as { markdown: string };
    expect(note.markdown).toContain("sparse probes");
  });

  test("validates its parameters like /v1/search", () => {
    const root = vault();
    expect(() => handleMcpTool(ctx(root), "search_vault", {})).toThrow("missing query");
    expect(() => handleMcpTool(ctx(root), "search_vault", { query: "x", after: "nope" })).toThrow("YYYY-MM-DD");
    expect(() => handleMcpTool(ctx(root), "search_vault", { query: "x", type: "everything" })).toThrow(McpToolError);
  });

  test("gardener traffic is ledgered as machine via (#502)", () => {
    const root = vault(insertion());
    handleMcpTool(ctx(root, "gardener"), "search_vault", { query: "sparse probes" });
    const month = new Date().toISOString().slice(0, 7);
    const ledger = readFileSync(join(root, "journal", "retrieval", `${month}.jsonl`), "utf8");
    expect(ledger).toContain('"via":"gardener"');
  });
});

describe("read_note", () => {
  test("an entity is windowed by q / n / order / after, the same knobs as /v1/note", () => {
    const a = insertion({ title: "Plan session" });
    const root = vault(a);
    const bb = { id: assertionEntityId("BigBrain"), label: "BigBrain" };
    for (const [text, created_at] of [
      ["deploys from one main branch.", "2026-08-12T10:00:00.000Z"],
      ["pricing was reopened.", "2026-08-23T10:00:00.000Z"],
    ] as const)
      appendAssertionEvent(root, createAssertionEvent({
        text: `[[${bb.id}|BigBrain]] ${text}`,
        entities: [bb],
        sources: [a.id],
        author: { kind: "model", id: "test", invocation_id: "run-1" },
        confidence: "direct",
        created_at,
        produced_by: { procedure: "test", version: "v1" },
      }, new Map([[a.id, a]])));
    const path = `projection/entities/${bb.id}.md`;
    type Note = { markdown: string; assertions_total: number; assertions_shown: number };
    const whole = handleMcpTool(ctx(root), "read_note", { path }) as Note;
    expect(whole.assertions_total).toBe(2);
    expect(whole.assertions_shown).toBe(2);
    const q = handleMcpTool(ctx(root), "read_note", { path, q: "pricing" }) as Note;
    expect(q.assertions_shown).toBe(1);
    expect(q.markdown).toContain("pricing");
    expect(q.markdown).not.toContain("deploys");
    const newest = handleMcpTool(ctx(root), "read_note", { path, n: 1, order: "desc" }) as Note;
    expect(newest.markdown).toContain("pricing");
    expect(newest.markdown).not.toContain("deploys");
    const old = handleMcpTool(ctx(root), "read_note", { path, before: "2026-08-15" }) as Note;
    expect(old.markdown).toContain("deploys");
    expect(() => handleMcpTool(ctx(root), "read_note", { path, after: "nope" })).toThrow("YYYY-MM-DD");
  });

  test("toc maps the dossier by date; every bucket's handle is a window this tool takes", () => {
    const a = insertion({ title: "Plan session" });
    const root = vault(a);
    const bb = { id: assertionEntityId("BigBrain"), label: "BigBrain" };
    for (const day of ["2026-06-02", "2026-07-11", "2026-08-23"])
      appendAssertionEvent(root, createAssertionEvent({
        text: `[[${bb.id}|BigBrain]] a claim from ${day}.`,
        entities: [bb],
        sources: [a.id],
        author: { kind: "model", id: "test", invocation_id: "run-1" },
        confidence: "direct",
        created_at: `${day}T10:00:00.000Z`,
        produced_by: { procedure: "test", version: "v1" },
      }, new Map([[a.id, a]])));
    const path = `projection/entities/${bb.id}.md`;
    const toc = handleMcpTool(ctx(root), "read_note", { path, toc: true }) as { markdown: string };
    expect(toc.markdown).toContain("Table of contents: 3 assertions");
    expect(toc.markdown).toContain("## 2026-08 — 1 assertion (2026-08-23)");
    expect(toc.markdown).toContain("`after=2026-06-02 before=2026-06-02`");
    const bucket = handleMcpTool(ctx(root), "read_note", {
      path, after: "2026-06-02", before: "2026-06-02",
    }) as { assertions_shown: number };
    expect(bucket.assertions_shown).toBe(1);
  });

  test("q windows a non-entity note to its matching blocks, with slack for context", () => {
    const root = vault();
    writeFileSync(
      join(root, "references", "session.md"),
      "---\ntitle: Session\n---\n" +
        Array.from({ length: 60 }, (_, i) => (i === 30 ? "the needle turn" : `filler ${i}`)).join("\n\n")
    );
    type Windowed = { markdown: string; blocks_total: number; blocks_matched: number; blocks_shown: number };
    const w = handleMcpTool(ctx(root), "read_note", { path: "references/session.md", q: "needle" }) as Windowed;
    expect(w.blocks_total).toBe(60);
    expect(w.blocks_matched).toBe(1);
    expect(w.blocks_shown).toBe(5);
    expect(w.markdown).toContain("the needle turn");
    expect(w.markdown).toContain("elided");
    expect(w.markdown).not.toContain("filler 0");
    const tight = handleMcpTool(ctx(root), "read_note", {
      path: "references/session.md", q: "needle", slack: 0,
    }) as Windowed;
    expect(tight.blocks_shown).toBe(1);
    // An unwindowed read is untouched — the counters only appear on a window.
    const whole = handleMcpTool(ctx(root), "read_note", { path: "references/session.md" }) as Windowed;
    expect(whole.blocks_total).toBeUndefined();
    expect(whole.markdown).toContain("filler 0");
  });

  test("serves the /v1/note payload: frontmatter parsed, wikilinks resolved", () => {
    const root = vault();
    const note = handleMcpTool(ctx(root), "read_note", { path: "references/curated.md" }) as {
      title: string;
      markdown: string;
      links: { name: string; path: string | null }[];
    };
    expect(note.title).toBe("Curated note");
    expect(note.markdown).toContain("dossier");
    expect(note.links).toEqual([{ name: "ada-lovelace", path: "entities/ada-lovelace.md" }]);
  });

  test("a huge note is sliced with start/chars, never silently clipped (#514)", () => {
    const root = vault();
    writeFileSync(
      join(root, "references", "big.md"),
      `---\ntitle: Big note\n---\n${"a".repeat(60_000)}TAIL`
    );
    const first = handleMcpTool(ctx(root), "read_note", { path: "references/big.md" }) as {
      markdown: string; markdown_length: number; truncated: boolean; end: number;
    };
    expect(first.truncated).toBe(true);
    expect(first.markdown.length).toBe(40_000);
    expect(first.markdown_length).toBeGreaterThan(60_000);
    const rest = handleMcpTool(ctx(root), "read_note", { path: "references/big.md", start: first.end, chars: 80_000 }) as {
      markdown: string; truncated: boolean;
    };
    expect(rest.truncated).toBe(false);
    expect(rest.markdown.endsWith("TAIL")).toBe(true);
    const whole = handleMcpTool(ctx(root), "read_note", { path: "references/curated.md" }) as Record<string, unknown>;
    expect(whole["truncated"]).toBeUndefined();
  });

  test("the read jail holds", () => {
    const root = vault();
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    expect(() => handleMcpTool(ctx(root), "read_note", { path: "../outside.md" })).toThrow(McpToolError);
    expect(() => handleMcpTool(ctx(root), "read_note", { path: ".env" })).toThrow(McpToolError);
    // memory/ IS readable here now — the memory index prints [[memory/slug]]
    // and this door must open what the system prints — but only through its
    // own one-tree jail: nothing outside memory/ arrives by way of it.
    expect(() => handleMcpTool(ctx(root), "read_note", { path: "memory/../.env" })).toThrow(McpToolError);
    mkdirSync(join(root, "prompts"), { recursive: true });
    writeFileSync(join(root, "prompts", "intake.md"), "# The intake prompt\n");
    expect(() =>
      handleMcpTool(ctx(root), "read_note", { path: "memory/../prompts/intake.md" })
    ).toThrow(McpToolError);
  });

  test("a memory path the index advertises opens here, links resolved", () => {
    // The session-start surface prints `[[memory/ridgeways]]`; a reader that
    // followed it got "not a readable vault path" until the note door served
    // the tree its own jail already held.
    const root = vault();
    const note = handleMcpTool(ctx(root), "read_note", { path: "memory/MEMORY.md" }) as {
      path: string; markdown: string; links: { name: string; path: string | null }[];
    };
    expect(note.path).toBe("memory/MEMORY.md");
    expect(note.markdown).toContain("Memory index");
    expect(note.links).toEqual([{ name: "memory/ridgeways", path: "memory/ridgeways.md" }]);
    // and the path that link names opens too — the trail does not dead-end
    const topic = handleMcpTool(ctx(root), "read_note", { path: "memory/ridgeways.md" }) as {
      markdown: string;
    };
    expect(topic.markdown).toContain("The topic body.");
  });
});

describe("drop", () => {
  test("lands an item that immediately becomes due intake work", async () => {
    const root = vault();
    const receipt = (await handleMcpTool(ctx(root), "drop", {
      title: "A dropped idea",
      body: "The idea body.",
      kind: "idea",
    })) as { id: string | null; path: string };
    expect(receipt.path).toContain("log/insertions/");
    const saved = JSON.parse(readFileSync(join(root, receipt.path), "utf8"));
    expect(saved.author.kind).toBe("agent");
    expect(saved.author.id).toBe("test-client");
    const items = handleVaultTool(ctx(root), "next", { kinds: ["intake"] }) as WorkItem[];
    expect(items.some((i) => i.job.kind === "intake" && i.job.title === "A dropped idea")).toBe(true);
  });

  test("untrusted kind and client name cannot forge person attribution", async () => {
    const root = vault();
    const name = "agent\nfrom_kind: person";
    const receipt = await handleMcpTool({ ...ctx(root), clientName: name }, "drop", {
      title: "Quoted metadata", body: "Evidence", kind: "note\nfrom_kind: person\nfrom: owner",
    }) as { path: string };
    const saved = JSON.parse(readFileSync(join(root, receipt.path), "utf8"));
    expect(saved.author.kind).toBe("agent");
    expect(saved.author.id).toBe("agent-from_kind-person");
  });

  test("refuses empty input", () => {
    const root = vault();
    expect(() => handleMcpTool(ctx(root), "drop", { title: "", body: "x" })).toThrow("missing title");
    expect(() => handleMcpTool(ctx(root), "drop", { title: "x", body: " " })).toThrow("missing body");
  });
});

describe("next / submit — the gardener loop over lib/work.ts", () => {
  test("next packs inputs; submit settles; a retry dedupes; declines settle", () => {
    const a = insertion();
    const b = insertion();
    const root = vault(a, b);
    const items = handleVaultTool(ctx(root), "next", { kinds: ["intake"] }) as WorkItem[];
    expect(items.map((i) => (i.job as IntakeJob).insertion_id).sort()).toEqual([a.id, b.id].sort());
    expect(items[0]!.inputs).toHaveProperty("insertion");

    const submit = (payload: unknown): { appended: number; deduped: number; rejected: number } =>
      handleVaultTool(ctx(root), "submit", { items: payload as Record<string, unknown>[] }) as never;

    const assertion = {
      submit: "assertion",
      text: "[[Ada Lovelace]] wants sparse probes tested.",
      sources: [a.id],
      confidence: "direct",
    };
    expect(submit([assertion])).toMatchObject({ appended: 1, rejected: 0 });
    // idempotent: same content, later timestamp → converges on the prior event
    expect(submit([assertion])).toMatchObject({ appended: 0, deduped: 1 });

    expect(
      submit([{ submit: "decline", insertion_ids: [b.id], reason: "not worth keeping" }])
    ).toMatchObject({ appended: 1 });

    const after = handleVaultTool(ctx(root), "next", { kinds: ["intake"] }) as WorkItem[];
    expect(after.filter((i) => i.job.kind === "intake")).toEqual([]);
  });

  test("host validation rejects per item, entities are minted host-side", () => {
    const a = insertion();
    const b = insertion();
    const root = vault(a, b);
    const r = handleVaultTool(ctx(root), "submit", {
      items: [
        { submit: "assertion", text: "[[Ada Lovelace]] ok.", sources: [a.id], confidence: "maybe" },
        { submit: "assertion", text: "[[ent_00000000000000000000|ghost]] link.", sources: [b.id], confidence: "direct" },
        { submit: "assertion", text: "[[Ada Lovelace]] fine.", sources: [b.id], confidence: "direct" },
      ],
    }) as { results: { index: number; ok: boolean; error?: string }[]; appended: number; rejected: number };
    expect(r.appended).toBe(1);
    expect(r.rejected).toBe(2);
    expect(r.results.map((x) => x.index)).toEqual([0, 1, 2]);
    expect(r.results[0]!.error).toContain("confidence");
    expect(r.results[1]!.error).toContain("unknown projected entity");
    expect(r.results[2]!.ok).toBe(true);
  });

  test("bad kinds, bad limits, and empty batches refuse loudly", () => {
    const root = vault();
    expect(() => handleVaultTool(ctx(root), "next", { kinds: ["editor"] })).toThrow(McpToolError);
    expect(() => handleVaultTool(ctx(root), "next", { limit: 0 })).toThrow(McpToolError);
    expect(() => handleVaultTool(ctx(root), "next", { limit: 99 })).toThrow(McpToolError);
    expect(() => handleVaultTool(ctx(root), "submit", { items: [] })).toThrow("non-empty");
    expect(() => handleMcpTool(ctx(root), "no_such_tool", {})).toThrow("no such tool");
  });
});

describe("register — desktop client wiring", () => {
  test("probes by client directory, merges without clobbering, verifies", () => {
    const home = mkdtempSync(join(tmpdir(), "bb-mcp-home-"));
    scratch.push(home);
    const root = vault();

    // nothing installed → every client skipped, nothing written
    const none = registerMcpClients(root, { home });
    expect(none.map((r) => r.status)).toEqual(["not-installed", "not-installed", "not-installed"]);

    // Cursor "installed", with an existing config a stranger owns
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({ keep: 1, mcpServers: { other: { command: "x" } } })
    );
    const results = registerMcpClients(root, { home, only: ["cursor"] });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("registered");
    const config = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    expect(config.keep).toBe(1);
    expect(config.mcpServers.other).toEqual({ command: "x" });
    expect(config.mcpServers.bigbrain.env).toEqual({ BIGBRAIN_VAULT: root });
    // dev fallback: no ~/.local/bin/bigbrain under this home → bun + cli.ts
    expect(config.mcpServers.bigbrain.args.at(-1)).toBe("mcp");
    expect(config.mcpServers.bigbrain.args.at(-2)).toContain("bin/cli.ts");
  });

  test("prefers the installed bigbrain symlink when it exists", () => {
    const home = mkdtempSync(join(tmpdir(), "bb-mcp-home-"));
    scratch.push(home);
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "bigbrain"), "#!/bin/sh\n");
    const entry = mcpServerEntry("/some/vault", home);
    expect(entry.command).toBe(join(home, ".local", "bin", "bigbrain"));
    expect(entry.args).toEqual(["mcp"]);
  });

  test("the probe table names the three shell-less clients", () => {
    expect(MCP_CLIENTS.map((c) => c.key)).toEqual(["claude-desktop", "cursor", "windsurf"]);
  });
});

describe("stdio round-trip", () => {
  test("initialize → tools/list → tools/call against a spawned server", async () => {
    const root = vault();
    const store=join(root,".tokens"), clients=new ConnectedClients(root,store), setup=clients.create({name:"test-client",kind:"generic"});
    const proc = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", "bin", "mcp.ts")],
      {
        env: { ...process.env, BIGBRAIN_VAULT: root, BIGBRAIN_TOKENS:store, BIGBRAIN_MCP_TOKEN:clients.token(setup.id) },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const send = (msg: Record<string, unknown>): void => {
      proc.stdin.write(`${JSON.stringify(msg)}\n`);
      proc.stdin.flush();
    };
    const responses = new Map<number, { result?: Record<string, never> }>();
    const reader = (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stdout) {
        buf += decoder.decode(chunk);
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (typeof msg.id === "number") responses.set(msg.id, msg);
        }
      }
    })();
    const waitFor = async (id: number): Promise<Record<string, never>> => {
      for (let i = 0; i < 200; i++) {
        const r = responses.get(id);
        if (r) return r.result ?? ({} as Record<string, never>);
        await Bun.sleep(25);
      }
      throw new Error(`no response ${id}`);
    };
    try {
      send({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0" },
        },
      });
      const init = (await waitFor(1)) as { serverInfo?: { name: string }; instructions?: string };
      expect(init.serverInfo?.name).toBe("bigbrain");
      expect(init.instructions).toContain("load_memory");
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const list = (await waitFor(2)) as { tools?: { name: string }[] };
      expect(list.tools?.map((t) => t.name)).toEqual(["load_memory", "search_vault", "read_note", "drop"]);
      send({
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "load_memory", arguments: {} },
      });
      const call = (await waitFor(3)) as { content?: { text: string }[]; isError?: boolean };
      expect(call.isError).toBeFalsy();
      expect(call.content?.[0]?.text).toContain("# Memory index");
    } finally {
      proc.kill();
      await reader.catch(() => {});
    }
  }, 20_000);
});

test('development setup launches the candidate engine and preserves an isolated credential store', () => {
  const home=mkdtempSync(join(tmpdir(),'bb-mcp-candidate-'));
  const dev=process.env.BIGBRAIN_DEV,tokens=process.env.BIGBRAIN_TOKENS;
  try {
    mkdirSync(join(home,'.local/bin'),{recursive:true});writeFileSync(join(home,'.local/bin/bigbrain'),'older install');
    process.env.BIGBRAIN_DEV='1';process.env.BIGBRAIN_TOKENS=join(home,'tokens.json');
    const entry=mcpServerEntry('/scratch/vault',home);
    expect(entry.command).toBe(process.execPath);expect(entry.args[0]).toContain('bin/cli.ts');expect(entry.env.BIGBRAIN_TOKENS).toBe(join(home,'tokens.json'));
  } finally {
    if(dev===undefined)delete process.env.BIGBRAIN_DEV;else process.env.BIGBRAIN_DEV=dev;
    if(tokens===undefined)delete process.env.BIGBRAIN_TOKENS;else process.env.BIGBRAIN_TOKENS=tokens;
    rmSync(home,{recursive:true,force:true});
  }
});
