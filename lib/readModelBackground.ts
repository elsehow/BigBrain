/** One-shot background preparation shared by graph, layout, and feed reads. */
import type { Graph } from "./graph";
import type { Positions } from "./graphLayout";
export type ReadModelWorkerRequest = { kind: "graph"; root: string; knownRevision?: string }
  | { kind: "feed"; root: string }
  | { kind: "layout"; graph: Graph; previous?: Positions };

export function background<T>(request: ReadModelWorkerRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./graphWorker.ts", import.meta.url).href, { smol: true, ref: true });
    const timeout = setTimeout(() => finish(new Error("Read model preparation timed out")), 120_000);
    let done = false;
    function finish(error?: Error, value?: T): void {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      worker.terminate();
      if (error) reject(error); else resolve(value!);
    }
    worker.onmessage = ({ data }: MessageEvent<{ value?: T; error?: string }>) =>
      finish(data.error ? new Error(data.error) : undefined, data.value);
    worker.onerror = error => finish(new Error(error.message));
    worker.addEventListener("close", () => { if (!done) finish(new Error("Read model worker exited before replying")); });
    try { worker.postMessage(request); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

