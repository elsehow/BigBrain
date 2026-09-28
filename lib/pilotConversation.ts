import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./fsx";
import { spoolDir } from "./spool";
import { z } from "zod";

/** Backend-only provider state. Never included in browser polling payloads. */
export interface PilotConversation {
  /** Native threads freeze their initial tools/instructions; never resume a stale contract. */
  runtimeSignature?: string;
  /** Read-only historical receipts. New actions are owned by ApplicationActions. */
  actions?: Record<string, { status: "pending" | "done"; result?: unknown }>;
  evidence?: { tool: string; args: unknown; result: unknown }[];
  /** Pi owns its transcript; this pointer never leaves the backend. */
  piSession?: string;
  runtimeId?: string;
  through: number;
  memory?: string;
}
/** Keeps canonical history outside this record, plus evidence and idempotency
 * receipts here. Obsolete private continuations are discarded.
 * This performs no model turn or tool execution. */
export function refreshPilotContract(state: PilotConversation, signature: string): boolean {
  if (state.runtimeSignature === signature) return false;
  if (state.piSession) { delete state.piSession; state.through = 0; delete state.memory; }
  state.runtimeSignature = signature;
  return true;
}
export function conversationPath(root: string, id: string): string {
  return join(spoolDir(root), "pilot-runtime", `${id}.json`);
}
const savedConversation = z.object({
  through: z.number().int().nonnegative(),
  runtimeSignature: z.string().optional(),
  piSession: z.string().optional(), runtimeId: z.string().optional(), memory: z.string().optional(),
  actions: z.record(z.string(), z.object({ status: z.enum(["pending", "done"]), result: z.unknown().optional() }).passthrough()).optional(),
  evidence: z.array(z.object({ tool: z.string(), args: z.unknown(), result: z.unknown() }).passthrough()).optional(),
});
export function readConversation(root: string, id: string): PilotConversation {
  try {
    const raw = JSON.parse(readFileSync(conversationPath(root, id), "utf8"));
    // Old model continuations are disposable; public history and action receipts are not.
    if (raw.apiTurns || raw.threadId || raw.previousThreadIds) { delete raw.apiTurns; raw.through = 0; delete raw.memory; }
    return savedConversation.parse(raw) as PilotConversation;
  }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; return { through: 0 }; }
}
export function saveConversation(root: string, id: string, state: PilotConversation): void {
  writeAtomic(conversationPath(root, id), JSON.stringify(state), 0o600);
}
export interface PilotTiming {
  runId?: string;
  messageId: string;
  startedAt: string;
  transport?: "subscription" | "api";
  freshThread?: boolean;
  setupMs?: number;
  firstTextMs?: number;
  totalMs?: number;
  status?: string;
  // Pi reports each provider request, including compaction.
  apiRequests: { startMs: number; endMs?: number; usage?: unknown }[];
  tools: { name: string; startMs: number; endMs?: number }[];
  usage?: unknown;
}
export function saveTiming(root: string, id: string, timing: PilotTiming): void {
  writeAtomic(join(spoolDir(root), "pilot-timings", id, `${timing.messageId}.json`), JSON.stringify(timing), 0o600);
}
