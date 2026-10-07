/** HTTP assertion retrieval and parity with the viewer, independent of agent plugins. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApiHandler } from "../lib/api";
import { mintToken } from "../lib/auth";
import {
  appendSourceInsertionEvent,
  insertionEventRel,
  type SourceInsertion,
} from "../lib/insertionLog";
import {
  appendAssertionEvent,
  assertionEntityId,
  createAssertionEvent,
  type AssertionAppendResult,
} from "../lib/assertionLog";
import { insertion } from "./support/vault";
import { viewerAuth } from "./support/viewerSession";

let root: string;
let home: string;
let storePath: string;
let token: string;
let base: string;
let server: ReturnType<typeof Bun.serve>;

// The fixture record, shared by every case: four immutable arrivals, three
// assertions over them, one projected entity. `fieldnote` is cited by NO
// assertion (a fresh arrival triage hasn't reached) and `budget` mentions no
// entity — both are real states of a live vault, not corpus padding.
const source = (id: string, title: string, body: string, received: string): SourceInsertion =>
  insertion({
    id,
    source_id: `src-${id.slice(4, 8)}`,
    author: { kind: "service", id: "granola" },
    title,
    body,
    envelope: { category: "meeting" },
    received_at: received,
  });

const kickoff = source(
  `ins_${"a".repeat(24)}`,
  "Migration kickoff",
  "Briar walked the room through the migration plan for the vault, phase by phase.",
  "2026-08-10T09:00:00.000Z"
);
const staffing = source(
  `ins_${"b".repeat(24)}`,
  "Staffing thread",
  "Long thread. Briar asked for a second engineer before the September cutover.",
  "2026-08-14T15:30:00.000Z"
);
const fieldnote = source(
  `ins_${"c".repeat(24)}`,
  "Conference field note",
  "Ran into Briar at the conference booth; nothing filed from this yet.",
  "2026-08-16T18:00:00.000Z"
);
const budget = source(
  `ins_${"d".repeat(24)}`,
  "Quarterly budget review",
  "Quarterly numbers only. The launch moved to September.",
  "2026-08-16T19:00:00.000Z"
);
const SOURCES = [kickoff, staffing, fieldnote, budget];
const rel = (s: SourceInsertion): string => insertionEventRel(s);
// The projected entity's own hit — the virtual note both note doors serve.
const entPath = `projection/entities/${assertionEntityId("Briar Calder")}.md`;

let owns: AssertionAppendResult;

interface Run {
  code: number;
  out: string;
  err: string;
}

/** Exercise the retained HTTP API directly; local plugins now use MCP. */
async function callApi(operation: string, args: string[] = [], env: Record<string, string> = {}): Promise<Run> {
  let credential: string;
  try { credential = JSON.parse(readFileSync(env.BIGBRAIN_CLIENT_TOKENS ?? storePath, "utf8"))[base].token; }
  catch { return { code: 1, out: "", err: "not connected" }; }
  const params = new URLSearchParams();
  let paths = [""];
  if (operation === "search") {
    params.set("q", args[0] ?? "");
    if (args[1] && !args[1].includes("=")) params.set("n", args[1]);
    for (const arg of args.slice(1)) if (arg.includes("=")) { const i = arg.indexOf("="); params.set(arg.slice(0, i), arg.slice(i + 1)); }
  } else if (operation === "note") paths = args;
  else if (args[0]) params.set("path", args[0]);
  const out: string[] = [];
  for (const path of paths) {
    if (path) params.set("path", path);
    const r = await fetch(`${base}/v1/${operation}?${params}`, { headers: { Authorization: `Bearer ${credential}` } });
    if (!r.ok) return { code: 1, out: "", err: "refused" };
    out.push(await r.text());
  }
  return { code: 0, out: out.join("\n"), err: "" };
}

interface Hits {
  hits: { path: string; title: string; snippet: string; score: number; date: string }[];
}

async function searchPaths(args: string[]): Promise<string[]> {
  const r = await callApi("search", args);
  expect(r.code).toBe(0);
  return (JSON.parse(r.out) as Hits).hits.map((h) => h.path);
}

