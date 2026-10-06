import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { labels, readLedger } from "../lib/retrieval";
import { clampLimit, scanSurface, SEARCH_CAP, type ScanOptions } from "../lib/searchCore";
import { appendSourceInsertionEvent, type SourceInsertion } from "../lib/insertionLog";
import { appendAssertionEvent, assertionEntityId, createAssertionEvent } from "../lib/assertionLog";
import { insertion } from "./support/vault";

// Pins the shared scan every product door runs (#259/#476/#495): ONE index
// (the assertion projection), one cap (250), the ledger label, and the
// no-throw failure posture. The per-door halves — empty-query answers,
// default page sizes — live in the routes and are pinned by their tests.

afterEach(() => {
  delete process.env["BIGBRAIN_ASSERTION_DB"];
});

function vault(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "bb-searchcore-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

describe("clampLimit", () => {
  test("clamps to [1, SEARCH_CAP]; garbage and absence fall back to the door's default", () => {
    expect(SEARCH_CAP).toBe(250);
    expect(clampLimit(null, 20)).toBe(20);
    expect(clampLimit(null, 100)).toBe(100);
    expect(clampLimit("5", 20)).toBe(5);
    expect(clampLimit("500", 20)).toBe(250);
    expect(clampLimit("0", 20)).toBe(20);
    expect(clampLimit("-3", 20)).toBe(1);
    expect(clampLimit("nope", 100)).toBe(100);
    // A door that is not a search brings its own ceiling (#639: the recent
    // feed's 200, the work view's 500 — both hand-rolled before).
    expect(clampLimit("400", 100, 500)).toBe(400);
    expect(clampLimit("900", 100, 500)).toBe(500);
    expect(clampLimit("0", 40, 200)).toBe(40);
  });
});

describe("scanSurface", () => {
  function assertionVault(): { root: string; source: SourceInsertion } {
    const root = mkdtempSync(join(tmpdir(), "bb-surface-search-"));
    process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
    const source = insertion({
      id: "ins_0123456789abcdef01234567",
      source_id: "meeting-1",
      author: { kind: "service", id: "test" },
      title: "GPU research meeting",
      body: "Ada and Ben reviewed a matrix multiplication kernel.",
      envelope: { category: "meeting" },
      received_at: "2026-08-18T12:00:00.000Z",
      content_sha256: "sha-source",
    });
    appendSourceInsertionEvent(root, source);
    const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
    appendAssertionEvent(root, createAssertionEvent({
      text: `[[${ada.id}|Ada Lovelace]] designed the GPU kernel.`,
      entities: [ada],
      citations: [{ insertion_id: source.id, quotes: ["matrix multiplication kernel"] }],
      author: { kind: "model", id: "test", invocation_id: "run-1" },
      confidence: "direct",
      created_at: "2026-08-18T12:01:00.000Z",
      produced_by: { procedure: "test", version: "v1" },
    }, new Map([[source.id, source]])));
    return { root, source };
  }

  test("both doors receive the same assertion-backed, source-openable result", () => {
    const { root, source } = assertionVault();
    const api = scanSurface(root, "Ada Lovelace", 20, "api");
    const web = scanSurface(root, "Ada Lovelace", 20, "web");
    if (!api.ok) throw new Error(api.reason);
    if (!web.ok) throw new Error(web.reason);
    expect(web.hits).toEqual(api.hits);
    expect(api.hits).toEqual([
      // The entity itself leads — the projection note both note doors serve —
      // wearing its newest evidence as snippet and date.
      expect.objectContaining({
        path: `projection/entities/${assertionEntityId("Ada Lovelace")}.md`,
        title: "Ada Lovelace",
        snippet: "Ada Lovelace designed the GPU kernel.",
        date: "2026-08-18",
      }),
      expect.objectContaining({
        path: `log/insertions/2026-08/${source.id}.json`,
        title: source.title,
        snippet: "Ada Lovelace designed the GPU kernel.",
      }),
    ]);
    expect(readLedger(root).filter((row) => row.t === "search").map((row) => row.via))
      .toEqual(["api", "web"]);
  });

  test("an insertion id finds its source first, though no title or body spells it", () => {
    const { root, source } = assertionVault();
    for (const q of [source.id, `kernel OR ${source.id}`]) {
      const r = scanSurface(root, q, 20, "api");
      if (!r.ok) throw new Error(r.reason);
      expect(r.hits[0]).toEqual(expect.objectContaining({ path: `log/insertions/2026-08/${source.id}.json`, title: source.title }));
    }
    const missing = scanSurface(root, "ins_ffffffffffffffffffffffff", 20, "api");
    if (!missing.ok) throw new Error(missing.reason);
    expect(missing.hits).toEqual([]);
  });

  test("a voice arrival ranks below the record, and never off the end of it", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-surface-search-voice-"));
    process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
    const clip = insertion({
      id: "ins_0123456789abcdef0123abcd",
      source_id: "api-2026-08-27T20-44-52-clip",
      author: { kind: "service", id: "test" },
      title: "Semafor: Warsh at Jackson Hole",
      body: "Kevin Warsh addressed the Jackson Hole symposium on the Fed's balance sheet.",
      envelope: { category: "clip" },
      received_at: "2026-08-27T20:44:52.000Z",
      content_sha256: "sha-clip",
    });
    const directive = insertion({
      id: "ins_0123456789abcdef0123dddd",
      source_id: "api-2026-08-27T20-44-57-note",
      author: { kind: "user", id: "alex" },
      title: "all eyes on warsh",
      body: "all eyes on warsh",
      envelope: { kind: "directive", from_kind: "person", about: [clip.source_id] },
      received_at: "2026-08-27T20:44:57.000Z",
      content_sha256: "sha-directive",
    });
    appendSourceInsertionEvent(root, clip);
    appendSourceInsertionEvent(root, directive);
    const warsh = { id: assertionEntityId("Kevin Warsh"), label: "Kevin Warsh" };
    appendAssertionEvent(root, createAssertionEvent({
      text: `Alex flagged the Semafor piece on [[${warsh.id}|Kevin Warsh]] with the directive "all eyes on warsh".`,
      entities: [warsh],
      citations: [
        { insertion_id: directive.id, quotes: ["all eyes on warsh"] },
        { insertion_id: clip.id, quotes: ["Jackson Hole symposium"] },
      ],
      author: { kind: "model", id: "test", invocation_id: "run-1" },
      confidence: "direct",
      created_at: "2026-08-27T21:00:00.000Z",
      produced_by: { procedure: "test", version: "v1" },
    }, new Map([[clip.id, clip], [directive.id, directive]])));

    // The query is the directive's own words, so it out-tiers the clip it was
    // typed beside — that is the ranking bug #633 hit, and it fixed it by
    // dropping voice from the response entirely. The clip must win; the
    // directive must still be reachable (#641).
    const directivePath = `log/insertions/2026-08/${directive.id}.json`;
    const clipPath = `log/insertions/2026-08/${clip.id}.json`;
    for (const q of ["all eyes", "all eyes on warsh"]) {
      const r = scanSurface(root, q, 20, "web");
      if (!r.ok) throw new Error(r.reason);
      const paths = r.hits.map((hit) => hit.path);
      expect(paths).toContain(clipPath);
      expect(paths).toContain(directivePath);
      expect(paths.indexOf(clipPath)).toBeLessThan(paths.indexOf(directivePath));
    }
  });

  test("an assertion whose only source is voice is still findable (#641)", () => {
    // #633's drop was per-SOURCE, so an assertion with nothing but a voice
    // arrival under it matched `assertion_fts` and then answered nothing —
    // on the live vault that hid five of the 2026-08-31 corrections.
    const root = mkdtempSync(join(tmpdir(), "bb-surface-search-voice-only-"));
    process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
    const correction = insertion({
      id: "ins_0123456789abcdef0123cccc",
      source_id: "api-2026-08-31T10-00-00-fix",
      author: { kind: "user", id: "alex" },
      title: "Correction — the condo sold in June",
      body: "i sold the condo in june",
      envelope: { kind: "request", from_kind: "agent" },
      received_at: "2026-08-31T10:00:00.000Z",
      content_sha256: "sha-correction",
    });
    appendSourceInsertionEvent(root, correction);
    const alex = { id: assertionEntityId("Alex Rowan"), label: "Alex Rowan" };
    appendAssertionEvent(root, createAssertionEvent({
      text: `The record's standing claim that [[${alex.id}|Alex Rowan]] still owns the condo is closed as resolved-by-correction.`,
      entities: [alex],
      citations: [{ insertion_id: correction.id, quotes: ["i sold the condo in june"] }],
      author: { kind: "model", id: "test", invocation_id: "run-1" },
      confidence: "direct",
      created_at: "2026-08-31T11:00:00.000Z",
      produced_by: { procedure: "test", version: "v1" },
    }, new Map([[correction.id, correction]])));

    const r = scanSurface(root, "resolved-by-correction", 20, "web");
    if (!r.ok) throw new Error(r.reason);
    expect(r.hits.map((hit) => hit.path))
      .toContain(`log/insertions/2026-08/${correction.id}.json`);
  });

  test("a bare name ranks the entity with the evidence, and entity hits carry their counts", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-surface-search-"));
    process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
    const source = insertion({
      id: "ins_0123456789abcdef0123abcd",
      source_id: "meeting-2",
      author: { kind: "service", id: "test" },
      title: "FRI sync",
      body: "Evan and the team met.",
      envelope: { category: "meeting" },
      received_at: "2026-08-18T12:00:00.000Z",
      content_sha256: "sha-source-2",
    });
    appendSourceInsertionEvent(root, source);
    const ek = { id: assertionEntityId("Evan Keller"), label: "Evan Keller" };
    const stub = { id: assertionEntityId("Evan"), label: "Evan" };
    const assert = (text: string, entities: { id: string; label: string }[], minute: number) =>
      appendAssertionEvent(root, createAssertionEvent({
        text, entities, sources: [source.id],
        author: { kind: "model", id: "test", invocation_id: "run-1" }, confidence: "direct",
        created_at: `2026-08-18T12:0${minute}:00.000Z`, produced_by: { procedure: "test", version: "v1" },
      }, new Map([[source.id, source]])));
    // The stub is the EXACT title match and the newer entity; the person has
    // the evidence. The exact-title tier used to hand every "Evan" to the stub.
    assert(`[[${ek.id}|Evan Keller]] runs FRI.`, [ek], 1);
    assert(`[[${ek.id}|Evan Keller]] set the October date.`, [ek], 2);
    assert(`[[${stub.id}|Evan]] said hello.`, [stub], 3);
    const result = scanSurface(root, "Evan", 20, "api", { filters: { type: "entity" } });
    if (!result.ok) throw new Error(result.reason);
    expect(result.hits.slice(0, 2)).toEqual([
      expect.objectContaining({ title: "Evan Keller", assertions: 2 }),
      expect.objectContaining({ title: "Evan", assertions: 1 }),
    ]);
    // a source hit carries no count
    const full = scanSurface(root, "Evan", 20, "api");
    if (!full.ok) throw new Error(full.reason);
    expect(full.hits.find((hit) => hit.path.startsWith("log/"))).not.toHaveProperty("assertions");
    // and "Evan Keller" still names the person exactly, the stub not at all
    const exact = scanSurface(root, "Evan Keller", 20, "api", { filters: { type: "entity" } });
    if (!exact.ok) throw new Error(exact.reason);
    expect(exact.hits.filter((hit) => hit.path.startsWith("projection/")).map((hit) => hit.title))
      .toEqual(["Evan Keller"]);
  });

  test("type and date filters apply to the assertion-backed source", () => {
    const { root, source } = assertionVault();
    const paths = (filters: NonNullable<ScanOptions["filters"]>, query = "Ada Lovelace") => {
      const result = scanSurface(root, query, 20, "api", { filters });
      if (!result.ok) throw new Error(result.reason);
      return result.hits.map((hit) => hit.path);
    };
    expect(paths({ type: "entity", after: "2026-08-18", before: "2026-08-18" })).toEqual([
      `projection/entities/${assertionEntityId("Ada Lovelace")}.md`,
      `log/insertions/2026-08/${source.id}.json`,
    ]);
    expect(paths({ type: "reference" }, "designed")).toEqual([]);
    expect(paths({ type: "entity", after: "2026-08-19" })).toEqual([]);
  });

  test("the request path reads the projection, never a replay of the logs (#456)", () => {
    const { root, source } = assertionVault();
    const first = scanSurface(root, "Ada Lovelace", 20, "api");
    if (!first.ok) throw new Error(first.reason);
    expect(first.hits).toHaveLength(2);
    // Damage the already-projected source event ON DISK. The old scan
    // strict-read the full insertion log per request and would now answer
    // {ok:false}; the projection-backed scan must not notice.
    writeFileSync(join(root, `log/insertions/2026-08/${source.id}.json`), "not json\n");
    const again = scanSurface(root, "Ada Lovelace", 20, "web");
    if (!again.ok) throw new Error(again.reason);
    expect(again.hits).toEqual(first.hits);
  });

  // The field report: search answered with an insertion path that /v1/note
  // then refused. The vault had retracted the event (`record: retract 9
  // agent-chat captures of the memory pass's own sessions`) — the file is
  // gone from the log — but the projection's sync only ever ADDS, so the
  // row, its FTS text and its title outlived the evidence. A stat per
  // unique insertion in the pool is what keeps the two doors' promise:
  // search never names a path the note door cannot open. It stays a STAT,
  // not a parse — the test above (a corrupt event file) still answers from
  // the projection, because #456's no-replay rule is untouched.
  test("a retracted event is no longer a hit, though its projection row survives", () => {
    const { root, source } = assertionVault();
    const paths = (): string[] => {
      const r = scanSurface(root, "Ada Lovelace", 20, "api");
      if (!r.ok) throw new Error(r.reason);
      return r.hits.map((hit) => hit.path);
    };
    const event = `log/insertions/2026-08/${source.id}.json`;
    expect(paths()).toContain(event);
    rmSync(join(root, event));
    // the entity survives its retracted evidence; only the source hit goes
    expect(paths()).toEqual([`projection/entities/${assertionEntityId("Ada Lovelace")}.md`]);
  });

  // THE #495 fix (#494's untended vault): a fresh vault with drops and ZERO
  // assertions — before any gardener has run — searches its insertions from
  // source_fts immediately. No flag is needed: every vault is native (#498).
  test("a fresh vault with drops and no assertions serves source hits — no agent needed", () => {
    const root = vault({});
    process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
    appendSourceInsertionEvent(root, insertion({
      id: "ins_fresh0000000000000000001",
      source_id: "clip-1",
      author: { kind: "service", id: "extension" },
      title: "Analytical engines revisited",
      body: "A fresh web clip about the analytical engine and its punch cards.",
      envelope: { kind: "web-clip" },
      received_at: "2026-08-20T09:00:00.000Z",
      content_sha256: "sha-clip",
    }));
    const r = scanSurface(root, "analytical engine", 20, "api");
    if (!r.ok) throw new Error(r.reason);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.path).toBe("log/insertions/2026-08/ins_fresh0000000000000000001.json");
    expect(r.hits[0]!.date).toBe("2026-08-20");
  });

  // The `assertions.native` gate retired with the flag: a vault with no
  // insertions and no assertions answers an empty hit list, never a refusal
  // (the markdown index itself was removed in #495).
  test("a vault with nothing inserted answers ok with zero hits", () => {
    const root = vault({
      "references/legacy.md": "---\ntitle: Legacy note\n---\nAnalytical engine.\n",
    });
    const r = scanSurface(root, "analytical engine", 20, "api");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hits).toEqual([]);
  });

  test("#361 relaxation on the native scan: zero exact hits answer the any-term rung, ledgered", () => {
    const { root } = assertionVault();
    const r = scanSurface(root, "Ada punchcards", 20, "api");
    if (!r.ok) throw new Error(r.reason);
    expect(r.relaxation).toBe("any-term");
    expect(r.hits.length).toBeGreaterThan(0);
    const rec = readLedger(root).find((row) => row.t === "search")!;
    expect(rec).toMatchObject({ relaxation: "any-term" });
  });

  test("a projection that cannot be built answers {ok:false, reason}, never throws", () => {
    const root = vault({});
    writeFileSync(join(root, ".state"), "a file where the projection wants a directory\n");
    const r = scanSurface(root, "widget", 25, "api");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });
});

