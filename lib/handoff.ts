/** Historical research records, retained for read-back and migration only. */
import type { WorkContext } from "./workHistory";
import type { PilotContext } from "./pilotContext";
export interface HandoffAnswer {
  title: string;
  answer: string;
  spoken_answer: string;
  citations: { label: string; ref: string }[];
  uncertainty: string[];
  next_actions: string[];
}
export interface HandoffRequest {
  id: string; conversation: string; turn_id: string; user_words: string; task: string;
  context: PilotContext; selection?: WorkContext; current_view?: string; created_at: string; model?: string;
  previous?: { id: string; task: string; answer?: HandoffAnswer; provider: string; session?: string };
}
export type HandoffStatus = "running" | "completed" | "failed" | "canceled" | "interrupted";
export interface HandoffJob {
  id: string; provider: string; session: string; status: HandoffStatus; progress: string;
  request: HandoffRequest; updated_at: string; elapsed_ms?: number; error?: string;
  result?: HandoffAnswer; path?: string; revision?: number; receipts?: string[];
  inspection?: { model?: string; session_id?: string; observe_command?: string; resume_command?: string; working_directory?: string };
}
