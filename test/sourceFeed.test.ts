import { sourceSummary } from "../lib/sourceSummary";
import { intakePriority } from "../lib/intakeClass";
import { describe, expect, test } from "bun:test";
import { renderTurns, TRANSCRIPT_MARK } from "../lib/transcriptProjection";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSourceInsertionEvent, sourceInsertion, type SourceInsertion } from "../lib/insertionLog";
import { assertionEntityId, createAssertionEvent } from "../lib/assertionLog";
import { appendAndProjectAssertion, appendAndProjectDecline, appendAndProjectRevocation, openAssertionProjectionReadonly, projectSourceInsertion } from "../lib/assertionProjection";
import { createDeclineEvent } from "../lib/declineLog";
import { createRevocationEvent } from "../lib/revocationLog";
import {
  insertionStatus,
  readSourceInsertionPath,
  recentFromSourceLog,
  recentSourcePage,
  projectedFilerName,
  insertionFiler,
  sourceInsertionMarkdown,
  agentWritten,
} from "../lib/sourceFeed";
import { insertion } from "./support/vault";
import { putBlob } from "../lib/blobs";

test("existing Claude transcripts recover model from their raw attachments without rewriting events", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-source-model-"));
  const raw = Buffer.from(JSON.stringify({ type: "assistant", message: { model: "claude-fable-5-1" } }) + "\n");
  const blob = putBlob(root, raw);
  const event = insertion({ envelope: { source: "agent-chat", from: "claude-code", from_kind: "agent", attachments: [{ name: "session-1-2.jsonl", sha256: blob.sha256 }] } });
  const before = JSON.stringify(event);
  expect(recentFromSourceLog(root, [sourceSummary(event)])[0]!.agentModel).toBe("claude-fable-5-1");
  expect(JSON.stringify(event)).toBe(before);
  expect(insertionFiler(event).agentModel).toBeUndefined();
  const declared = { ...event, envelope: { ...event.envelope, agent_model: "claude-sonnet-4-5" } };
  expect(insertionFiler(declared, root).agentModel).toBe("claude-sonnet-4-5");
  expect(insertionFiler({ ...event, envelope: { ...event.envelope, agent_model: "n/a" } }, root).agentModel).toBe("claude-fable-5-1");
  const missingRoot = mkdtempSync(join(tmpdir(), "bb-missing-model-"));
  expect(insertionFiler(event, missingRoot).agentModel).toBeUndefined();
  putBlob(missingRoot, raw);
  expect(insertionFiler(event, missingRoot).agentModel).toBe("claude-fable-5-1");
  const badAttachment = { ...event, envelope: { ...event.envelope, attachments: [{ name: "session.jsonl", sha256: "../../private" }] } };
  expect(insertionFiler(badAttachment, root).agentModel).toBeUndefined();
  const codex = { ...event, envelope: { ...event.envelope, from: "codex" } };
  expect(insertionFiler(codex, root).agentModel).toBeUndefined();
});

// The viewer loads a source's remote images unasked only when no agent wrote
// it (V2View cleanHtml): whatever an agent drops can name an address, and
// loading the image is a request there.
test("an agent's source is agent-written; a person's drop, mail and a feed are not", () => {
  const written = (envelope: Record<string, unknown>) => agentWritten(sourceInsertion({ id: "src-x", ...envelope }, "![](https://img.example.com/a.png)"));
  for (const envelope of [
    { source: "pilot", from: "pilot", from_kind: "agent", kind: "note" },
    { source: "mcp", from: "claude-desktop", from_kind: "agent", kind: "note" },
    { source: "api", from: "desk-agent", from_kind: "agent", submitted_via: "desk-agent" },
    { source: "api", from: "ada@example.com", from_kind: "person", kind: "agent-chat" },
    { from: "pilot", from_kind: "agent", kind: "pilot-chat" },
    { source: "claude-code", kind: "note" },
    { source: "codex", kind: "note" },
  ]) expect([envelope, written(envelope)]).toEqual([envelope, true]);
  for (const envelope of [
    { source: "web", kind: "note" },
    { source: "api", from: "ada@example.com", from_kind: "person", kind: "web-clip", submitted_via: "chrome on desk" },
    { source: "email", from: "Ada <ada@example.com>", from_kind: "person", kind: "email" },
    { source: "rss", kind: "article" },
    { source: "granola", from: "granola", from_kind: "service", kind: "meeting" },
  ]) expect([envelope, written(envelope)]).toEqual([envelope, false]);
});

