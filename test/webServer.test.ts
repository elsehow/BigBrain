import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

// The point of #260: importing web/server.ts is side-effect free — module
// scope declares, start() binds the socket, and only the entrypoint
// (import.meta.main) calls it. This import IS the regression test: before
// the split it would have opened a watcher, a heartbeat interval, and port
// 4747 under the test runner. The vault root resolves at import time via
// lib/manifest — test/preload.ts points it at a scratch vault (#635).
const server = await import("../web/server");
const { dispatch } = await import("../lib/httpx");
const { appendSourceInsertionEvent, insertionEventRel } = await import("../lib/insertionLog");
const { appendAssertionEvent, assertionEntityId, createAssertionEvent } = await import("../lib/assertionLog");
const { invalidateAssertionRecord } = await import("../lib/assertionEntityView");
const { insertion } = await import("./support/vault");

/** Drive one route against the preloaded scratch vault and parse what it
 * wrote. Enough for the shape of a payload; the byte-for-byte equivalence
 * of every route is checked against origin/main by hand (#639). */
function call(method: "GET" | "POST", path: string): unknown {
  let body = "";
  const res = { writeHead: () => {}, end: (b: string) => { body = b; } };
  expect(dispatch(server.ROUTES, { url: path, method } as never, res as never)).toBe(true);
  return JSON.parse(body);
}

describe("web/server.ts imports without listening", () => {
  test("search exposes a memory result as an openable row in the memory collection", async () => {
    const root = process.env["BIGBRAIN_VAULT"]!;
    const path = "memory/search-probe.md";
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, path), "# Curatedsearchprobe\nThe latest working context.");
    try {
      const payload = await new Promise<string>((resolve) => {
        const res = { writeHead: () => {}, end: resolve };
        expect(dispatch(server.ROUTES, { url: "/api/search?q=Curatedsearchprobe&limit=1", method: "GET" } as never, res as never)).toBe(true);
      });
      expect(JSON.parse(payload).hits).toMatchObject([
        { dir: "memory", evidence: "memory", title: "Curatedsearchprobe", note: { path } },
      ]);
      expect(call("GET", `/api/note?path=${path}`)).toMatchObject({ content: expect.stringContaining("latest working context") });
    } finally { rmSync(join(root, path), { force: true }); }
  });

  test("search pages preserve ranked order, expose continuation, and stop at the end", async () => {
    const root = process.env["BIGBRAIN_VAULT"]!;
    const paths = Array.from({ length: 7 }, (_, i) => `memory/paged-probe-${i}.md`);
    mkdirSync(join(root, "memory"), { recursive: true });
    paths.forEach((path, i) => writeFileSync(join(root, path), `# Pagedsearchprobe ${i}\nPagination fixture.`));
    const search = async (params: string) => JSON.parse(await new Promise<string>(resolve => {
      const res = { writeHead: () => {}, end: resolve };
      dispatch(server.ROUTES, { url: `/api/search?q=Pagedsearchprobe&${params}`, method: "GET" } as never, res as never);
    }));
    try {
      const whole = await search("limit=10");
      const first = await search("limit=3&offset=0");
      const second = await search(`limit=3&offset=${first.nextOffset}`);
      const last = await search(`limit=3&offset=${second.nextOffset}`);
      expect([first.hits.length, second.hits.length, last.hits.length]).toEqual([3, 3, 1]);
      expect([first.nextOffset, second.nextOffset, last.nextOffset]).toEqual([3, 6, null]);
      expect([...first.hits, ...second.hits, ...last.hits].map(h => h.note.path))
        .toEqual(whole.hits.map((h: { note: { path: string } }) => h.note.path));
      expect((await search("limit=3&offset=250")).hits).toEqual([]);
    } finally { paths.forEach(path => rmSync(join(root, path), { force: true })); }
  });

  test("start is the one door to a socket, and importing never opened it", () => {
    // No port probe here on purpose — a dev machine may legitimately run a
    // real viewer on 4747. The structural guarantee is what's pinned: the
    // module hands back start() instead of having already called it.
    expect(typeof server.start).toBe("function");
  });

  test("within: the path-traversal guard answers pure, no server running", () => {
    // a browse root resolves to an absolute path under the vault root
    expect(server.within("entities/ada-lovelace.md")).toContain(`${sep}entities${sep}`);
    expect(server.within("references/2026-08-02-granola-1.md")).toContain(`${sep}references${sep}`);
    // anything outside the browse roots is refused
    expect(server.within("lib/config.ts")).toBeNull();
    expect(server.within(".state/search.db")).toBeNull();
    expect(server.within("vault.yaml")).toBeNull();
    // and no dotted path escapes the vault
    expect(server.within("entities/../../../etc/passwd")).toBeNull();
  });
});

