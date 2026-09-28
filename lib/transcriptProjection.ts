/** Conversation projection and historical transcript readers. No capture or upload machinery. */

/** One projected turn. `speaker` is the transcript's own `type`, not an
 * interpretation of it — door fidelity is structural here, because the JSONL
 * distinguishes user from assistant and we never have to guess. */
export interface Turn {
  /** `harness` is a `user` line the harness typed — its own notice in the
   * owner's voice — labelled so, never dropped: the label is an inference
   * from the text (below), and an inference stays on the record where it
   * can be audited. Flagged bookkeeping is dropped like the rest. */
  speaker: "user" | "assistant" | "harness";
  text: string;
}

/** THE HARNESS IN THE OWNER'S VOICE — Claude Code's own notices that arrive
 * as `user` lines the JSONL does not flag (2026-09-06, a live session: 0 of
 * 26 task notifications and 0 of 6 slash-command echoes carried `isMeta`):
 * a command's echo and output, a background task's report, the context
 * summary re-fed after a compaction, an image's or a skill's preamble, an
 * interruption. This list is Claude Code's, and it lives at Claude Code's
 * door: another agent's door brings its own, and the readers downstream
 * never learn either — they keep `user:` lines and nothing else. */
const HARNESS_TURN =
  /^(<local-command|<command-name>|<command-message>|<task-notification>|\[Image: |\[Request interrupted by user|Base directory for this skill:|This session is being continued from a previous conversation)/;

/** A `<system-reminder>` rides INSIDE a typed turn's text block (the
 * SessionStart memory dump, a date change), so it is cut out of the turn
 * rather than costing it. */
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** What the owner typed, with the harness's reminders cut out — or null
 * when the harness typed the whole turn, or nothing was said. The door's
 * rule in one call, for `userSide`'s shim over bodies landed before the
 * door applied it. */
export function typedTurn(text: string): string | null {
  const typed = text.replace(SYSTEM_REMINDER, "").trim();
  return !typed || HARNESS_TURN.test(typed) ? null : typed;
}

// Claude Code's own bookkeeping lines — permission-mode, mode, last-prompt,
// ai-title, attachment, custom-title, agent-name, file-history-delta,
// file-history-snapshot, system (all observed in one 696-line session,
// 2026-08-11) — are not matched against: the projection keeps
// `user`/`assistant` and drops everything else, so a line type invented next
// release is dropped by default rather than landing as garbage. A constant
// listing them read as a rule and was one nobody applied; it went 2026-08-30.

/** Text out of one message's `content`, which is either a bare string (the
 * simple user turn) or an array of typed blocks.
 *
 * KEPT: `text` blocks, and the NAME of each `tool_use`.
 * DROPPED: `thinking` (Nick's call, 2026-08-11 — candid internal reasoning
 * is not what a session is filed for, and it stays in the blob),
 * `tool_use.input` and `tool_result` payloads (most of the bytes and all of
 * the noise — 3.02 MB of real transcript projects to 14 KB), and `image`.
 *
 * Tool NAMES survive because they are the shape of the work: "[tool: Bash]"
 * is what makes a filed session legible as debugging rather than chatting.
 * Their arguments do not — a diff, a file read, a 200-line command output
 * are recoverable from the blob and worthless in the record. */
function blockText(content: unknown): string[] {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const block = b as { type?: unknown; text?: unknown; name?: unknown };
    if (block.type === "text" && typeof block.text === "string" && block.text.trim())
      out.push(block.text);
    else if (block.type === "tool_use" && typeof block.name === "string" && block.name)
      out.push(`[tool: ${block.name}]`);
  }
  return out;
}

/** What one landed segment came out as: the turns, plus the facts run.ts
 * needs for the envelope. `sessionId` and `cwd` are read off the LINES, never
 * off the file path — the project directory name is a mangled cwd
 * (`-Users-elsehow-Projects`) and reversing that mangling is guesswork when
 * every line states both plainly. */
export interface Projection {
  turns: Turn[];
  /** Last concrete model on a main-session assistant message. */
  model?: string;
  /** Distinct `cwd` values seen, first-seen order. Normally one; a resumed
   * session moved between directories can carry more, and the caller decides
   * (it excludes on ALL of them — one excluded directory taints the segment,
   * because half a conversation is not a safer thing to file than none). */
  cwds: string[];
  sessionId: string | null;
  /** The newest `timestamp` seen, ISO — what the settle test measures quiet
   * against. Null when no line carried one. */
  lastAt: string | null;
  /** Lines that did not parse as JSON. Reported, never fatal. */
  malformed: number;
}

/** Project one raw JSONL segment.
 *
 * TOLERANT BY CONTRACT: a transcript is an append-only file being written by
 * another process, so the last line of a segment can be a half-written one.
 * A line that does not parse is counted and skipped — it must never blind
 * the well-formed lines around it, and it must never cost the segment its
 * landing. (Same rule as envelope.ts's parse: the door meets the world's
 * mess.)
 *
 * `isSidechain: true` lines are subagent chatter, dropped in this slice: a
 * subagent's inner monologue is not the user's conversation, and including
 * it would file the same work twice — once as the agent's turns and once as
 * the subagent's. Recoverable from the blob if that turns out to be wrong. */
export function projectSegment(jsonl: string): Projection {
  const turns: Turn[] = [];
  const cwds: string[] = [];
  let sessionId: string | null = null;
  let lastAt: string | null = null;
  let malformed = 0;
  let model: string | undefined;

  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let line: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        malformed++;
        continue;
      }
      line = parsed as Record<string, unknown>;
    } catch {
      malformed++;
      continue;
    }

    // cwd/sessionId/timestamp are read from EVERY line type, including the
    // bookkeeping ones: a segment whose conversation is all sidechain still
    // has to be attributable and excludable.
    const cwd = line["cwd"];
    if (typeof cwd === "string" && cwd && !cwds.includes(cwd)) cwds.push(cwd);
    const sid = line["sessionId"];
    if (sessionId === null && typeof sid === "string" && sid) sessionId = sid;
    const at = line["timestamp"];
    if (typeof at === "string" && at && (lastAt === null || at > lastAt)) lastAt = at;

    if (line["isSidechain"] === true) continue;
    // Two more of Claude Code's own, flagged on the line so the drop is
    // structural: `isMeta` (text the harness put in the user's mouth — a
    // skill's base directory, an image's dimensions) and `isCompactSummary`
    // (the model's own précis of a truncated context, re-fed as a user
    // turn). Kept, both read as the owner speaking: 231 summaries, 4.1 MB,
    // in a month of the record (2026-09-06).
    if (line["isMeta"] === true || line["isCompactSummary"] === true) continue;
    const speaker = line["type"];
    if (speaker !== "user" && speaker !== "assistant") continue;

    const message = line["message"];
    if (!message || typeof message !== "object") continue;
    const recordedModel = (message as { model?: unknown }).model;
    if (speaker === "assistant" && typeof recordedModel === "string" &&
        recordedModel.trim() && !recordedModel.trim().startsWith("<") && recordedModel.trim().toLowerCase() !== "n/a")
      model = recordedModel.trim();
    const text = blockText((message as { content?: unknown }).content)
      .join("\n")
      .trim();
    if (!text) continue;
    if (speaker === "assistant") {
      turns.push({ speaker, text });
      continue;
    }
    // A user line is the owner's or the harness's (HARNESS_TURN): the door
    // says which, since only the door knows this harness's forms. A
    // `<system-reminder>` is cut wherever it rides — it is the harness's
    // wrapper, not anyone's turn (the SessionStart memory dump, 250 KB, sat
    // inside the first typed turn of a session) — and a line with nothing
    // left said nothing.
    const bare = text.replace(SYSTEM_REMINDER, "").trim();
    if (!bare) continue;
    turns.push({ speaker: HARNESS_TURN.test(bare) ? "harness" : "user", text: bare });
  }

  return { turns, cwds, sessionId, lastAt, malformed, ...(model ? { model } : {}) };
}

