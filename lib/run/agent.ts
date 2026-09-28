import type { ModelRunRequest } from "./request";
import type { PiSDK } from "./piSession";
import { runSessionJob } from "./sessionJob";
export function runAgent(request: ModelRunRequest, loadPi?: () => Promise<PiSDK>) {
  return runSessionJob(request, { pi: loadPi });
}