// #639 turned a 500-line `if` chain into a table. The surface it answers is
// now something you can READ, so it is also something a test can pin: a
// route silently dropped in a merge is the failure this catches, and it is
// exactly the failure the if-chain made invisible.
describe("the route table is the door's whole surface", () => {
  test("every route, with its method — a dropped one fails here", () => {
    expect(server.ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /",
      "GET /assets/*",
      "GET /api/vault",
      "GET /api/notes",
      "GET /api/note",
      "POST /api/note/briefing",
      "GET /api/source/read-state",
      "POST /api/source/read-state",
      "GET /api/file",
      "GET /api/recent",
      "GET /api/search",
      "GET /api/graph",
      "GET /api/note-log",
      "GET /api/note-messages",
      "GET /api/agents/models",
      // the pilot (#770): lib/pilot.ts, then lib/pilotTranscript.ts
      "GET /api/actions",
      "POST /api/pilot/permissions",
      "GET /api/pilot",
      "POST /api/pilot/key",
      "POST /api/pilot/enabled",
      "POST /api/pilot/secret",
      "GET /api/pilot/chat/actions",
      "GET /api/pilot/chat/image",
      "GET /api/pilot/chat/models",
      "POST /api/pilot/chat/image",
      "GET /api/pilot/chat",
      "GET /api/pilot/chat/session",
      "GET /api/pilot/chat/backend",
      "GET /api/pilot/chat/notifications",
      "POST /api/pilot/chat/notification-state",
      "POST /api/pilot/chat/create",
      "POST /api/pilot/chat/presence",
      "POST /api/pilot/chat/check",
      "POST /api/pilot/chat/draft",
      "POST /api/pilot/chat/discard",
      "POST /api/pilot/chat/send",
      "POST /api/pilot/chat/spoken",
      "POST /api/pilot/chat/backend",
      "POST /api/pilot/chat/deactivate",
      "POST /api/pilot/chat/stop-tree",
      "POST /api/pilot/chat/stop",
      "POST /api/pilot/chat/resume",
      "POST /api/pilot/chat/context",
      "POST /api/pilot/chat/context-add",
      "GET /api/pilot/work",
      "POST /api/pilot/work/approve",
      "POST /api/pilot/work/answer",
      "POST /api/pilot/work/stop",
      "POST /api/pilot/work/send",
      "GET /api/agent-orchestration",
      "POST /api/agent-orchestration/inspect",
      "POST /api/agent-orchestration/credentials",
      "POST /api/agent-orchestration/save",
      "POST /api/agent-orchestration/remove",
      "GET /api/connected-clients",
      "POST /api/connected-clients",
      "GET /api/integration-accounts",
      "POST /api/integration-accounts",
      "GET /api/tokens",
      "POST /api/tokens/revoke",
      "GET /api/pair",
      "POST /api/pair",
      "POST /api/drop",
      "POST /api/enqueue",
      "GET /api/usage",
      "GET /api/engine",
      "GET /api/entity/folds",
      "POST /api/entity/folds/accept",
      "POST /api/entity/folds/reject",
      "GET /api/config",
      "POST /api/config",
      "GET /api/events",
    ]);
  });

  test("GET /api/config answers the two passes in one shape — the shape a patch sends back", () => {
    // #643: the read used to answer `model` for the gardener and
    // `memory: { model }` for the other, and the patch spelled the first
    // `model` and the second `memoryModel` — three names for two passes.
    // vault.yaml's own spelling is the one that survived.
    const cfg = call("GET", "/api/config") as {
      integrations: unknown[];
      gardener: { agent: string; model: string };
      memory: { agent: string; model: string; interval: number };
      quick: { agent: string; model: string };
    };
    expect(Object.keys(cfg).sort()).toEqual(["curation", "gardener", "integrations", "memory", "quick"]);
    expect(typeof cfg.gardener.model).toBe("string");
    expect(typeof cfg.gardener.adapter).toBe("string");
    expect(typeof cfg.memory.model).toBe("string");
    expect(typeof cfg.memory.adapter).toBe("string");
    expect(typeof cfg.quick.model).toBe("string");
    // the sweep's cadence rides along, in ms — the manifest's number, default 1d
    expect(cfg.memory.interval).toBe(86_400_000);
  });

  test("the setup door is absent on a headless host", () => {
    // BIGBRAIN_DESKTOP is unset under the test runner, so the four
    // /api/setup* routes are not in the table at all — they 404 like any
    // other unknown path, which is what a headless host wants (the CLI is
    // its door, and the viewer's cards say so).
    expect(server.ROUTES.filter((r) => r.path.startsWith("/api/setup"))).toEqual([]);
  });

  test("no path is claimed twice by one method", () => {
    const keys = server.ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // #639: GET /api/queue is gone. Its only reader was the home feed's
  // column-head tooltip, and answering it built the whole due-set payload
  // — two journal walks, the memory stamp, the memory work scan, a third
  // journal walk and the observation mapping — for four numbers.
  test("the queue head rides on the vault index, and has no door of its own", () => {
    expect(server.ROUTES.some((r) => r.path === "/api/queue")).toBe(false);
    const body = call("GET", "/api/vault") as {
      queue: { waiting: number; running: number; nextEtaMs: number | null; tickMs: number | null };
    };
    // The scratch vault the suite preloads holds no insertions: nothing
    // due, so no chip — and `nextEtaMs` null is what says so.
    expect(body.queue).toEqual({ waiting: 0, running: 0, nextEtaMs: null, tickMs: expect.anything() });
  });

  // #639: the note's own date comes from the route that already has the
  // file open. The viewer used to get it by listing the containing
  // DIRECTORY — a three-level walk plus a frontmatter read per note, 932
  // of them in references/ on the live vault — to find one row in it.
  test("a note carries its own date, so opening one lists no directory", () => {
    const root = process.env["BIGBRAIN_VAULT"]!;
    mkdirSync(join(root, "entities"), { recursive: true });
    writeFileSync(
      join(root, "entities", "2026-08-02-ada.md"),
      "---\ndate: 2026-08-02T10:00:00.000Z\nkind: entity\n---\nAda.\n"
    );
    const note = call("GET", "/api/note?path=entities/2026-08-02-ada.md") as {
      path: string;
      content: string;
      modified: number;
    };
    expect(note.content).toContain("Ada.");
    expect(note.modified).toBe(Date.parse("2026-08-02T10:00:00.000Z"));
    rmSync(join(root, "entities", "2026-08-02-ada.md"));
  });
});

describe("viewer path normalization (#285)", () => {
  test("both reading routes reject escapes and retain allowed dotted paths", () => {
    const root = process.env["BIGBRAIN_VAULT"]!;
    const files = [".state/traversal-probe.md", ".state/traversal-probe.bin",
      ".git/traversal-probe.md", ".git/traversal-probe.bin",
      "entities-private/traversal-probe.md", "entities-private/traversal-probe.bin",
      "entities/traversal-probe.md", "entities/traversal-probe.bin"];
    const read = (route: string, path: string) => {
      let status = 0, body = "";
      const res = { writeHead: (code: number) => { status = code; },
        end: (bytes: string | Buffer) => { body = bytes.toString(); } };
      expect(dispatch(server.ROUTES, { method: "GET", url: `${route}?path=${encodeURIComponent(path)}` } as never, res as never)).toBe(true);
      return { status, body };
    };
    for (const path of files) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), "path containment probe");
    }
    try {
      for (const [route, ext] of [["/api/note", "md"], ["/api/file", "bin"]]) {
        for (const path of [`.state/traversal-probe.${ext}`, `.git/traversal-probe.${ext}`,
          `inbox/../.state/traversal-probe.${ext}`, `entities/sub/../../.git/traversal-probe.${ext}`,
          `entities/../entities-private/traversal-probe.${ext}`, `../entities/traversal-probe.${ext}`,
          join(root, `entities/traversal-probe.${ext}`)]) {
          const result = read(route!, path);
          expect(result.status).toBe(404);
          expect(result.body).not.toContain("path containment probe");
        }
        for (const path of [`entities/traversal-probe.${ext}`, `entities/sub/../traversal-probe.${ext}`]) {
          const result = read(route!, path);
          expect(result.status).toBe(200);
          expect(result.body).toContain("path containment probe");
        }
      }
      expect(read("/api/note", "entities/traversal-probe.bin").status).toBe(404);
      expect(read("/api/file", "entities/traversal-probe.md").status).toBe(404);
    } finally { for (const path of files) rmSync(join(root, path), { force: true }); }
  });
});

