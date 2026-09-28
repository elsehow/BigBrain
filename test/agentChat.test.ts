/**
 * agent-chat capture (#47) — the three decisions in
 * integrations/agent-chat/segment.ts.
 *
 * The fixture below is built from a REAL transcript's shape, sampled
 * 2026-08-11 off a 696-line session: every line type that session actually
 * carried appears here, in the proportions that made the projection worth
 * doing (161 tool_use + 161 tool_result against 30 assistant text blocks).
 * That is why the drop list is written as data rather than prose — these are
 * observations, not guesses about what Claude Code might emit.
 */

import { describe, expect, test } from "bun:test";
import {
  SESSION_VOICE_MIN_TURNS,
  TRANSCRIPT_MARK,
  TRANSCRIPT_MARK_LEGACY,
  projectSegment,
  renderTurns,
  renderUserSide,
  userSide,
} from "../lib/transcriptProjection";

const line = (o: Record<string, unknown>): string => JSON.stringify(o);

test("Claude capture stamps the last real session model, including tool-only replies", () => {
  const jsonl = [
    line({ type: "assistant", message: { model: "claude-sonnet-4-5", content: [] } }),
    line({ type: "assistant", message: { model: "claude-fable-5-1", content: [{ type: "tool_use", name: "Bash" }] } }),
    line({ type: "assistant", isSidechain: true, message: { model: "claude-haiku-4-5" } }),
    line({ type: "assistant", message: { model: "<synthetic>" } }),
    line({ type: "user", message: { model: "not-the-worker" } }),
    '{"type":"assistant","message":{"model":',
  ].join("\n");
  expect(projectSegment(jsonl).model).toBe("claude-fable-5-1");

});

const userText = (text: string, extra: Record<string, unknown> = {}): string =>
  line({
    type: "user",
    userType: "external",
    cwd: "/w/proj",
    sessionId: "s-1",
    timestamp: "2026-08-11T10:00:00Z",
    message: { content: text },
    ...extra,
  });

const assistant = (content: unknown[], extra: Record<string, unknown> = {}): string =>
  line({
    type: "assistant",
    cwd: "/w/proj",
    sessionId: "s-1",
    timestamp: "2026-08-11T10:01:00Z",
    message: { content },
    ...extra,
  });

/** Every non-message line type the real session carried. */
const BOOKKEEPING = [
  "permission-mode",
  "mode",
  "last-prompt",
  "ai-title",
  "attachment",
  "custom-title",
  "agent-name",
  "file-history-delta",
  "file-history-snapshot",
  "system",
].map((type) =>
  line({
    type,
    cwd: "/w/proj",
    sessionId: "s-1",
    timestamp: "2026-08-11T10:02:00Z",
    payload: "x".repeat(500),
  })
);