beforeAll(() => {
  // These select a projection DB OUTSIDE the fixture root when set; a
  // well-behaved test file clears them after itself, but this fixture must
  // not depend on which file ran before it.
  delete process.env["BIGBRAIN_SEARCH_DB"];
  delete process.env["BIGBRAIN_ASSERTION_DB"];

  root = mkdtempSync(join(tmpdir(), "bb-plugin-native-vault-"));
  home = mkdtempSync(join(tmpdir(), "bb-plugin-native-home-"));
  for (const s of SOURCES) appendSourceInsertionEvent(root, s);

  const byId = new Map(SOURCES.map((s) => [s.id, s]));
  const briar = { id: assertionEntityId("Briar Calder"), label: "Briar Calder" };
  const assert = (text: string, entities: (typeof briar)[], sources: string[], minute: number) =>
    appendAssertionEvent(root, createAssertionEvent({
      text,
      entities,
      sources,
      author: { kind: "model", id: "test", invocation_id: `run-${minute}` },
      confidence: "direct",
      created_at: `2026-08-18T12:0${minute}:00.000Z`,
      produced_by: { procedure: "test", version: "v1" },
    }, byId));
  owns = assert(`[[${briar.id}|Briar Calder]] owns the vault migration plan.`, [briar], [kickoff.id], 1);
  assert(`[[${briar.id}|Briar Calder]] asked for a second engineer.`, [briar], [staffing.id], 2);
  assert("The launch moved to September in the quarterly review.", [], [budget.id], 3);

  // The regenerated working set (#459's shape): memory claims cite assertion
  // ids, and memory/ is the only Markdown this vault has.
  mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(
    join(root, "memory", "MEMORY.md"),
    `# Memory\n\n- Briar Calder owns the migration (${owns.event.id}). See [[memory/migration]].\n`
  );
  writeFileSync(
    join(root, "memory", "migration.md"),
    `# Migration\n\nThe vault migration, phase by phase. Grounded in ${owns.event.id}.\n`
  );

  storePath = join(mkdtempSync(join(tmpdir(), "bb-plugin-native-store-")), "client-tokens.json");
  const hostStore = join(mkdtempSync(join(tmpdir(), "bb-plugin-native-tokens-")), "tokens.json");
  token = mintToken(hostStore, root, "claude code", ["inbox:write", "vault:read"], {
    owner: "nick@example.com",
    kind: "agent",
  }).token;

  server = Bun.serve({ port: 0, fetch: makeApiHandler({ root, storePath: hostStore, log: () => {} }) });
  base = `http://127.0.0.1:${server.port}`;
  writeFileSync(
    storePath,
    JSON.stringify({ [base]: { token, name: "claude code", saved: "2026-08-20T00:00:00Z" } }, null, 2) + "\n"
  );
});

afterAll(() => server.stop(true));

describe("search on an assertion-native vault", () => {
  test("a person query answers the entity itself first, then its grounded sources", async () => {
    const r = await callApi("search", ["briar", "20"]);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.out) as Hits;
    // The entity leads; its cited sources follow; the uncited arrival last.
    expect(body.hits.map((h) => h.path)).toEqual([entPath, rel(kickoff), rel(staffing), "memory/MEMORY.md", rel(fieldnote)]);
    // The entity hit wears its newest evidence: snippet from the latest
    // assertion (wikilinks flattened), date from that assertion's source.
    // Its claims rest on meetings, so the snippet is fenced as data (lib/agentReads.ts).
    expect(body.hits[0]).toEqual(expect.objectContaining({
      path: entPath,
      title: "Briar Calder",
      date: "2026-08-14",
      snippet: "<untrusted-data>Briar Calder asked for a second engineer.</untrusted-data>",
      provenance: expect.objectContaining({ kind: "entity", trusted: false }),
    }));
    expect(body.hits[1]).toEqual(expect.objectContaining({
      path: `log/insertions/2026-08/${kickoff.id}.json`,
      title: "Migration kickoff",
      date: "2026-08-10",
    }));
    // The entity-grounded snippet is the assertion, wikilinks flattened.
    expect(body.hits[1]!.snippet).toBe("<untrusted-data>Briar Calder owns the vault migration plan.</untrusted-data>");
  });

  test("an entity-label term answers the entity and its assertion-grounded sources", async () => {
    // "calder" appears in no source title or body — only in the entity label
    // and assertion text. Every hit is still an openable path.
    expect(await searchPaths(["calder", "20"])).toEqual([entPath, rel(kickoff), rel(staffing), "memory/MEMORY.md"]);
  });

  test("memory summaries are discoverable alongside their underlying source records", async () => {
    const paths = await searchPaths(["migration", "20"]);
    expect(paths).toEqual(["memory/migration.md", rel(kickoff), "memory/MEMORY.md"]);
    const result = JSON.parse((await callApi("search", ["migration", "20"])).out);
    expect(result.hits.filter((h: { path: string }) => h.path.startsWith("memory/")).every((h: { evidence: string }) => h.evidence === "memory")).toBe(true);
  });

  test("date filters bound by the source's own date; the entity by its newest evidence", async () => {
    expect(await searchPaths(["briar", "20", "after=2026-08-12"])).toEqual([
      entPath,
      rel(staffing),
      rel(fieldnote),
    ]);
    // The entity's newest evidence (2026-08-14) is past the bound, so the
    // entity row drops with it.
    expect(await searchPaths(["briar", "20", "before=2026-08-12"])).toEqual([rel(kickoff)]);
  });

  test("type=entity keeps the entity and its sources; type=reference drops them", async () => {
    expect(await searchPaths(["calder", "20", "type=entity"])).toEqual([entPath, rel(kickoff), rel(staffing)]);
    expect(await searchPaths(["calder", "20", "type=reference"])).toEqual([]);
  });

  test("n bounds the result count", async () => {
    expect(await searchPaths(["briar", "1"])).toEqual([entPath]);
  });

  test("a query the record does not cover returns cleanly empty", async () => {
    const r = await callApi("search", ["xylophone"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ hits: [], applied_filters: {}, only_agent_records: false });
  });
});