describe("every response is armored (#692)", () => {
  test("both node servers call armor() before dispatching", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    for (const f of ["web/server.ts", "bin/desktop.ts"]) {
      const src = readFileSync(join(import.meta.dir, "..", f), "utf8");
      const at = src.indexOf("createServer((req, res) => {");
      expect(at).toBeGreaterThan(0);
      expect(src.slice(at, at + 80)).toContain("armor(res);");
    }
  });

  test("a blob read is a download: octet-stream, nosniff, attachment", () => {
    const { putBlob } = require("../lib/blobs") as typeof import("../lib/blobs");
    const { VAULT_ROOT } = require("../lib/vaultRoot") as typeof import("../lib/vaultRoot");
    const put = putBlob(VAULT_ROOT, new TextEncoder().encode("<svg onload=alert(1)>"));
    let head: Record<string, string> = {};
    const res = { writeHead: (_c: number, h: Record<string, string>) => { head = h; }, end: () => {} };
    expect(dispatch(server.ROUTES, { url: `/api/file?path=blob:${put.sha256}`, method: "GET" } as never, res as never)).toBe(true);
    expect(head["content-type"]).toBe("application/octet-stream");
    expect(head["x-content-type-options"]).toBe("nosniff");
    expect(head["content-disposition"]).toBe("attachment");
  });
});

