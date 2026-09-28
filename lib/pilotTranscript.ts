/** Recovery of speech transcripts spooled by older versions. New speech uses PilotChats. */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { appendFileSync } from "node:fs";
import type { IntakeReceipt } from "./intake";
import { landDrop } from "./landItem";
import { localDay, PilotError } from "./pilot";
import { spoolDir, ensureSpool } from "./spool";
import { fmBody, fmRaw, fmSerialize } from "./wire";
import { PILOT_TRANSCRIPT_MARK } from "./transcriptProjection";
import { rememberPilotTurn, validPilotContextId } from "./pilotContext";

/** Quiet this long and the conversation is over — same idea as agent-chat's
 * `debounce`, shorter because speech has no "still typing". */
export const PILOT_SETTLE_MS = 5 * 60_000;

export const pilotSpoolDir = (root: string): string => join(spoolDir(root), "pilot");

/** The page mints the conversation id (one per client secret). */
const CONVERSATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface PilotTurn {
  id?: string;
  speaker: "user" | "pilot";
  text: string;
  /** ISO — when the turn completed, by the page's clock. */
  at: string;
  /** Tool names the pilot called on this turn — the shape of the work,
   * agent-chat's `[tool: X]` convention. */
  tools?: string[];
}

const fileOf = (root: string, conversation: string): string => join(pilotSpoolDir(root), `${conversation}.jsonl`);

export function validConversationId(id: unknown): id is string {
  return typeof id === "string" && CONVERSATION_ID.test(id);
}

/** Validate one turn off the wire. Text may be empty only when tools were
 * called (a turn that was all tool calls and no words still shaped the
 * conversation); everything else is refused with the reason. */
export function parseTurn(raw: unknown, now: Date): PilotTurn {
  const t = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const speaker = t["speaker"];
  if (speaker !== "user" && speaker !== "pilot") throw new PilotError('speaker must be "user" or "pilot"');
  const text = typeof t["text"] === "string" ? t["text"].trim() : "";
  const tools = Array.isArray(t["tools"]) ? t["tools"].filter((v): v is string => typeof v === "string" && !!v).slice(0, 50) : [];
  if (!text && !tools.length) throw new PilotError("a turn needs text or tools");
  if (text.length > 20_000) throw new PilotError("turn text too long");
  let at = now.toISOString();
  if (t["at"] !== undefined) {
    const ms = typeof t["at"] === "string" ? Date.parse(t["at"]) : NaN;
    if (Number.isNaN(ms)) throw new PilotError("at must be an ISO timestamp");
    at = new Date(ms).toISOString();
  }
  if (t["id"] !== undefined && !validPilotContextId(t["id"])) throw new PilotError("invalid turn id");
  return { speaker, text, at, ...(typeof t["id"] === "string" ? { id: t["id"] } : {}), ...(tools.length ? { tools } : {}) };
}

/** Append one turn to the conversation's spool file. Returns the count so
 * far. */
export function appendPilotTurn(root: string, conversation: string, turn: PilotTurn): number {
  if (!validConversationId(conversation)) throw new PilotError("bad conversation id");
  const prior = readPilotTurns(root, conversation);
  if (turn.id) {
    rememberPilotTurn(root, conversation, { ...turn, id: turn.id });
    if (prior.some(t => t.id === turn.id)) return prior.length;
  }
  ensureSpool(root);
  mkdirSync(pilotSpoolDir(root), { recursive: true });
  const file = fileOf(root, conversation);
  appendFileSync(file, `${JSON.stringify(turn)}\n`);
  return readPilotTurns(root, conversation).length;
}

/** The pending turns, tolerant of a half-written last line the way
 * agent-chat's projection is. */
export function readPilotTurns(root: string, conversation: string): PilotTurn[] {
  const file = fileOf(root, conversation);
  if (!existsSync(file)) return [];
  const out: PilotTurn[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line) as PilotTurn;
      if ((t.speaker === "user" || t.speaker === "pilot") && typeof t.at === "string") out.push(t);
    } catch {
      /* a torn line: skipped, never fatal */
    }
  }
  return out;
}