/** The projected turns as the item's body text. Speaker-labeled, one blank
 * line between turns — the plainest rendering that survives being read by a
 * person and by a model with equal ease. */
export function renderTurns(turns: Turn[]): string {
  return turns.map((t) => `${t.speaker}: ${t.text}`).join("\n\n");
}

/** The line that opens the transcript in a landed item's body — the seam
 * `userSide` reads the body back along, and the body's own word for which
 * projection made it: this one labels the harness's turns. */
export const TRANSCRIPT_MARK =
  "--- TRANSCRIPT (projection: turns and tool names, the harness's own notices labelled harness:; arguments and results are in the attached raw segment) ---";

/** The seam of every segment landed before 2026-09-06, when the door did
 * not tell the harness from the owner: its `user:` turns need the shim
 * (`typedTurn`) that the door now applies. Immutable sources keep it. */
export const TRANSCRIPT_MARK_LEGACY =
  "--- TRANSCRIPT (projection: turns and tool names; arguments and results are in the attached raw segment) ---";

// ── the owner's side ───────────────────────────────────────────────────────

/** How many turns the owner must have typed before a segment is the
 * gardener's to read (its owner's side, below). Fewer is a record: a
 * one-shot question, a sub-agent's run — the median session in a month of
 * the record had one. */