// The source note's rail (2026-09-02): a source used to answer with its
// body alone, and what the record made of it showed only as neighbourhood
// edges. The route now carries the rows too — whole, in log order, each
// entity as a dossier link — while the markdown stays the body, so curl
// and the reader doors see what they always did.
describe("a source note carries the assertions grounded in it", () => {
  test("the rows ride beside the body; a source nothing cites says so with an empty list", () => {
    const root = process.env["BIGBRAIN_VAULT"]!;
    const cited = insertion({
      id: "ins_5a1e0000000000000000002a", source_id: "src-web-rail-a", title: "Standup",
      body: "Ada runs Atlas.", received_at: "2026-08-22T10:00:00.000Z", content_sha256: "sha-web-rail-a",
    });
    const bare = insertion({
      id: "ins_5a1e0000000000000000002b", source_id: "src-web-rail-b", title: "Nothing yet",
      body: "Unread.", received_at: "2026-08-22T10:05:00.000Z", content_sha256: "sha-web-rail-b",
    });
    appendSourceInsertionEvent(root, cited);
    appendSourceInsertionEvent(root, bare);
    const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
    appendAssertionEvent(root, createAssertionEvent(
      {
        text: `[[${ada.id}|Ada]] runs Atlas.`, entities: [ada], sources: [cited.id],
        author: { kind: "model", id: "test", invocation_id: "run-1" }, confidence: "direct",
        created_at: "2026-08-22T11:00:00.000Z", produced_by: { procedure: "test", version: "v1" },
      },
      new Map([[cited.id, cited]]),
    ));
    invalidateAssertionRecord(root);
    try {
      const note = call("GET", `/api/note?path=${encodeURIComponent(insertionEventRel(cited))}`) as {
        content: string;
        sourceAssertions: Array<{ id: string; text: string; entities: Array<{ id: string; label: string; path: string }> }>;
      };
      expect(note.content).toContain("Ada runs Atlas.");
      expect(note.content).not.toContain("projection/entities");
      expect(note.sourceAssertions).toHaveLength(1);
      expect(note.sourceAssertions[0]!.text).toBe(`[[projection/entities/${ada.id}.md|Ada]] runs Atlas.`);
      expect(note.sourceAssertions[0]!.entities).toEqual([
        { id: ada.id, label: "Ada Lovelace", path: `projection/entities/${ada.id}.md` },
      ]);
      const empty = call("GET", `/api/note?path=${encodeURIComponent(insertionEventRel(bare))}`) as {
        sourceAssertions: unknown[];
      };
      expect(empty.sourceAssertions).toEqual([]);
    } finally {
      // the preloaded scratch vault is every file's; leave it as found
      rmSync(join(root, "log"), { recursive: true, force: true });
      invalidateAssertionRecord(root);
    }
  });
});


