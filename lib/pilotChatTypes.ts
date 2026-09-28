import type { ChatImage } from "./chatImageTypes";
/** Text Pilot's durable wire contract; safe to import in the browser. */
export const PILOT_TEXT_MODEL = "gpt-5.6-terra";
export type PilotChatPhase = "draft" | "working" | "answered" | "interrupted" | "failed";
/** One application turn. Absence means idle; process resources live elsewhere. */
export type PilotTurn = { id: string; status: "running" | "stopping"; replyTo?: string; reports?: string[] };
export interface PilotInput { id: string; text: string; mode: "text" | "voice"; target?: string; notificationId?: string; images?: ChatImage[] }
/** Derived primary memory, separate from the notes consulted by the agent. */
export interface PilotCategory {
  memory: string | null;
  inputKey: string;
  /** Model name for older assignments; classifier version for graph placement. */
  model: string;
  assignedAt: string;
  reason: string;
}
export interface PilotChatMessage {
  images?: ChatImage[];
  id: string; role: "user" | "assistant"; text: string; at: string; replyTo?: string;
  /** Worker reports incorporated by this Pilot answer, committed with the answer. */
  workEventKeys?: string[];
}
export interface PilotChatSession {
  id: string;
  turn?: PilotTurn;
  /** Original worker remains on disk; this identity redirects its sources and links. */
  legacyWork?: { archiveStateMigrated?: boolean; id: string; provider: import("./workHistory").WorkProvider; thread?: string; cwd: string; outputs: import("./workOutputs").WorkOutput[] };
  title: string;
  category?: PilotCategory;
  model: string;
  nativeRequests?: import("./pilotNativeRequests").PilotNativeRequest[];
  nativeExecution?: boolean;
  access?: import("./workAccess").SessionAccess;
  githubRequest?: import("./githubTypes").GitHubRequest;
  githubActions?: Record<string, { status: "pending" | "done"; result?: unknown }>;
  browser?: import("./pilotBrowserTypes").PilotBrowserState;
  /** Last local command remains visible to the model after an interrupted turn. */
  localCommand?: { id: string; command: string; cwd: string; status: "running" | "completed" | "uncertain"; exitCode?: number };
  backend?: import("./pilotBackendTypes").PilotBackendConfig;
  notifications?: import("./pilotNotifications").PilotNotification[];
  inputs?: { id: string; message: string; mode: "text" | "voice"; text: string; target?: string; notificationId?: string; images?: ChatImage[] }[];
  spoken?: { id: string; message: string; text: string; status: "played" | "interrupted"; at: string }[];
  pendingInputs?: { id: string; text: string; mode: "text" | "voice"; target?: string; notificationId?: string; images?: ChatImage[] }[];
  transport?: "subscription" | "api";
  phase: PilotChatPhase;
  /** Absent only in records written before lifecycle support. */
  lifecycle?: "active" | "dormant" | "ingested";
  lastActivityAt?: string;
  /** Explicitly closed by the user; preserved even when it has no messages. */
  deactivatedAt?: string;
  composerLeaseUntil?: number;
  ingestedMessages?: number;
  ingestions?: { through: number; sourceId: string; insertionId: string; path: string }[];
  pendingIngestion?: { through: number; content: string };
  ingestionError?: string;
  reportStoppedAt?: string;
  reportHandling?: Record<string, { attempts: number; next: number; disposition?: "replied" | "notified" | "escalated" }>;
  pendingAgentSessionReports?: string[];
  workEvents?: import("./workHistory").HistoricalWorkerReport[];
  seed: string[];
  context: string[];
  /** Explicit removals suppress automatic read attachments until explicitly re-added. */
  removedContext?: string[];
  /** Validated mentions that do not already have a node in the vault graph. */
  contextNodes?: { id: string; path: string; title: string; group: string }[];
  viewRevision: number;
  revision: number;
  draft: string;
  draftImages?: ChatImage[];
  messages: PilotChatMessage[];
  live: string;
  activity: string;
  error: string;
  created: string;
  updated: string;
}
export const isEmptyPilotDraft = (s: PilotChatSession & { messageCount?: number; hasHistory?: boolean }): boolean => s.phase === "draft" && !s.deactivatedAt && !s.browser && !s.draft.trim() && !s.draftImages?.length && !(s.messageCount ?? s.messages.length) && !s.hasHistory && !s.live && !s.ingestions?.length && !s.pendingIngestion;
export const isPilotChatId = (id: string): boolean => /^pilot-[a-f0-9]{32}$/.test(id);
export const SELECTOR_RATIO = (1 + Math.sqrt(5)) / 2;
export function newPilotChatSession(seed: string[], id = `pilot-${crypto.randomUUID().replaceAll("-", "")}`, at = new Date().toISOString()): PilotChatSession {
  return { id, title: "New session", model: PILOT_TEXT_MODEL, phase: "draft", lifecycle: "active", lastActivityAt: at,
    seed: [...seed], context: [...seed], viewRevision: 0, revision: 0, draft: "", messages: [], live: "", activity: "", error: "", created: at, updated: at };
}
export function pilotContextLabel(session: Pick<PilotChatSession, "context" | "seed">, title: (id: string) => string): string {
  if (!session.context.length) return "";
  const original = session.seed.length === 1 ? session.seed[0] : undefined;
  return original && session.context.includes(original)
    ? `${title(original)}${session.context.length > 1 ? ` + ${session.context.length - 1} selected` : ""}`
    : `${session.context.length} selected`;
}
