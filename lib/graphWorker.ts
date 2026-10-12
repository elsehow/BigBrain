import type { ReadModelWorkerRequest } from "./readModelBackground";
/** One-shot read-model work. Use the same builders as synchronous callers; only
 * scheduling differs. No model calls and no durable vault writes. */
import { readModelRevision } from "./vaultReadModel";
import { recentSourcePage } from "./sourceFeed";
import { claimProjectionRecovery, recoverAssertionProjection } from "./assertionProjection";
import { buildGraphView } from "./maintainedGraph";

declare const self: Worker;
self.onmessage = ({ data: request }: MessageEvent<ReadModelWorkerRequest>) => {
  try {
    if (request.kind === "recover") {
      postMessage({ value: recoverAssertionProjection(request.root) });
    } else if (request.kind === "graph-view") {
      claimProjectionRecovery(request.root);
      postMessage({ value: buildGraphView(request.root) });
    } else {
      // The process that spawned this owns recovery (the viewer runs it as
      // its own "recover" job); a worker must not repeat the log census
      // every build.
      claimProjectionRecovery(request.root);
      recentSourcePage(request.root, 0, 1);
      postMessage({ value: { revision: readModelRevision(request.root) } });
    }
  } catch (error) {
    postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