describe("#476: the CLI door is the same scan", () => {
  function nativeVault(): string {
    const root = mkdtempSync(join(tmpdir(), "bb-cli-door-"));
    process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
    const source = insertion({
      id: "ins_0123456789abcdef01234567",
      source_id: "meeting-1",
      author: { kind: "service", id: "test" },
      title: "GPU research meeting",
      body: "Ada and Ben reviewed a matrix multiplication kernel.",
      envelope: { category: "meeting" },
      received_at: "2026-08-18T12:00:00.000Z",
      content_sha256: "sha-source",
    });
    appendSourceInsertionEvent(root, source);
    const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
    appendAssertionEvent(root, createAssertionEvent({
      text: `[[${ada.id}|Ada Lovelace]] designed the GPU kernel.`,
      entities: [ada],
      citations: [{ insertion_id: source.id, quotes: ["matrix multiplication kernel"] }],
      author: { kind: "model", id: "test", invocation_id: "run-1" },
      confidence: "direct",
      created_at: "2026-08-18T12:01:00.000Z",
      produced_by: { procedure: "test", version: "v1" },
    }, new Map([[source.id, source]])));
    return root;
  }

  test("on a native vault the cli door answers from the projection — entity first — and is ledgered as cli", () => {
    const root = nativeVault();
    const r = scanSurface(root, "Ada", 10, "cli", { now: new Date("2026-08-19T00:00:00Z") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hits[0]!.path).toBe("projection/entities/" + assertionEntityId("Ada Lovelace") + ".md");
    expect(r.hits.some((h) => h.path.startsWith("log/insertions/"))).toBe(true); // the source, openable
    const labels_ = labels(readLedger(root));
    expect(labels_).toHaveLength(1);
    expect(labels_[0]!.via).toBe("cli");
  });

  test("a machine pass (ledger: false) searches the same projection and writes NO label", () => {
    const root = nativeVault();
    const r = scanSurface(root, "Ada", 10, "cli", { relax: false, ledger: false });
    expect(r.ok && r.hits.length > 0).toBe(true);
    expect(labels(readLedger(root))).toEqual([]);
  });
});

describe("snippets: the claim, not the header", () => {
  // The failure this pins, observed on a real vault: every agent transcript
  // is titled "Claude Code — <project> (date)", so a query naming the
  // project title-matches all of them (tier 1) and their body candidates
  // outrank their own assertions (tier 2) at dedupe. The winner then wore
  // `body.slice(0, 240)` — the session header — while the assertion the
  // projection had already extracted was computed and discarded.
  test("a title-matching transcript answers with its matching assertion, never its opening line", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-snippet-"));
    process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
    const transcript = insertion({
      id: "ins_transcript00000000000001",
      source_id: "session-1",
      author: { kind: "service", id: "test" },
      title: "Claude Code — BigBrain (2026-08-23)",
      body:
        "# Claude Code — BigBrain Session `abc`, lines 1–500, in ~/Projects/BigBrain.\n" +
        "--- TRANSCRIPT (projection: turns and tool names) ---\n" +
        "user: talk through the bigbrain business plan with me\n" +
        "assistant: hosted curation costs $0.38 per reference, so bigbrain cannot be the token payer.",
      envelope: { category: "agent-chat" },
      received_at: "2026-08-23T12:00:00.000Z",
      content_sha256: "sha-transcript",
    });
    appendSourceInsertionEvent(root, transcript);
    const bb = { id: assertionEntityId("BigBrain"), label: "BigBrain" };
    appendAssertionEvent(root, createAssertionEvent({
      text: `[[${bb.id}|BigBrain]] cannot be the token payer for curation: hosted pricing measured $0.38 per reference.`,
      entities: [bb],
      citations: [{ insertion_id: transcript.id, quotes: ["cannot be the token payer"] }],
      author: { kind: "model", id: "test", invocation_id: "run-1" },
      confidence: "direct",
      created_at: "2026-08-23T12:01:00.000Z",
      produced_by: { procedure: "test", version: "v1" },
    }, new Map([[transcript.id, transcript]])));
    const r = scanSurface(root, "bigbrain", 20, "api");
    if (!r.ok) throw new Error(r.reason);
    const hit = r.hits.find((h) => h.path === `log/insertions/2026-08/${transcript.id}.json`);
    expect(hit).toBeDefined();
    expect(hit!.snippet).toBe(
      "BigBrain cannot be the token payer for curation: hosted pricing measured $0.38 per reference."
    );
    expect(hit!.snippet).not.toContain("Session");
    // Rank is untouched: the entity itself still leads.
    expect(r.hits[0]!.path).toBe(`projection/entities/${bb.id}.md`);
  });

  test("a body-only hit wears FTS5's match window, not the document's first 240 bytes", () => {
    const root = vault({});
    process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
    appendSourceInsertionEvent(root, insertion({
      id: "ins_window00000000000000001",
      source_id: "clip-window",
      author: { kind: "service", id: "extension" },
      title: "A long clip",
      body:
        "# Session header line that says nothing about the question.\n" +
        "filler sentence about nothing in particular. ".repeat(40) +
        "The decisive line: punch cards drive the analytical engine.",
      envelope: { kind: "web-clip" },
      received_at: "2026-08-20T09:00:00.000Z",
      content_sha256: "sha-window",
    }));
    const r = scanSurface(root, "punch cards", 20, "api");
    if (!r.ok) throw new Error(r.reason);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.snippet).toContain("punch cards");
    expect(r.hits[0]!.snippet).not.toContain("Session header");
    expect(r.hits[0]!.snippet.length).toBeLessThanOrEqual(240);
  });
});

