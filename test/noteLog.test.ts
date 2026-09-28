import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitAction,
  frontmatterLogRows,
  gitLogRows,
  journalLogRows,
  mergeNoteLog,
  noteLog,
  journalModelFor,
  runRole,
  type LogRow,
} from "../lib/noteLog";
import { gitVault } from "./support/vault";

// ── pure parts — no I/O ──────────────────────────────────────────────────

describe("commitAction", () => {
  test("intake commits read as landed", () => {
    expect(commitAction("intake", "intake: api-2026-08-02T00-00-00-abcdef — a title")).toBe(
      "landed"
    );
  });
  test("config commits read as configured", () => {
    expect(commitAction("config", "config: integrations, triageModel")).toBe("configured");
  });
  test("triage/deep commits parse the verb out of the lane persona's subject", () => {
    expect(commitAction("triage", "triage: file ×3 — 3 files changed")).toBe("file");
    expect(commitAction("deep", "deep: synthesize ×1 (1 failed) — 2 files changed")).toBe(
      "synthesize"
    );
  });
  test("a human persona (no colon-prefixed subject) reads as edited", () => {
    expect(commitAction("Alex Rowan", "tidy up the finance note")).toBe("edited");
  });
  test("the trailing journal-commit subject parses its own (non-verb) word — still a real word, never a crash", () => {
    expect(commitAction("triage", "triage: queue journal — 3 execution(s)")).toBe("queue");
  });
});

describe("runRole", () => {
  const vault = (): string => mkdtempSync(join(tmpdir(), "bb-runrole-"));
  const journal = (
    root: string,
    dir: string,
    runId: string,
    rec: Record<string, unknown>
  ): void => {
    mkdirSync(join(root, "journal", dir), { recursive: true });
    writeFileSync(join(root, "journal", dir, `${runId}.json`), JSON.stringify(rec));
  };

  test("a queue-era record resolves through its lane: fast→triage, slow→deep", () => {
    const root = vault();
    journal(root, "queue", "q-fast-1", { lane: "fast" });
    journal(root, "queue", "q-slow-1", { lane: "slow" });
    expect(runRole(root, "q-fast-1")).toBe("triage");
    expect(runRole(root, "q-slow-1")).toBe("deep");
  });

  test("legacy records resolve by which journal dir holds them", () => {
    const root = vault();
    journal(root, "triage", "t-1", {});
    journal(root, "deep", "d-1", {});
    journal(root, "librarian", "l-1", {});
    expect(runRole(root, "t-1")).toBe("triage");
    expect(runRole(root, "d-1")).toBe("deep");
    expect(runRole(root, "l-1")).toBe("deep");
  });

  test("no surviving record (or a malformed one) yields undefined, never a throw", () => {
    const root = vault();
    expect(runRole(root, "q-gone")).toBeUndefined();
    mkdirSync(join(root, "journal", "queue"), { recursive: true });
    writeFileSync(join(root, "journal", "queue", "q-bad.json"), "not json");
    expect(runRole(root, "q-bad")).toBeUndefined();
  });

  test("a runId that isn't a plain token (frontmatter is untrusted text) never touches a path", () => {
    const root = vault();
    expect(runRole(root, "../../etc/passwd")).toBeUndefined();
    expect(runRole(root, "")).toBeUndefined();
  });
});

describe("journalModelFor", () => {
  const vault = (): string => mkdtempSync(join(tmpdir(), "bb-runmodel-"));
  const journal = (
    root: string,
    dir: string,
    runId: string,
    rec: Record<string, unknown>
  ): void => {
    mkdirSync(join(root, "journal", dir), { recursive: true });
    writeFileSync(join(root, "journal", dir, `${runId}.json`), JSON.stringify(rec));
  };

  test("a queue-era record yields the model the execution ran with", () => {
    const root = vault();
    journal(root, "queue", "q-1", { lane: "fast", model: "claude-haiku-4-5" });
    expect(journalModelFor(root, "q-1")).toBe("claude-haiku-4-5");
  });

  test("legacy records carry their pass model too, whichever dir holds them", () => {
    const root = vault();
    journal(root, "triage", "t-1", { model: "claude-sonnet-4-5" });
    journal(root, "librarian", "l-1", { model: "claude-opus-4-1" });
    expect(journalModelFor(root, "t-1")).toBe("claude-sonnet-4-5");
    expect(journalModelFor(root, "l-1")).toBe("claude-opus-4-1");
  });

  test("no record, a malformed record, or one with no model → undefined, never a fabricated label", () => {
    const root = vault();
    expect(journalModelFor(root, "gone")).toBeUndefined();
    journal(root, "queue", "no-model", { lane: "fast" });
    expect(journalModelFor(root, "no-model")).toBeUndefined();
    journal(root, "queue", "blank-model", { model: "  " });
    expect(journalModelFor(root, "blank-model")).toBeUndefined();
    mkdirSync(join(root, "journal", "queue"), { recursive: true });
    writeFileSync(join(root, "journal", "queue", "bad.json"), "not json");
    expect(journalModelFor(root, "bad")).toBeUndefined();
  });

  test("a runId that isn't a plain token never touches a path", () => {
    const root = vault();
    expect(journalModelFor(root, "../../etc/passwd")).toBeUndefined();
    expect(journalModelFor(root, "")).toBeUndefined();
  });
});