export const SESSION_VOICE_MIN_TURNS = 3;

/** A landed segment's body read back along its own seams: the header
 * (title, session, cwd — which project this was) and the turns, the
 * owner's kept and the assistant's counted. */
export interface UserSide {
  header: string;
  /** The owner's turns, in order, each whole — a pasted paragraph stays. */
  turns: string[];
  /** Turns of either speaker. */
  total: number;
}

/** THE OWNER'S SIDE of a transcript — what intake reads (2026-09-06,
 * revisiting #528). A fortnight of reading whole transcripts (2,219
 * assertions off 509 segments, 2026-08-12..26) put every kind of noise on
 * the assistant's side: meetings the agent read re-asserted with the
 * session as their source, build logs, test fixtures, the agent's advice
 * filed as fact. Every claim worth keeping was in the owner's own turns.
 * So the assistant's turns are not evidence — whatever it read arrives
 * through its own door — and the cut is made here, mechanically, not by a
 * prompt asking a model to look away. By line: one that opens `user: `,
 * `assistant: ` or `harness: ` starts a turn (renderTurns' shape) and only
 * `user:` is kept — the reader knows no harness's forms; the lines before
 * the mark are the header; a body without a mark is turns alone. A body
 * under the LEGACY mark was rendered before the door labelled the
 * harness, so its user turns pass through `typedTurn` here instead. */
export function userSide(body: string): UserSide {
  const lines = body.split("\n");
  const seam = lines.findIndex((l) => l === TRANSCRIPT_MARK || l === TRANSCRIPT_MARK_LEGACY || l === PILOT_TRANSCRIPT_MARK);
  const legacy = seam >= 0 && lines[seam] === TRANSCRIPT_MARK_LEGACY;
  const header = (seam >= 0 ? lines.slice(0, seam).join("\n").trim() : "") +
    (seam >= 0 && lines[seam] === PILOT_TRANSCRIPT_MARK ? "\n\nThe user's turns are recognized speech, not typed words." : "");
  const turns: string[] = [];
  let total = 0;
  let open: { user: boolean; lines: string[] } | null = null;
  const close = (): void => {
    if (open?.user) {
      const text = open.lines.join("\n");
      const typed = legacy ? typedTurn(text) : text.trim();
      if (typed) turns.push(typed);
    }
    open = null;
  };
  for (const line of lines.slice(seam + 1)) {
    const m = /^(user|assistant|harness|pilot): /.exec(line);
    if (m) {
      close();
      total++;
      open = { user: m[1] === "user", lines: [line.slice(m[0].length)] };
    } else if (open) open.lines.push(line);
  }
  close();
  return { header, turns, total };
}

/** Also recognizes already-landed pilot segments; immutable records do not
 * need rewriting to receive the same owner-only gardening as other chats. */
export const PILOT_TRANSCRIPT_MARK = "--- TRANSCRIPT (the user's turns are recognized speech, not typed words; the pilot's are its spoken replies, with the tools it called) ---";

/** The owner's side as the gardener's inline body: the header kept (which
 * project, which session), then the owner's turns alone under a seam that
 * says what is missing, so a reader never mistakes the view for the
 * conversation. */
export function renderUserSide(side: UserSide): string {
  const seam = `--- THE OWNER'S SIDE (${side.turns.length} of ${side.total} turns; the assistant's turns, tool calls and results, and the harness's own notices, are not in this view) ---`;
  return [side.header, seam, side.turns.map((t) => `user: ${t}`).join("\n\n")].filter((s) => s).join("\n\n");
}