const source = (id: string, received: string, title: string): SourceInsertion =>
  insertion({
    id,
    author: { kind: "user", id: "nick@example.com" },
    title,
    body: `Discussable body for ${title}.`,
    envelope: {
      type: "reference", kind: "meeting", category: "meeting",
      from: "nick@example.com", from_kind: "person", source: "web", received,
    },
    received_at: received,
  });

describe("native source feed", () => {
  test("Codex drops and transcripts keep their identity across feed and graph facets", () => {
    const envelopes = [
      { source: "api", from: "Codex", from_kind: "agent", submitted_via: "codex" },
      { source: "api", from: "Codex (GPT-6)", from_kind: "agent", submitted_via: "codex" },
      { source: "api", from: "Codex (GPT-6)", from_kind: "agent", submitted_via: "nick laptop" },
      { source: "api", from: "GPT-6 (Codex)", from_kind: "agent", submitted_via: "claude code on laptop" },
      { source: "agent-chat", from: "codex", from_kind: "agent", submitted_via: "codex on laptop" },
    ];
    const root = mkdtempSync(join(tmpdir(), "bb-codex-feed-"));
    for (const [i, envelope] of envelopes.entries()) {
      const item = insertion({
        id: `ins_${String(i + 1).repeat(24)}`,
        author: { kind: "agent", id: envelope.from },
        title: "A Codex finding", body: "A settled finding.", envelope,
      });
      appendSourceInsertionEvent(root, item);
      expect(projectedFilerName(envelope)).toBe("codex");
    }
    const rows = recentFromSourceLog(root);
    expect(rows).toHaveLength(envelopes.length);
    // A person's name alone is not evidence that Codex composed the note.
    expect(projectedFilerName({ source: "api", from: "codex@example.com", from_kind: "person" })).toBe("other");
  });

  test("projects stable delivery families while retaining exact connection names in the envelope", () => {
    expect(projectedFilerName({
      source: "agent-chat", from: "claude-code", submitted_via: "claude code on Mac-mini.local",
    })).toBe("claude code");
    expect(projectedFilerName({
      source: "api", from: "send-to-bigbrain", submitted_via: "zen browser 2026-08",
    })).toBe("browser extension");
    expect(projectedFilerName({
      source: "api", from: "send-to-bigbrain", submitted_via: "chrome",
    })).toBe("browser extension");
    expect(projectedFilerName({ source: "import", from: "granola" })).toBe("granola");
    expect(projectedFilerName({
      source: "api", from: "Claude Opus 5 (Claude Code)",
      submitted_via: "claude code on Mac-mini.local",
    })).toBe("claude code");
    expect(projectedFilerName({ source: "import", from: "nick@example.com" })).toBe("import");
  });

  test("demotes legacy and one-off arrival routes to the grouped 'other' family (#433)", () => {
    // FILED BY is a connector filter (Nick, 2026-08-21): retired connection
    // cards, the mail door, cli drops, and name-less API tokens are real
    // provenance but not current connectors — one grouped chip, never their
    // own. The exact spellings stay in the envelope.
    expect(projectedFilerName({
      source: "api", from: "nick@example.com", submitted_via: "nick laptop",
    })).toBe("other");
    expect(projectedFilerName({ source: "unknown", submitted_via: "journal-confirmed connection" }))
      .toBe("other");
    // the mail DOOR of 2026-08 was a legacy route; the email INTEGRATION
    // (integrations/email/, #749) is a source of its own, like granola
    expect(projectedFilerName({ source: "email", from: "nick@example.com" })).toBe("email");
    expect(projectedFilerName({ source: "outbox", from: "nick@example.com" })).toBe("other");
    expect(projectedFilerName({ source: "cli" })).toBe("other");
    expect(projectedFilerName({ source: "api" })).toBe("other");
  });

  test("lists immutable source events newest-first without reference files", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-source-feed-"));
    const older = source("ins_111111111111111111111111", "2026-08-17T10:00:00Z", "Older");
    const newer = source("ins_222222222222222222222222", "2026-08-18T10:00:00Z", "Newer");
    appendSourceInsertionEvent(root, older);
    appendSourceInsertionEvent(root, newer);

    expect(recentFromSourceLog(root)).toEqual([
      expect.objectContaining({
        path: "log/insertions/2026-08/ins_222222222222222222222222.json",
        insertionId: newer.id, id: newer.source_id, title: "Newer",
        type: "source", status: "pending", band: "person",
      }),
      expect.objectContaining({ title: "Older" }),
    ]);
    expect(recentFromSourceLog(root).every((row) => row.category === undefined)).toBe(true);
  });

  test("reads only an exact insertion-log path and renders its discussable body", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-source-read-"));
    const item = source("ins_333333333333333333333333", "2026-08-18T10:00:00Z", "A source");
    const path = appendSourceInsertionEvent(root, item).path;
    expect(readSourceInsertionPath(root, path)).toEqual(item);
    expect(readSourceInsertionPath(root, "log/insertions/2026-08/../../vault.yaml")).toBeUndefined();
    expect(sourceInsertionMarkdown(item)).toContain("type: source");
    expect(sourceInsertionMarkdown(item)).not.toContain("category:");
    expect(sourceInsertionMarkdown(item)).toContain('title: "A source"');
    expect(sourceInsertionMarkdown(item)).toContain(item.body);
  });

  test("pages the full source history and marks its real end", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-source-page-"));
    appendSourceInsertionEvent(root, source("ins_111111111111111111111111", "2026-08-17T10:00:00Z", "Oldest"));
    appendSourceInsertionEvent(root, source("ins_222222222222222222222222", "2026-08-18T10:00:00Z", "Middle"));
    appendSourceInsertionEvent(root, source("ins_333333333333333333333333", "2026-08-19T10:00:00Z", "Newest"));

    expect(recentSourcePage(root, 0, 2)).toEqual({
      recent: [expect.objectContaining({ title: "Newest" }), expect.objectContaining({ title: "Middle" })],
      nextOffset: 2,
      total: 3,
    });
    expect(recentSourcePage(root, 2, 2)).toEqual({
      recent: [expect.objectContaining({ title: "Oldest" })],
      nextOffset: null,
      total: 3,
    });
  });
});

