import type { OutputRequirements } from "./request";
import type { ModelObservation } from "./monitorTypes";
/** A model session has no knowledge of the UI or which role owns it. */
export interface ModelSessionSetup {
  root: string;
  config: import("../modelChoice").ModelChoice;
  instructions: string;
  tools: { name: string; description: string; parameters: unknown }[];
  state: ModelSessionState;
  save: () => void;
  role?: import("../modelChoice").ModelRole;
  interactive?: boolean;
  requireText?: boolean;
  auth?: "max" | "api";
  output?: OutputRequirements;
}

export interface ModelSessionTurn {
  observe?: (sample: ModelObservation) => void;
  signal: AbortSignal;
  delta: (text: string) => void;
  tool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  input: (fresh: boolean) => string;
  images?: (fresh: boolean) => { type: string; url: string }[];
  connected: () => void;
  dispatched?: () => void;
  event?: (name: string, value?: unknown) => void;
}
export interface ModelSession {
  readonly execution?: import("../modelResolution").ModelExecution;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly accountId?: string;
  readonly broken: boolean;
  readonly transport: "subscription" | "api";
  prepare(): Promise<boolean>;
  turn(args: ModelSessionTurn): Promise<string | null>;
  /** Queue input for the active turn's next safe point: after its running tool
   * calls, before its next model request. False when no turn can take it. */
  steer?(text: string): boolean;
  /** Withdraw steering the provider accepted but did not deliver. */
  clearSteering?(): void;
  close(): void;
}

/** Provider continuation pointers; application conversation history is separate. */
export interface ModelSessionState { through: number; piSession?: string; runtimeId?: string }