describe("projectSegment: conversation survives, bookkeeping does not", () => {
  test("user and assistant prose, plus tool NAMES", () => {
    const seg = projectSegment(
      [
        userText("why can't you merge?"),
        assistant([
          { type: "thinking", thinking: "The block came from the classifier…" },
          { type: "text", text: "Reads work fine — it's the permission layer." },
          { type: "tool_use", name: "Bash", input: { command: "gh pr list --repo x --limit 5" } },
        ]),
        line({
          type: "user",
          cwd: "/w/proj",
          sessionId: "s-1",
          timestamp: "2026-08-11T10:01:30Z",
          message: {
            content: [{ type: "tool_result", content: "180\t...\t185\t...".repeat(200) }],
          },
        }),
      ].join("\n")
    );

    expect(seg.turns).toEqual([
      { speaker: "user", text: "why can't you merge?" },
      { speaker: "assistant", text: "Reads work fine — it's the permission layer.\n[tool: Bash]" },
    ]);
    // The three things that are most of the bytes are all gone.
    const out = renderTurns(seg.turns);
    expect(out).not.toContain("thinking");
    expect(out).not.toContain("The block came from");
    expect(out).not.toContain("gh pr list"); // tool_use.input
    expect(out).not.toContain("180\t"); // tool_result payload
  });

  test("a tool_use with no text still yields a turn — the tool IS the turn", () => {
    // An assistant message that only calls tools is a real move in the
    // conversation. Dropping it would make a debugging session read as if the
    // assistant went silent for ten minutes.
    const seg = projectSegment(
      assistant([{ type: "tool_use", name: "Read", input: { file_path: "/x" } }])
    );
    expect(seg.turns).toEqual([{ speaker: "assistant", text: "[tool: Read]" }]);
  });

  test("every bookkeeping line type is dropped, and contributes no turns", () => {
    const seg = projectSegment([userText("hi"), ...BOOKKEEPING].join("\n"));
    expect(seg.turns).toEqual([{ speaker: "user", text: "hi" }]);
    expect(seg.malformed).toBe(0); // they PARSED; they were just not conversation
  });

  test("an unknown future line type is dropped by default, not landed as garbage", () => {
    // The projection keeps user/assistant and drops the rest, so a type
    // invented in a later Claude Code release cannot leak into the record.
    const seg = projectSegment(
      [userText("hi"), line({ type: "some-new-2027-thing", text: "surprise" })].join("\n")
    );
    expect(seg.turns).toHaveLength(1);
  });

  test("sidechain (subagent) lines are dropped", () => {
    const seg = projectSegment(
      [
        userText("go"),
        assistant([{ type: "text", text: "sub-agent thinking out loud" }], { isSidechain: true }),
      ].join("\n")
    );
    expect(seg.turns).toEqual([{ speaker: "user", text: "go" }]);
  });

  test("a half-written last line is counted, never fatal", () => {
    // The file is being appended to by another process while we read it, so
    // the tail can be a partial line. One bad line must not blind the good
    // ones around it.
    const seg = projectSegment(
      [
        userText("first"),
        '{"type":"assistant","mess',
        assistant([{ type: "text", text: "second" }]),
      ].join("\n")
    );
    expect(seg.malformed).toBe(1);
    expect(seg.turns.map((t) => t.text)).toEqual(["first", "second"]);
  });

  test("a JSON line that isn't an object is malformed, not a turn", () => {
    const seg = projectSegment(['"a string"', "[1,2,3]", "null", userText("real")].join("\n"));
    expect(seg.malformed).toBe(3);
    expect(seg.turns).toHaveLength(1);
  });

  test("identity is read off the LINES, never off the file path", () => {
    // The project directory name is a mangled cwd (-Users-elsehow-Projects);
    // reversing that mangling is guesswork when every line states both.
    const seg = projectSegment(
      [userText("a"), assistant([{ type: "text", text: "b" }])].join("\n")
    );
    expect(seg.sessionId).toBe("s-1");
    expect(seg.cwds).toEqual(["/w/proj"]);
    expect(seg.lastAt).toBe("2026-08-11T10:01:00Z");
  });

  test("cwd and timestamps are collected from bookkeeping lines too", () => {
    // A segment whose conversation is entirely sidechain still has to be
    // attributable and excludable.
    const seg = projectSegment(
      [line({ type: "system", cwd: "/w/other", timestamp: "2026-08-11T11:00:00Z" })].join("\n")
    );
    expect(seg.cwds).toEqual(["/w/other"]);
    expect(seg.lastAt).toBe("2026-08-11T11:00:00Z");
    expect(seg.turns).toEqual([]);
  });

  test("empty and whitespace-only input is empty, not an error", () => {
    expect(projectSegment("").turns).toEqual([]);
    expect(projectSegment("\n\n  \n").malformed).toBe(0);
  });
});

describe("projectSegment: the door tells the harness from the owner", () => {
  test("isMeta and isCompactSummary lines are dropped; the typed line beside them stays", () => {
    const seg = projectSegment(
      [
        userText("Base directory for this skill: /x", { isMeta: true }),
        userText("This session is being continued from a previous conversation…", { isCompactSummary: true }),
        userText("real"),
      ].join("\n")
    );
    expect(seg.turns).toEqual([{ speaker: "user", text: "real" }]);
  });

  test("an unflagged notice lands labelled harness:; a reminder is cut wherever it rides, and a turn with nothing left is not a turn", () => {
    const seg = projectSegment(
      [
        userText("<command-name>/compact</command-name>"),
        userText("<task-notification>\n<task-id>x</task-id>\n</task-notification>"),
        userText("[Image: source: /Users/n/.claude/image-cache/1.png]"),
        userText("[Request interrupted by user]"),
        userText("<system-reminder>\n# Your memory\n</system-reminder>"),
        userText("[Image #27] text is a little illegible here\n<system-reminder>the date changed</system-reminder>"),
        assistant([{ type: "text", text: "Looking." }]),
      ].join("\n")
    );
    expect(seg.turns.map((t) => t.speaker)).toEqual(["harness", "harness", "harness", "harness", "user", "assistant"]);
    expect(seg.turns[1]).toEqual({ speaker: "harness", text: "<task-notification>\n<task-id>x</task-id>\n</task-notification>" });
    expect(seg.turns[4]).toEqual({ speaker: "user", text: "[Image #27] text is a little illegible here" });
    expect(renderTurns(seg.turns)).toContain("\n\nharness: [Request interrupted by user]\n\nuser: [Image #27]");
  });
});

