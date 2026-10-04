/** Shared execution contract. Provider transport details stay in adapters. */
import type { ToolObserver } from "./toolActivity";
import type { Auth } from "../manifest";
import type { ModelChoice } from "../modelChoice";
export type JobCapabilities = "gardener" | "memory" | "goals" | "none";
export interface OutputRequirements {
  requireText?: boolean;
  schema?: Record<string, unknown>;
  maxTokens?: number;
  /** Generation hint where supported; maxCharacters remains the portable hard bound. */
  maxTokensHint?: number;
  /** Host-enforced output bound, independent of provider tokenization. */
  maxCharacters?: number;
  /** Hard API spending limit; subscription runs do not incur API charges. */
  maxBudgetUsd?: number;
}
export interface ModelRunRequest {
  root: string;
  role: string;
  memoryEdits?: import("../memoryEdits").MemoryEdits;
  target: ModelChoice;
  auth: Auth;
  prompt: string;
  instructions?: string;
  capabilities: JobCapabilities;
  output?: OutputRequirements;
  timeoutMs?: number;
  signal?: AbortSignal;
  onTool?: ToolObserver;
  onText?: (text: string) => void;
}