describe("the INGESTED column's claim", () => {
  test("pure rule: cited → filed, declined → declined, never-intake kinds → record, else pending", () => {
    const clip = { kind: "web-clip", type: "reference", source: "api", from_kind: "agent" };
    expect(insertionStatus(intakePriority(clip, ""), false, false)).toBe("pending");
    expect(insertionStatus(intakePriority(clip, ""), true, false)).toBe("filed");
    expect(insertionStatus(intakePriority(clip, ""), false, true)).toBe("declined");
    expect(insertionStatus(intakePriority(clip, ""), true, true)).toBe("filed"); // a citation outranks a decline
    expect(insertionStatus(intakePriority({ kind: "observation" }, ""), false, false)).toBe("record");
    // a transcript is a record until it has an owner's side — three typed
    // turns — and then it is intake like any arrival (lib/intakeClass.ts)
    const chat = { kind: "agent-chat", source: "agent-chat" };
    expect(insertionStatus(intakePriority(chat, ""), false, false)).toBe("record");
    const spoken = `${TRANSCRIPT_MARK}\n\n${renderTurns([
      { speaker: "user", text: "a" }, { speaker: "assistant", text: "…" },
      { speaker: "user", text: "b" }, { speaker: "user", text: "c" },
    ])}`;
    expect(insertionStatus(intakePriority(chat, spoken), false, false)).toBe("pending");
    expect(insertionStatus(intakePriority(chat, spoken), true, false)).toBe("filed");
    expect(insertionStatus(intakePriority(chat, spoken), false, true)).toBe("declined");
  });

  test("rows read settlement: a clip is pending until an assertion cites it or a decline names it", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-source-feed-status-"));
    const clip = (id: string, t: string): SourceInsertion => ({
      ...source(id, t, `Clip ${id}`),
      author: { kind: "agent", id: "send-to-bigbrain" },
      envelope: { type: "reference", kind: "web-clip", from: "send-to-bigbrain", from_kind: "agent", source: "api" },
    });
    const waiting = clip("ins_aaaaaaaaaaaaaaaaaaaaaaa1", "2026-08-27T20:35:08.000Z");
    const cited = clip("ins_aaaaaaaaaaaaaaaaaaaaaaa2", "2026-08-27T20:30:00.000Z");
    const passed = clip("ins_aaaaaaaaaaaaaaaaaaaaaaa3", "2026-08-27T20:20:00.000Z");
    for (const item of [waiting, cited, passed]) appendSourceInsertionEvent(root, item);

    // Nothing has been cited yet: every arrival waits.
    expect(recentFromSourceLog(root).map((r) => r.status)).toEqual(["pending", "pending", "pending"]);

    for (const item of [waiting, cited, passed]) projectSourceInsertion(root, item);
    const zvi = { id: assertionEntityId("Zvi Mowshowitz"), label: "Zvi Mowshowitz" };
    appendAndProjectAssertion(root, createAssertionEvent({
      text: `[[${zvi.id}|Zvi]] gathers observations about writing.`, entities: [zvi], sources: [cited.id],
      author: { kind: "model", id: "gardener", invocation_id: "run-1" }, confidence: "direct",
      created_at: "2026-08-27T20:40:00.000Z",
      produced_by: { procedure: "intake-agent", version: "v1", invocation_id: "run-1", prompt_version: "p1" },
    }, new Map([[cited.id, cited]])));
    appendAndProjectDecline(root, createDeclineEvent({
      insertion_ids: [passed.id], reason: "boilerplate, nothing to keep", created_at: "2026-08-27T20:41:00.000Z",
      author: { kind: "model", id: "gardener", invocation_id: "run-1" },
      produced_by: { procedure: "intake-agent", version: "v1", invocation_id: "run-1", prompt_version: "p1" },
    }, new Map([[passed.id, passed]])));

    const rows = recentFromSourceLog(root);
    expect(rows.map((r) => [r.insertionId, r.status])).toEqual([
      [waiting.id, "pending"],
      [cited.id, "filed"],
      [passed.id, "declined"],
    ]);

    // Revoking the one assertion alone leaves the row "filed": the work view
    // does not re-queue a revoked-only insertion, so the check must not spin.
    const db = openAssertionProjectionReadonly(root);
    const aid = (db.query("SELECT assertion_id FROM assertion_sources WHERE insertion_id = ?").get(cited.id) as { assertion_id: string }).assertion_id;
    db.close();
    const gardener = { kind: "model" as const, id: "gardener", invocation_id: "run-2" };
    const produced = { procedure: "cleanup", version: "v1" };
    appendAndProjectRevocation(root, createRevocationEvent({
      assertion_id: aid, reason: "let in by a retired pre-pass", author: gardener, created_at: "2026-09-04T23:50:00.000Z", produced_by: produced,
    }));
    expect(recentFromSourceLog(root).find((r) => r.insertionId === cited.id)!.status).toBe("filed");
    // …but once a decline names it too, the decline is the record's standing word.
    appendAndProjectDecline(root, createDeclineEvent({
      insertion_ids: [cited.id], reason: "a machine notification", created_at: "2026-09-04T23:51:00.000Z",
      author: gardener, produced_by: produced,
    }, new Map([[cited.id, cited]])));
    expect(recentFromSourceLog(root).find((r) => r.insertionId === cited.id)!.status).toBe("declined");
  });
});

