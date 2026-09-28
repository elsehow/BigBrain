import { basename } from "node:path";
import { z } from "zod";
import type { PilotChatSession } from "./pilotChatTypes";
import { sessionAccessSchema } from "./workAccess";

const strings = z.array(z.string());
const images = z.array(z.object({ id: z.string(), name: z.string() }).passthrough());
const input = z.object({ id: z.string(), text: z.string(), mode: z.enum(["text", "voice"]),
  target: z.string().optional(), notificationId: z.string().optional(), images: images.optional() }).passthrough();
const savedPilot = z.object({
  id: z.string().regex(/^pilot-[a-f0-9]{32}$/), title: z.string(), model: z.string(),
  category: z.object({ memory: z.string().nullable(), inputKey: z.string(), model: z.string(),
    assignedAt: z.string().datetime(), reason: z.string() }).optional(),
  turn: z.object({ id: z.string().min(1), status: z.enum(["running", "stopping"]), replyTo: z.string().optional(), reports: strings.optional() }).optional(),
  phase: z.enum(["draft", "working", "answered", "interrupted", "failed"]),
  seed: strings, context: strings, draft: z.string(), live: z.string(), activity: z.string(), error: z.string(),
  revision: z.number().int().nonnegative(), viewRevision: z.number().int().nonnegative(),
  created: z.string().datetime(), updated: z.string().datetime(),
  messages: z.array(z.object({ id: z.string(), role: z.enum(["user", "assistant"]), text: z.string(), at: z.string(), images: images.optional() }).passthrough()),
  access: sessionAccessSchema.optional(),
  githubRequest: z.object({ id: z.string(), repository: z.string().optional(), access: z.enum(["read", "write"]).optional(), scope: z.literal("account").optional(), reason: z.string(), status: z.enum(["pending", "allowed", "declined"]), reconnect: z.boolean().optional(), inputId: z.string().optional() }).optional(),
  githubActions: z.record(z.string(), z.object({ status: z.enum(["pending", "done"]), result: z.unknown().optional() })).optional(),
  legacyWork: z.object({ id: z.string(), provider: z.enum(["codex", "claude-code"]), cwd: z.string(), thread: z.string().optional(),
    outputs: z.array(z.object({ id: z.string(), path: z.string(), title: z.string(), at: z.string() }).passthrough()) }).passthrough().optional(),
  localCommand: z.object({ id: z.string(), command: z.string(), cwd: z.string(), status: z.enum(["running", "completed", "uncertain"]), exitCode: z.number().optional() }).passthrough().optional(),
  backend: z.object({ adapter: z.string(), model: z.string(), provider: z.string().optional(), reasoning: z.string().optional() }).passthrough().optional(),
  inputs: z.array(input.extend({ message: z.string() })).optional(), pendingInputs: z.array(input).optional(),
  notifications: z.array(z.object({ id: z.string(), pilotId: z.string(), pilotTitle: z.string(), messageId: z.string(),
    key: z.string(), text: z.string(), kind: z.enum(["question", "update"]), at: z.string(), seen: z.boolean(),
    dismissed: z.boolean().optional(), resolved: z.boolean().optional() }).passthrough()).optional(),
  spoken: z.array(z.object({ id: z.string(), message: z.string(), text: z.string(), at: z.string(), status: z.enum(["played", "interrupted"]) }).passthrough()).optional(),
  draftImages: images.optional(), removedContext: strings.optional(),
  contextNodes: z.array(z.object({ id: z.string(), path: z.string(), title: z.string(), group: z.string() }).passthrough()).optional(),
  lifecycle: z.enum(["active", "dormant", "ingested"]).optional(), lastActivityAt: z.string().optional(), deactivatedAt: z.string().optional(),
  composerLeaseUntil: z.number().optional(), ingestedMessages: z.number().int().nonnegative().optional(),
  ingestions: z.array(z.object({ through: z.number(), sourceId: z.string(), insertionId: z.string(), path: z.string() }).passthrough()).optional(),
  pendingIngestion: z.object({ through: z.number(), content: z.string() }).passthrough().optional(),
  workEvents: z.array(z.object({ key: z.string(), work: z.string(), title: z.string(), text: z.string(), at: z.string(),
    kind: z.enum(["started", "question", "completed", "failed"]) }).passthrough()).optional(),
}).passthrough();

/** Validate live fields before any startup mutation; preserve historical extensions. */
export function validateSavedPilot(value: unknown, file: string): PilotChatSession {
  const session = savedPilot.parse(value);
  if (session.id !== basename(file, ".json")) throw new Error("Conversation identity does not match its file");
  return session as PilotChatSession;
}