describe("frontmatterLogRows", () => {
  test("a reference's own envelope yields one landed row", () => {
    const rows = frontmatterLogRows({
      received: "2026-08-01T10:00:00Z",
      from: "granola",
      source: "granola",
    });
    expect(rows).toEqual([
      { at: Date.parse("2026-08-01T10:00:00Z"), actor: "granola", action: "landed" },
    ]);
  });

  test("received beats date beats fetched — only the most-trusted key produces a row", () => {
    const rows = frontmatterLogRows({
      received: "2026-08-01T10:00:00Z",
      date: "2026-07-01",
      fetched: "2026-06-01T00:00:00Z",
      from: "nick",
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.at).toBe(Date.parse("2026-08-01T10:00:00Z"));
  });

  test("a filed note adds a second row keyed by its triage_run", () => {
    const rows = frontmatterLogRows({
      id: "granola-8f42",
      from: "granola",
      received: "2026-08-01T10:00:00Z",
      filed: "2026-08-01T10:05:00Z",
      triage_run: "q-2026-08-01T10-05-00-abcd",
    });
    expect(rows).toEqual([
      { at: Date.parse("2026-08-01T10:00:00Z"), actor: "granola", action: "landed" },
      {
        at: Date.parse("2026-08-01T10:05:00Z"),
        actor: "run q-2026-08-01T10-05-00-abcd",
        action: "filed",
      },
    ]);
  });

  test("a filed note with no run id names the editor generically", () => {
    const rows = frontmatterLogRows({ filed: "2026-08-01T10:05:00Z" });
    expect(rows).toEqual([
      { at: Date.parse("2026-08-01T10:05:00Z"), actor: "editor", action: "filed" },
    ]);
  });

  test("an empty envelope yields no rows", () => {
    expect(frontmatterLogRows({})).toEqual([]);
  });
});

describe("mergeNoteLog", () => {
  test("sorts newest-first across all three sources", () => {
    const provenanceRows: LogRow[] = [{ at: 100, actor: "granola", action: "landed" }];
    const gitRows: LogRow[] = [{ at: 300, actor: "triage", action: "file" }];
    const journalRows: LogRow[] = [{ at: 200, actor: "deep", action: "synthesize" }];
    const merged = mergeNoteLog({ provenanceRows, gitRows, journalRows });
    expect(merged.map((r) => r.at)).toEqual([300, 200, 100]);
  });

  test("dedups an exact at/actor/action triple across sources (e.g. a git commit and its matching journal record)", () => {
    const row: LogRow = { at: 100, actor: "triage", action: "file" };
    const merged = mergeNoteLog({ provenanceRows: [], gitRows: [row], journalRows: [{ ...row }] });
    expect(merged.length).toBe(1);
  });

  test("respects the limit after sorting", () => {
    const gitRows: LogRow[] = [1, 2, 3, 4, 5].map((n) => ({
      at: n,
      actor: "triage",
      action: "file",
    }));
    const merged = mergeNoteLog({ provenanceRows: [], gitRows, journalRows: [] }, 2);
    expect(merged.map((r) => r.at)).toEqual([5, 4]);
  });
});

// ── I/O parts — a real git-backed fixture (git log/commit shell out) ────────

function commitAs(root: string, role: string, message: string, iso: string): string {
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync(
    "git",
    [
      "-c",
      `user.name=${role}`,
      "-c",
      `user.email=${role}@bigbrain`,
      "commit",
      "-q",
      "-m",
      message,
      "--date",
      iso,
    ],
    { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } }
  );
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
}

function vault(): string {
  return gitVault({ prefix: "bb-notelog-", dirs: ["entities"], commit: false });
}