describe("typeahead: what one keystroke may cost", () => {
  // The omnibox searches per keystroke with every term prefix-matched. On a
  // real vault (1,200 sources, 55MB of transcript) "r" matched everything,
  // and the ranking query's FTS5 snippet() re-tokenized every matching row:
  // 2.1s, synchronous, with the query typed next queued behind it.
  function typeaheadVault(): string {
    const root = mkdtempSync(join(tmpdir(), "bb-typeahead-"));
    process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
    const cited = insertion({
      id: "ins_cited0000000000000000001",
      source_id: "meeting-red",
      author: { kind: "service", id: "test" },
      title: "Planning call",
      body: "We agreed the ridgeways dashboard ships in September.",
      envelope: { category: "meeting" },
      received_at: "2026-08-20T09:00:00.000Z",
      content_sha256: "sha-cited",
    });
    appendSourceInsertionEvent(root, cited);
    appendSourceInsertionEvent(root, insertion({
      id: "ins_bodyonly000000000000001",
      source_id: "clip-rivers",
      author: { kind: "service", id: "test" },
      title: "A clip",
      body: "rambling notes about rivers and rain, cited by nothing.",
      envelope: { kind: "web-clip" },
      received_at: "2026-08-21T09:00:00.000Z",
      content_sha256: "sha-rivers",
    }));
    const red = { id: assertionEntityId("Ridgeways"), label: "Ridgeways" };
    appendAssertionEvent(root, createAssertionEvent({
      text: `[[${red.id}|Ridgeways]] ships in September.`,
      entities: [red],
      citations: [{ insertion_id: cited.id, quotes: ["ships in September"] }],
      author: { kind: "model", id: "test", invocation_id: "run-1" },
      confidence: "direct",
      created_at: "2026-08-20T09:01:00.000Z",
      produced_by: { procedure: "test", version: "v1" },
    }, new Map([[cited.id, cited]])));
    return root;
  }

  test("one letter answers with entities and their evidence, never with body-only prefix matches", () => {
    const root = typeaheadVault();
    const one = scanSurface(root, "r", 20, "api");
    if (!one.ok) throw new Error(one.reason);
    const paths = one.hits.map((h) => h.path);
    expect(paths[0]).toBe(`projection/entities/${assertionEntityId("Ridgeways")}.md`);
    expect(paths).toContain("log/insertions/2026-08/ins_cited0000000000000000001.json");
    expect(paths).not.toContain("log/insertions/2026-08/ins_bodyonly000000000000001.json");
    // The second letter opens the bodies.
    const two = scanSurface(root, "ra", 20, "api");
    if (!two.ok) throw new Error(two.reason);
    expect(two.hits.map((h) => h.path)).toContain("log/insertions/2026-08/ins_bodyonly000000000000001.json");
  });

  test("a body window follows the first query term the body actually holds", () => {
    const root = vault({});
    process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
    appendSourceInsertionEvent(root, insertion({
      id: "ins_window00000000000000002",
      source_id: "clip-window-2",
      author: { kind: "service", id: "extension" },
      title: "Another long clip",
      body:
        "# Session header line that says nothing about the question.\n" +
        "filler sentence about nothing in particular. ".repeat(40) +
        "The decisive line: punch cards drive the analytical engine.",
      envelope: { kind: "web-clip" },
      received_at: "2026-08-20T09:00:00.000Z",
      content_sha256: "sha-window-2",
    }));
    // "zebra" is nowhere; the any-term relaxation finds "cards" and the
    // window is cut around it, not around the document's opening.
    const r = scanSurface(root, "zebra cards", 20, "api");
    if (!r.ok) throw new Error(r.reason);
    expect(r.relaxation).toBe("any-term");
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.snippet).toContain("punch cards");
    expect(r.hits[0]!.snippet).not.toContain("Session header");
    // A title-only match has no term in the body to centre on: the opening.
    const t = scanSurface(root, "another", 20, "api");
    if (!t.ok) throw new Error(t.reason);
    expect(t.hits[0]!.snippet.startsWith("# Session header line")).toBe(true);
  });
});