describe("note opens what search returned", () => {
  test("every hit path for the smoke query is accepted, in one call", async () => {
    const paths = await searchPaths(["briar", "20"]);
    expect(paths).toHaveLength(5);
    const r = await callApi("note", paths);
    expect(r.code).toBe(0);
    const notes = r.out
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { path: string; title: string; markdown: string });
    expect(notes.map((n) => n.path)).toEqual(paths);
    // The entity hit opens as its projection note — the agent door's virtual
    // twin of the viewer's entity view.
    expect(notes[0]!.title).toBe("Briar Calder");
    expect(notes[0]!.markdown).toContain("# Briar Calder");
    expect(notes[0]!.markdown).toContain("asked for a second engineer");
    expect(notes[1]!.title).toBe("Migration kickoff");
    expect(notes[1]!.markdown).toContain("migration plan for the vault");
    // The rendered source carries its provenance frontmatter.
    expect(notes[1]!.markdown).toContain(`insertion_id: ${JSON.stringify(kickoff.id)}`);
  });

  test("an insertion path outside the exact source shape stays refused", async () => {
    const r = await callApi("note", ["log/insertions/2026-08/../../vault.yaml"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
  });
});

describe("memory reads the regenerated working set", () => {
  test("no argument → the index, citing assertion ids", async () => {
    const r = await callApi("memory", []);
    expect(r.code).toBe(0);
    expect(r.out).toContain("# Memory");
    expect(r.out).toContain(owns.event.id);
    expect(r.out).toContain("[[memory/migration]]");
  });

  test("a slug → that topic file", async () => {
    const r = await callApi("memory", ["migration"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("phase by phase");
  });


});

describe("auth refusal precedes the projection", () => {
  test("a bad token → the refusal line, no results", async () => {
    const other = join(mkdtempSync(join(tmpdir(), "bb-plugin-native-bad-")), "client-tokens.json");
    writeFileSync(
      other,
      JSON.stringify({ [base]: { token: "bb_deadbeef_nope", name: "claude code", saved: "x" } }, null, 2) + "\n"
    );
    const r = await callApi("search", ["briar"], { BIGBRAIN_CLIENT_TOKENS: other });
    expect(r.code).toBe(1);
    expect(r.err).toContain("refused");
    expect(r.out).toBe("");
  });

  test("no credential at all → not connected, no results", async () => {
    const r = await callApi("search", ["briar"], {
      BIGBRAIN_CLIENT_TOKENS: join(home, "absent.json"),
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("not connected");
    expect(r.out).toBe("");
  });
});

describe("retrieval parity with the UI door (#456)", () => {
  // The viewer is its own PROCESS on its own port — web/server.ts binds its
  // vault root at import, so parity is measured against the real second door,
  // not scanSurface called twice in one process.
  let web: { url: string; proc: ReturnType<typeof Bun.spawn>; auth: () => Record<string, string> };

  beforeAll(async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port;
    probe.stop(true);
    const proc = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", "web", "server.ts")],
      {
        env: {
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          HOME: home,
          BIGBRAIN_VAULT: root,
          PORT: String(port),
        },
        stdout: "ignore",
        stderr: "pipe",
      }
    );
    web = { url: `http://127.0.0.1:${port}`, proc, auth: () => viewerAuth(home, port) };
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${web.url}/api/search?q=&limit=1`, { headers: web.auth() })).ok) return;
      } catch {
        /* not listening yet */
      }
      if (i > 100) throw new Error(`web viewer never came up on ${web.url}`);
      await Bun.sleep(50);
    }
  });

  afterAll(() => web.proc.kill());

  test("the representative corpus has the same hits on both doors, with UI navigation ranking", async () => {
    for (const q of ["briar", "calder", "migration", "second engineer", "september"]) {
      const plugin = await searchPaths([q, "20"]);
      const res = await fetch(`${web.url}/api/search?q=${encodeURIComponent(q)}&limit=20`, { headers: web.auth() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { hits: { note: { path: string } }[] };
      // The UI deliberately promotes navigation targets after the shared search.
      // Its ranking can differ, but neither door may lose or invent a hit.
      expect(body.hits.map((h) => h.note.path).sort()).toEqual([...plugin].sort());
    }
  });
});