describe("gitLogRows", () => {
  test("bounded, newest-first, author persona as actor", () => {
    const root = vault();
    const path = "entities/note.md";
    writeFileSync(join(root, path), "---\nid: n1\n---\n\nv1\n");
    commitAs(root, "intake", "intake: n1 — a note", "2026-08-01T10:00:00Z");
    writeFileSync(join(root, path), "---\nid: n1\n---\n\nv2\n");
    commitAs(root, "triage", "triage: file ×1 — 1 file changed", "2026-08-01T10:05:00Z");

    const { rows, shas } = gitLogRows(root, path, 30);
    expect(rows.length).toBe(2);
    expect(rows[0]!.actor).toBe("triage");
    expect(rows[0]!.action).toBe("file");
    expect(rows[1]!.actor).toBe("intake");
    expect(rows[1]!.action).toBe("landed");
    expect(rows[0]!.at).toBeGreaterThan(rows[1]!.at);
    expect(shas.size).toBe(2);
  });

  test("a note with no history yields no rows", () => {
    const root = vault();
    const { rows, shas } = gitLogRows(root, "entities/never-committed.md");
    expect(rows).toEqual([]);
    expect(shas.size).toBe(0);
  });
});

describe("journalLogRows", () => {
  test("matches a queue-era record by its own commit field", () => {
    const root = vault();
    mkdirSync(join(root, "journal", "queue"), { recursive: true });
    writeFileSync(
      join(root, "journal", "queue", "q-run-1.json"),
      JSON.stringify({
        run: "q-run-1",
        startedAt: "2026-08-01T10:05:00Z",
        lane: "fast",
        verb: "file",
        commit: "deadbeef",
      })
    );
    const rows = journalLogRows(root, {
      path: "entities/note.md",
      commitShas: new Set(["deadbeef"]),
    });
    expect(rows).toEqual([
      { at: Date.parse("2026-08-01T10:05:00Z"), actor: "triage", action: "file" },
    ]);
  });

  test("falls back to a plain text match against the path/id (legacy pre-queue records)", () => {
    const root = vault();
    mkdirSync(join(root, "journal", "deep"), { recursive: true });
    writeFileSync(
      join(root, "journal", "deep", "2026-07-01-legacy.json"),
      JSON.stringify({
        startedAt: "2026-07-01T09:00:00Z",
        moved: [{ from: "inbox/x.md", to: "entities/note.md" }],
      })
    );
    const rows = journalLogRows(root, { path: "entities/note.md" });
    expect(rows).toEqual([
      { at: Date.parse("2026-07-01T09:00:00Z"), actor: "deep", action: "run" },
    ]);
  });

  test("a record mentioning neither the commit nor the path/id is not returned", () => {
    const root = vault();
    mkdirSync(join(root, "journal", "queue"), { recursive: true });
    writeFileSync(
      join(root, "journal", "queue", "q-run-2.json"),
      JSON.stringify({
        startedAt: "2026-08-01T00:00:00Z",
        lane: "fast",
        verb: "link",
        commit: "unrelated-sha",
      })
    );
    expect(
      journalLogRows(root, {
        path: "entities/note.md",
        id: "n1",
        commitShas: new Set(["deadbeef"]),
      })
    ).toEqual([]);
  });

  test("no journal dirs at all → empty, never throws", () => {
    const root = vault();
    expect(journalLogRows(root, { path: "entities/note.md" })).toEqual([]);
  });

  test("a stage record naming the note in its VERDICTS is an opinion, not a touch — skipped (#308)", () => {
    const root = vault();
    mkdirSync(join(root, "journal", "queue"), { recursive: true });
    writeFileSync(
      join(root, "journal", "queue", "2026-08-13T10-00-00-stg1.json"),
      JSON.stringify({
        run: "2026-08-13T10-00-00-stg1",
        stage: "resolve",
        shadow: true,
        startedAt: "2026-08-13T10:00:00Z",
        verdicts: { Ada: { matcher: "match", final: "entities/note.md" } },
      })
    );
    expect(journalLogRows(root, { path: "entities/note.md" })).toEqual([]);
  });
});

describe("noteLog — the full merge", () => {
  test("merges frontmatter, git, and journal into one newest-first log", () => {
    const root = vault();
    const path = "entities/note.md";
    mkdirSync(join(root, "journal", "queue"), { recursive: true });
    writeFileSync(
      join(root, path),
      "---\nid: n1\nreceived: 2026-08-01T09:00:00Z\nfrom: granola\n---\n\nbody\n"
    );
    const sha = commitAs(root, "intake", "intake: n1 — a note", "2026-08-01T09:00:01Z");
    writeFileSync(
      join(root, "journal", "queue", "q-run-1.json"),
      JSON.stringify({ startedAt: "2026-08-01T09:00:01Z", lane: "fast", verb: "file", commit: sha })
    );

    const rows = noteLog(root, path);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.at).toBeGreaterThanOrEqual(rows.at(-1)!.at); // newest-first
    expect(rows.some((r) => r.action === "landed")).toBe(true);
  });

  test("an unreadable/missing note degrades to git+journal only, never throws", () => {
    const root = vault();
    expect(() => noteLog(root, "entities/does-not-exist.md")).not.toThrow();
    expect(noteLog(root, "entities/does-not-exist.md")).toEqual([]);
  });
});