describe("a note ON a clip, in the native feed", () => {
  test("rows carry about/url, and the popup note wears the extension's door", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-source-feed-nest-"));
    const clip: SourceInsertion = {
      ...source("ins_bbbbbbbbbbbbbbbbbbbbbbb1", "2026-08-27T20:44:52.000Z", "Global central bankers gather in Jackson Hole"),
      author: { kind: "agent", id: "send-to-bigbrain" },
      envelope: {
        id: "api-2026-08-27T20-44-52-06fnk7", type: "reference", kind: "web-clip", url: "https://www.semafor.com/article/jackson-hole",
        from: "send-to-bigbrain", from_kind: "agent", source: "api", submitted_via: "firefox on Mac-mini.local",
      },
    };
    clip.source_id = "api-2026-08-27T20-44-52-06fnk7";
    const note: SourceInsertion = {
      ...source("ins_bbbbbbbbbbbbbbbbbbbbbbb2", "2026-08-27T20:44:57.000Z", "all eyes on warsh"),
      author: { kind: "user", id: "nick@example.com" },
      envelope: {
        id: "api-2026-08-27T20-44-57-0ejtkm", kind: "directive", about: ["api-2026-08-27T20-44-52-06fnk7"],
        from: "nick@example.com", from_kind: "person", submitted_via: "firefox on Mac-mini.local",
      },
    };
    for (const item of [clip, note]) appendSourceInsertionEvent(root, item);
    const rows = recentFromSourceLog(root);
    expect(rows.map((r) => r.title)).toEqual(["all eyes on warsh", "Global central bankers gather in Jackson Hole"]);
    expect(rows[0]).toMatchObject({ about: "api-2026-08-27T20-44-52-06fnk7", via: "browser extension" });
    expect(rows[1]).toMatchObject({ id: "api-2026-08-27T20-44-52-06fnk7", url: "https://www.semafor.com/article/jackson-hole", via: "browser extension" });
  });
});
