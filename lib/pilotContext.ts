/** Durable conversation context, retained across transcript segment settling.
 * User words come from the transcript door; evidence comes from executed tools,
 * never from the dispatcher's paraphrase of either. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./fsx";
import { spoolDir } from "./spool";

export interface ContextTurn { id: string; speaker: "user" | "pilot"; text: string; at: string }
export interface Evidence { tool: string; args: Record<string, unknown>; result: unknown; at: string }
export interface PilotContext { turns: ContextTurn[]; evidence: Evidence[] }
const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(id);
export const validPilotContextId = validId;
const file = (root: string, id: string) => {
  if (!validId(id)) throw new Error("Invalid pilot conversation id");
  return join(spoolDir(root), "pilot-context", `${id}.json`);
};
export function readPilotContext(root: string, conversation: string): PilotContext {
  try { return JSON.parse(readFileSync(file(root, conversation), "utf8")) as PilotContext; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { turns: [], evidence: [] }; throw e; }
}
export function rememberPilotTurn(root: string, conversation: string, turn: ContextTurn): void {
  const ctx = readPilotContext(root, conversation);
  const prior = ctx.turns.find(t => t.id === turn.id);
  if (prior) {
    if (prior.text !== turn.text || prior.speaker !== turn.speaker) throw new Error("Turn id already has different words");
    return;
  }
  ctx.turns = [...ctx.turns, turn].slice(-60);
  writeAtomic(file(root, conversation), JSON.stringify(ctx), 0o600);
}
export function rememberPilotEvidence(root: string, conversation: string, evidence: Evidence): void {
  const ctx = readPilotContext(root, conversation);
  // Source readers already bound their responses. Keep a bounded prompt and
  // explicit truncation for larger live threads, not invalid sliced JSON.
  const serialized = JSON.stringify(evidence.result);
  const result = serialized.length > 40_000 ? { truncated: true, excerpt: serialized.slice(0, 40_000), reread_with: evidence.args } : evidence.result;
  ctx.evidence = [...ctx.evidence, { ...evidence, result }].slice(-8);
  writeAtomic(file(root, conversation), JSON.stringify(ctx), 0o600);
}
