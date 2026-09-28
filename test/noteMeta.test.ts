import { describe, expect, test } from "bun:test";
import { envelopeOrSniff, parseEnvelope } from "../lib/envelope";
import {
  envelopeWhen,
  filingStatus,
  fmProvenance,
  referenceWhen,
  mergeRecent,
  parseNoteDate,
} from "../lib/noteMeta";

// The regexes web/server.ts used to run per-key against raw frontmatter text
// (noteWhen's date-key ladder, fmProvenance's key() closure), before both
// were replaced by parseEnvelope + these pure helpers.
const dateKeyRe = (key: string) => new RegExp(`^${key}:\\s*["']?([^"'\\n]+)`, "m");
const provKeyRe = (key: string) => new RegExp(`^${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, "m");

function envOf(fm: string) {
  return parseEnvelope(`---\n${fm}\n---\n\nbody\n`).envelope;
}

describe("parseNoteDate", () => {
  test("bare date parses as UTC midnight", () => {
    expect(parseNoteDate("2026-07-01")).toBe(Date.parse("2026-07-01T00:00:00Z"));
  });
  test("importer's UTC-midnight timestamp collapses to the same value as the bare date", () => {
    expect(parseNoteDate("2026-07-01T00:00:00Z")).toBe(parseNoteDate("2026-07-01"));
  });
  test("a full timestamp parses as itself", () => {
    expect(parseNoteDate("2026-07-01T10:30:00Z")).toBe(Date.parse("2026-07-01T10:30:00Z"));
  });
});

describe("envelopeWhen — date-key ladder", () => {
  test("date wins outright, even over a same-day filename", () => {
    const env = envOf("date: 2026-07-01T09:00:00Z\nfiled: 2026-07-02T00:00:00Z");
    expect(envelopeWhen(env, NaN)).toBe(Date.parse("2026-07-01T09:00:00Z"));
  });

  test("created/filed/updated: same day as the filename prefix keeps its time-of-day", () => {
    const fnMs = parseNoteDate("2026-07-01");
    const env = envOf("filed: 2026-07-01T15:00:00Z");
    expect(envelopeWhen(env, fnMs)).toBe(Date.parse("2026-07-01T15:00:00Z"));
  });

  test("created/filed/updated: a different day than the filename prefix — the prefix wins (bulk-backfill guard)", () => {
    const fnMs = parseNoteDate("2026-01-01");
    const env = envOf("filed: 2026-07-01T15:00:00Z");
    expect(envelopeWhen(env, fnMs)).toBe(fnMs);
  });

  test("no usable key → undefined, leaving the caller's filename/mtime fallback", () => {
    expect(envelopeWhen(envOf("title: hi"), NaN)).toBeUndefined();
  });

  test("ladder order: date > created > filed > updated", () => {
    const env = envOf("created: 2026-01-01\nfiled: 2026-02-02\nupdated: 2026-03-03");
    expect(envelopeWhen(env, NaN)).toBe(parseNoteDate("2026-01-01"));
  });

  describe("parity with the old per-key regex — realistic patterns", () => {
    const cases: [string, string][] = [
      ["date: 2026-07-01", "2026-07-01"],
      ["date: '2026-07-01'", "2026-07-01"],
      ['date: "2026-07-01"', "2026-07-01"],
      ["date:   2026-07-01", "2026-07-01"], // extra internal spaces
    ];
    for (const [fm, expected] of cases) {
      test(`agreement — ${JSON.stringify(fm)}`, () => {
        const oldMatch = dateKeyRe("date").exec(fm)?.[1]?.trim();
        expect(oldMatch).toBe(expected);
        expect(envelopeWhen(envOf(fm), NaN)).toBe(parseNoteDate(expected));
      });
    }
  });

  test("malformed block: the strict parse alone sees no `date` key, but the viewer feeds envelopeWhen through envelopeOrSniff (web/server.ts noteWhen), whose line-wise fallback keeps reading it — the pre-envelope behavior", () => {
    const fm = "date:2026-07-01";
    const raw = `---\n${fm}\n---\n\nbody\n`;
    expect(dateKeyRe("date").exec(fm)?.[1]).toBe("2026-07-01"); // the old regex read it
    expect(envelopeWhen(envOf(fm), NaN)).toBeUndefined(); // strict parse alone: not a mapping
    expect(envelopeWhen(envelopeOrSniff(raw, ["date", "created", "filed", "updated"]), NaN)).toBe(
      parseNoteDate("2026-07-01")
    ); // the viewer's actual path
  });
});

describe("fmProvenance", () => {
  test("from/from_kind stamp wins outright", () => {
    expect(fmProvenance(envOf("from: granola\nfrom_kind: service\nsource: granola"))).toEqual({
      from: "granola",
      band: "service",
      when: undefined,
    });
  });

  test("claude-code source bands as agent", () => {
    expect(fmProvenance(envOf("source: claude-code"))).toEqual({
      from: "claude-code",
      band: "agent",
      when: undefined,
    });
  });

  test("a person channel bands as person", () => {
    expect(fmProvenance(envOf("source: web"))).toEqual({
      from: undefined,
      band: "person",
      when: undefined,
    });
  });

  test("an unrecognized lowercase source bands as a service feed", () => {
    expect(fmProvenance(envOf("source: whoop-api-v2"))).toEqual({
      from: "whoop-api-v2",
      band: "service",
      when: undefined,
    });
  });

  test("an engine source (triage/deep/etc.) bands as engine, not a service", () => {
    expect(fmProvenance(envOf("source: triage"))).toEqual({ band: "engine", when: undefined });
  });

  test("no source or from at all → engine, no from", () => {
    expect(fmProvenance(envOf("title: hi"))).toEqual({ band: "engine", when: undefined });
  });

  test("submission time precedence: received > fetched > date", () => {
    const env = envOf(
      "received: 2026-07-01T10:00:00Z\nfetched: 2026-06-01T00:00:00Z\ndate: 2026-05-01"
    );
    expect(fmProvenance(env).when).toBe(Date.parse("2026-07-01T10:00:00Z"));
  });

  describe("parity with the old key() regex — realistic patterns", () => {
    test("quoted from/from_kind values", () => {
      const fm = "from: 'granola'\nfrom_kind: 'service'";
      const oldFrom = provKeyRe("from").exec(fm)?.[1]?.trim();
      const oldKind = provKeyRe("from_kind").exec(fm)?.[1]?.trim();
      expect(oldFrom).toBe("granola");
      expect(oldKind).toBe("service");
      expect(fmProvenance(envOf(fm))).toEqual({
        from: "granola",
        band: "service",
        when: undefined,
      });
    });
  });

  test("malformed block: the strict parse is blinded (an implicit key spanning a line break fails the WHOLE block, even the well-formed `source:` line), but the viewer bands through envelopeOrSniff (web/server.ts fmProvenance), whose line-wise fallback keeps attribution — the pre-envelope behavior", () => {
    const fm = "from:granola\nfrom_kind:service\nsource: granola";
    const raw = `---\n${fm}\n---\n\nbody\n`;
    expect(provKeyRe("from_kind").exec(fm)?.[1]).toBe("service"); // the old regex read it
    expect(fmProvenance(envOf(fm))).toEqual({ band: "engine", when: undefined }); // strict parse alone is blind
    expect(
      fmProvenance(
        envelopeOrSniff(raw, ["from", "from_kind", "source", "received", "fetched", "date"])
      )
    ).toEqual({
      from: "granola",
      band: "service",
      when: undefined,
    }); // the viewer's actual path
  });
});

describe("referenceWhen — the reference feed's own date precedence", () => {
  test("a valid `received` wins over the file's mtime", () => {
    const mtimeMs = Date.parse("2020-01-01T00:00:00Z");
    expect(referenceWhen("2026-08-02T10:00:00Z", mtimeMs)).toBe(Date.parse("2026-08-02T10:00:00Z"));
  });
  test("missing `received` falls back to mtime", () => {
    const mtimeMs = Date.parse("2020-01-01T00:00:00Z");
    expect(referenceWhen(undefined, mtimeMs)).toBe(mtimeMs);
  });
  test("unparseable `received` falls back to mtime, not NaN", () => {
    const mtimeMs = Date.parse("2020-01-01T00:00:00Z");
    expect(referenceWhen("not a date", mtimeMs)).toBe(mtimeMs);
  });
  test("a bare date parses as UTC midnight, same as parseNoteDate", () => {
    expect(referenceWhen("2026-08-02", 0)).toBe(parseNoteDate("2026-08-02"));
  });
});

describe("filingStatus", () => {
  const cited = new Set(["granola-8f42", "email-abc"]);
  test("filed when the id is cited by a record note", () => {
    expect(filingStatus("granola-8f42", cited)).toBe("filed");
  });
  test("pending when no citing note carries the id", () => {
    expect(filingStatus("granola-9999", cited)).toBe("pending");
  });
  test("an id-less reference reads as pending, never filed", () => {
    expect(filingStatus(undefined, cited)).toBe("pending");
    expect(filingStatus("", cited)).toBe("pending");
  });

  // The editor reads an item and DECLINES it — terminal success, per the
  // queue's contract. Counting citations alone left those spinning forever,
  // indistinguishable from work still queued. Rare enough to ignore until
  // agent-chat capture (#47) made declines the common case: most sessions are
  // inert, so most captured sessions are declined.
  const settled = new Set(["agent-chat-abc-1-14", "granola-8f42"]);

  test("declined when the editor finished with it but nothing cites it", () => {
    expect(filingStatus("agent-chat-abc-1-14", cited, settled)).toBe("declined");
  });

  test("a citation outranks a decline — filed is the more specific fact", () => {
    // granola-8f42 is in BOTH sets: absorbed AND named by a done message.
    expect(filingStatus("granola-8f42", cited, settled)).toBe("filed");
  });

  test("still pending when the editor has not finished with it", () => {
    expect(filingStatus("granola-9999", cited, settled)).toBe("pending");
  });

  test("omitting the settled set keeps the old two-state behavior", () => {
    // Callers that never learned about declines must not start reporting them.
    expect(filingStatus("agent-chat-abc-1-14", cited)).toBe("pending");
  });
});

describe("mergeRecent", () => {
  test("arrival rows and git rows interleave newest-first", () => {
    const rows = [{ path: "references/2026-08-02-a.md", modified: 300 }];
    const git = [
      { path: "entities/old.md", modified: 400 },
      { path: "entities/older.md", modified: 100 },
    ];
    const merged = mergeRecent(rows, git, new Set(), 10);
    expect(merged.map((r) => r.path)).toEqual([
      "entities/old.md",
      "references/2026-08-02-a.md",
      "entities/older.md",
    ]);
  });

  test("a git row whose id is already claimed by a arrival row is dropped (no double-showing a filed item)", () => {
    const rows = [{ path: "references/2026-08-02-granola-1.md", modified: 500, id: "granola-1" }];
    const git = [{ path: "entities/finance.md", modified: 450, id: "granola-1" }];
    const merged = mergeRecent(rows, git, new Set(["granola-1"]), 10);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.path).toBe("references/2026-08-02-granola-1.md");
  });

  test("a git row with no id, or an id no arrival row claims, passes through — pre-envelope history stays visible", () => {
    const rows = [{ path: "references/2026-08-02-a.md", modified: 500, id: "a" }];
    const git = [
      { path: "entities/legacy-no-id.md", modified: 400 },
      { path: "entities/legacy-other-id.md", modified: 350, id: "b" },
    ];
    const merged = mergeRecent(rows, git, new Set(["a"]), 10);
    expect(merged.map((r) => r.path)).toEqual([
      "references/2026-08-02-a.md",
      "entities/legacy-no-id.md",
      "entities/legacy-other-id.md",
    ]);
  });

  test("respects the limit after merging, not before", () => {
    const rows = [{ path: "lake/1.md", modified: 300 }];
    const git = [
      { path: "entities/2.md", modified: 200 },
      { path: "entities/3.md", modified: 100 },
    ];
    expect(mergeRecent(rows, git, new Set(), 2).map((r) => r.path)).toEqual([
      "lake/1.md",
      "entities/2.md",
    ]);
  });

  test("a filed arrival row is enriched with the dropped git row's path — the feed's collection chip", () => {
    const rows = [{ path: "references/2026-08-02-granola-1.md", modified: 500, id: "granola-1" }];
    const git = [{ path: "entities/finance.md", modified: 450, id: "granola-1" }];
    const merged = mergeRecent(rows, git, new Set(["granola-1"]), 10);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      path: "references/2026-08-02-granola-1.md",
      filedPath: "entities/finance.md",
    });
  });

  test("the git row's filedModel (the filing run's model, journal-resolved) rides onto the filed arrival row", () => {
    const rows = [{ path: "references/2026-08-02-granola-1.md", modified: 500, id: "granola-1" }];
    const git = [
      {
        path: "entities/finance.md",
        modified: 450,
        id: "granola-1",
        filedModel: "claude-haiku-4-5",
      },
    ];
    const merged = mergeRecent(rows, git, new Set(["granola-1"]), 10);
    expect(merged[0]).toMatchObject({
      filedPath: "entities/finance.md",
      filedModel: "claude-haiku-4-5",
    });
  });

  test("a git row without a resolvable filedModel enriches the path only — never a fabricated filer", () => {
    const rows = [{ path: "references/2026-08-02-granola-1.md", modified: 500, id: "granola-1" }];
    const git = [{ path: "entities/finance.md", modified: 450, id: "granola-1" }];
    const merged = mergeRecent(rows, git, new Set(["granola-1"]), 10);
    expect(merged[0]).toMatchObject({ filedPath: "entities/finance.md" });
    expect(merged[0]).not.toHaveProperty("filedModel");
  });

  test("a filed arrival row takes the git row's NEWER touch — an edited note bubbles up, not frozen at landing", () => {
    const rows = [{ path: "references/2026-08-02-granola-1.md", modified: 500, id: "granola-1" }];
    const git = [{ path: "entities/some-project.md", modified: 900, id: "granola-1" }];
    const merged = mergeRecent(rows, git, new Set(["granola-1"]), 10);
    expect(merged[0]).toMatchObject({ path: "references/2026-08-02-granola-1.md", modified: 900 });
  });

  test("a filed arrival row keeps its own time when the filing commit is older (backfills don't re-date arrivals)", () => {
    const rows = [{ path: "references/2026-08-02-granola-1.md", modified: 500, id: "granola-1" }];
    const git = [{ path: "entities/finance.md", modified: 450, id: "granola-1" }];
    const merged = mergeRecent(rows, git, new Set(["granola-1"]), 10);
    expect(merged[0]!.modified).toBe(500);
  });

  test("a still-pending arrival row (no matching git row) carries no filedPath/filedModel", () => {
    const rows = [{ path: "references/2026-08-02-a.md", modified: 500, id: "a" }];
    const merged = mergeRecent(rows, [], new Set(["a"]), 10);
    expect(merged[0]).not.toHaveProperty("filedPath");
    expect(merged[0]).not.toHaveProperty("filedModel");
  });
});
