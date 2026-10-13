/** runner.ts — the model runner a chain hands its stages
 * (lib/stages/stage.ts ModelRunner): the background session job, through the
 * given SDK loader when a test replaces the transport. Apart from stage.ts,
 * which every reader of a stage's views imports, so that reading what a
 * stage waits on never loads the model transport. */
import { runAgent } from "../run/agent";
import type { PiSDK } from "../run/piSession";
import type { ModelRunner } from "./stage";

export const modelRunner = (loadPi?: () => Promise<PiSDK>): ModelRunner => (request) => runAgent(request, loadPi);