describe("the owner's side — what intake reads of a session (2026-09-06, revisiting #528)", () => {
  const body = [
    "# Claude Code — BigBrain",
    "",
    "Session `abc`, lines 1–40, in `/Users/demo/Projects/BigBrain`.",
    "",
    TRANSCRIPT_MARK,
    "",
    renderTurns([
      { speaker: "user", text: "not crazy about the blackened edges. i like the flat look." },
      { speaker: "assistant", text: "Reverting the vignette.\n\n[tool: Edit]" },
      { speaker: "user", text: "pasted:\n\nline one\n\nline two" },
      { speaker: "assistant", text: "Done." },
      { speaker: "user", text: "merge and cut a release." },
    ]),
    "",
  ].join("\n");

  test("keeps the header and the owner's turns whole, and counts both speakers", () => {
    const side = userSide(body);
    expect(side.header).toBe("# Claude Code — BigBrain\n\nSession `abc`, lines 1–40, in `/Users/demo/Projects/BigBrain`.");
    expect(side.total).toBe(5);
    expect(side.turns).toEqual([
      "not crazy about the blackened edges. i like the flat look.",
      "pasted:\n\nline one\n\nline two",
      "merge and cut a release.",
    ]);
  });

  test("renders the header, a seam that says what is missing, and none of the assistant", () => {
    const shown = renderUserSide(userSide(body));
    expect(shown.startsWith("# Claude Code — BigBrain\n")).toBe(true);
    expect(shown).toContain("--- THE OWNER'S SIDE (3 of 5 turns;");
    expect(shown).toContain("user: merge and cut a release.");
    expect(shown).not.toContain("assistant:");
    expect(shown).not.toContain("[tool: Edit]");
  });

  test("under the current mark the reader keeps user: lines verbatim and knows no harness's forms", () => {
    const side = userSide([TRANSCRIPT_MARK, "", renderTurns([
      { speaker: "harness", text: "<task-notification>\n<task-id>x</task-id>\n</task-notification>" },
      { speaker: "user", text: "This session is being continued — no it isn't, i typed that" },
      { speaker: "assistant", text: "Noted." },
    ])].join("\n"));
    expect(side.turns).toEqual(["This session is being continued — no it isn't, i typed that"]);
    expect(side.total).toBe(3);
  });

  test("under the legacy mark (landed before the door labelled the harness) the shim applies", () => {
    const side = userSide([TRANSCRIPT_MARK_LEGACY, "", renderTurns([
      { speaker: "user", text: "<command-name>/compact</command-name>" },
      { speaker: "user", text: "<local-command-stdout>Compacted</local-command-stdout>" },
      { speaker: "user", text: "<task-notification>\n<task-id>x</task-id>\n</task-notification>" },
      { speaker: "user", text: "This session is being continued from a previous conversation that ran out of context. Summary: …" },
      { speaker: "user", text: "[Image: original 2816x1536, displayed at 2000x1091.]" },
      { speaker: "user", text: "Base directory for this skill: /a/b" },
      { speaker: "user", text: "<system-reminder>\n# Your memory\n</system-reminder>" },
      { speaker: "user", text: "[Image #27] text is a little illegible here\n<system-reminder>a reminder</system-reminder>" },
      { speaker: "assistant", text: "Looking." },
    ])].join("\n"));
    expect(side.turns).toEqual(["[Image #27] text is a little illegible here"]);
    expect(side.total).toBe(9);
  });

  test("a body without the seam is turns alone; three typed turns is the floor", () => {
    const bare = userSide(renderTurns([{ speaker: "assistant", text: "hi" }, { speaker: "user", text: "hello" }]));
    expect(bare).toEqual({ header: "", turns: ["hello"], total: 2 });
    expect(userSide("")).toEqual({ header: "", turns: [], total: 0 });
    expect(SESSION_VOICE_MIN_TURNS).toBe(3);
  });
});
