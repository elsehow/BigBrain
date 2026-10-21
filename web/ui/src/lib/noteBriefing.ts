import { vaultFetch } from "./vaultScope";
import { plainText } from "../../../../lib/views/v2Feed";
import type { BriefingScope } from "../../../../lib/noteBriefing";

/** The same cached Quick briefing for a source row and its reader. */
export async function readBriefing(path: string, onText: (text: string) => void, scope?: BriefingScope, signal?: AbortSignal, purpose?: "source"): Promise<boolean> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const server = /^shared\/([^/]+)\//.exec(path)?.[1];
    const selected = scope ?? (server ? { server } : undefined);
    const response = await vaultFetch("/api/note/briefing", { method: "POST", signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ path, stream: true, ...(selected ? { scope: selected } : {}), ...(purpose ? { purpose } : {}) }) });
    if (!response.ok || !response.body) return false;
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const accept = (line: string): boolean | undefined => {
      if (!line.trim() || signal?.aborted) return;
      const event = JSON.parse(line) as { type: string; text?: string; briefing?: { summary: string } };
      if (event.type === "preview" && event.text) onText(plainText(event.text));
      if (event.type === "complete" && event.briefing) { onText(plainText(event.briefing.summary)); return true; }
      if (event.type === "error") return false;
    };
    while (!signal?.aborted) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (chunk.done) lines.push(buffer);
      for (const line of lines) { const result = accept(line); if (result !== undefined) return result; }
      if (chunk.done) break;
    }
    return false;
  } catch { return false; }
  finally { await reader?.cancel().catch(() => {}); }
}
