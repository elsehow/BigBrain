import type { ReadModelWorkerRequest } from "./readModelBackground";
/** One-shot read-model work. Use the same builders as synchronous callers; only
 * scheduling differs. No model calls and no durable vault writes. */
import { assertionGraphEvidenceCached } from "./graphCache";
import { withVaultSnapshot } from "./vaultReadModel";
import { recentSourcePage } from "./sourceFeed";
import { computeLayout } from "./graphLayout";

declare const self: Worker;
self.onmessage = ({ data: request }: MessageEvent<ReadModelWorkerRequest>) => {
  try {
    if (request.kind === "layout") {
      postMessage({ value: computeLayout(request.graph, request.previous) });
    } else {
      // Live warming prepares compact feed pages alongside the graph.
      recentSourcePage(request.root, 0, 1);
      const snapshot = withVaultSnapshot(request.root, (_db, revision) =>
        request.kind === "feed" || revision === request.knownRevision ? { revision } : assertionGraphEvidenceCached(request.root));
      postMessage({ value: snapshot });
    }
  } catch (error) {
    postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