function renderTurn(t: PilotTurn): string {
  const tools = (t.tools ?? []).map((n) => `[tool: ${n}]`).join(" ");
  const text = [t.text, tools].filter(Boolean).join(" ");
  return `${t.speaker}: ${text.replace(/\n(?=(?:user|pilot|assistant|harness): )/g, "\n  ")}`;
}

const clock = (iso: string): string => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** The segment, composed. Identity: `stream: pilot`, `key` the
 * conversation, `seq` the first turn's clock — a conversation that resumes
 * after settling lands a second chapter of the same key, never a duplicate
 * of the first (#46's arrival identity). */
export function buildPilotItem(
  conversation: string,
  turns: readonly PilotTurn[],
  now: Date
): { name: string; content: string } {
  const first = turns[0]!;
  const last = turns[turns.length - 1]!;
  const firstMs = Date.parse(first.at);
  const day = localDay(new Date(Date.parse(last.at)));
  const fm = fmSerialize([
    ["id", fmRaw(`pilot-${conversation}-${firstMs}`)],
    ["source", fmRaw("pilot")],
    ["from", fmRaw("pilot")],
    ["from_kind", fmRaw("agent")],
    ["kind", fmRaw("pilot-chat")],
    ["type", fmRaw("reference")],
    ["tags", fmRaw("[pilot, transcript]")],
    ["title", `Pilot — ${day}`],
    ["date", fmRaw(day)],
    ["stream", fmRaw("pilot")],
    ["key", fmRaw(conversation)],
    ["seq", fmRaw(String(firstMs))],
    ["fetched", fmRaw(now.toISOString())],
  ]);
  const body = [
    `# Pilot — ${day}`,
    ``,
    `A push-to-talk conversation with the pilot: ${turns.length} turn${turns.length === 1 ? "" : "s"}, ${clock(first.at)}–${clock(last.at)}.`,
    ``,
    PILOT_TRANSCRIPT_MARK,
    ``,
    turns.map(renderTurn).join("\n\n"),
    ``,
  ].join("\n");
  return { name: `${day}-pilot-${conversation.slice(0, 8)}.md`, content: fmBody(fm, body) };
}

/** Land the conversation's pending turns as one segment and clear the
 * spool file. Null when there was nothing pending. The file goes only
 * after the landing returns — a landing that throws leaves the turns
 * where they were, for the next sweep. */
export async function settlePilotConversation(
  root: string,
  conversation: string,
  now = new Date()
): Promise<IntakeReceipt | null> {
  const turns = readPilotTurns(root, conversation);
  if (!turns.length) {
    rmSync(fileOf(root, conversation), { force: true });
    return null;
  }
  const item = buildPilotItem(conversation, turns, now);
  const receipt = await landDrop({ root, content: item.content });
  rmSync(fileOf(root, conversation), { force: true });
  return receipt;
}

/** Land every conversation quiet for `settleMs` or longer — what an
 * earlier process left behind, or a page that closed without saying so. */
export async function sweepPilotSpool(root: string, now = new Date(), settleMs = PILOT_SETTLE_MS): Promise<string[]> {
  const dir = pilotSpoolDir(root);
  if (!existsSync(dir)) return [];
  const landed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const conversation = name.slice(0, -".jsonl".length);
    if (!validConversationId(conversation)) continue;
    let mtime: number;
    try {
      mtime = statSync(join(dir, name)).mtimeMs;
    } catch {
      continue;
    }
    if (now.getTime() - mtime < settleMs) continue;
    if (await settlePilotConversation(root, conversation, now)) landed.push(conversation);
  }
  return landed;
}

/**
 *   POST /api/pilot/turn   {conversation, speaker, text, at?, tools?} → {turns}
 *   POST /api/pilot/end    {conversation} → {landed: path | null}
 *
 * A turn arms (re-arms) the conversation's settle timer; `end` settles
 * now. Each touch also sweeps what earlier processes left. Timers are
 * unref'd: they must never hold a test runner — or a shutdown — open.
 */