test("search keeps grouped thread rows fresh across the live invalidation path", async () => {
  const root = process.env["BIGBRAIN_VAULT"]!;
  const { createLive } = await import("../lib/liveEvents");
  const { primaryGraphCached, invalidateGraphCaches } = await import("../lib/graphCache");
  const { syncAssertionProjection } = await import("../lib/assertionProjection");
  const rows = [1, 2, 3].map(n => insertion({
    id: `ins_${(90000 + n).toString(16).padStart(24, "0")}`,
    title: "Re: Threadsearchprobe archive acquisition discussion",
    received_at: `2026-09-20T12:0${n}:00Z`,
    envelope: { source: "email", kind: "email", inbox: "profile@example.com" },
  }));
  const search = async () => JSON.parse(await new Promise<string>(resolve => {
    dispatch(server.ROUTES, { url: "/api/search?q=Threadsearchprobe&limit=1&offset=0", method: "GET" } as never,
      { writeHead: () => {}, end: resolve } as never);
  }));
  const live = createLive({ root, debounceMs: 1, watch: () => ({ close() {} }), warmLayout: primaryGraphCached });
  try {
    for (const row of rows.slice(0, 2)) appendSourceInsertionEvent(root, row);
    syncAssertionProjection(root); invalidateGraphCaches(root); invalidateAssertionRecord(root);
    const first = await search();
    expect(first.hits).toHaveLength(1);
    expect(first.nextOffset).toBeNull();
    expect(first.hits[0]).toMatchObject({ title: "Threadsearchprobe archive acquisition discussion", threadCount: 2, source: "email" });
    live.start();
    const changed = new Promise<void>(resolve => live.addClient({ write: text => { if (text.includes('"changed":true')) resolve(); } }));
    appendSourceInsertionEvent(root, rows[2]!);
    live.handleChange(insertionEventRel(rows[2]!));
    await changed;
    const next = await search();
    expect(next.hits).toHaveLength(1);
    expect(next.hits[0].threadCount).toBe(3);
    expect(next.hits[0].note.path).toBe(first.hits[0].note.path);
    expect(next.nextOffset).toBeNull();
  } finally {
    live.stop();
    rows.forEach(row => rmSync(join(root, insertionEventRel(row)), { force: true }));
    invalidateGraphCaches(root); invalidateAssertionRecord(root);
  }
});
