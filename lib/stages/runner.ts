/** runner.ts — the model runner a chain hands its stages
 * (lib/stages/stage.ts ModelRunner): the background session job, through the
 * given SDK loader when a test replaces the transport. Loaded on the first
 * call, not on import: reading what a stage waits on, or a viewer route that
 * may ask a stage, never loads the model transport. */
import type { PiSDK } from "../run/piSession";
import type { ModelRunner } from "./stage";

export const modelRunner = (loadPi?: () => Promise<PiSDK>): ModelRunner =>
  async (request) => (await import("../run/agent")).runAgent(request, loadPi);
