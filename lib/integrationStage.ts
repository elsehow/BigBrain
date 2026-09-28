/** Pollers stage discussable material; only the gardener admits evidence. */
import { stage } from "./stage";
import { parseEnvelope } from "./envelope";
import { sha256hex } from "./hash";
import { integrationActive } from "./integrationAccess";
export function stageIntegrationContent(root: string, source: string, content: string, account = source): boolean {
  if (!integrationActive(root, source,account)) throw new Error("Integration became inactive; polling stopped.");
  const meta = parseEnvelope(content).envelope;
  const id = `${source}-${sha256hex(account+"\n"+content).slice(0, 32)}`;
  return stage(root, { id, source, account, at: typeof meta.date === "string" ? meta.date : new Date().toISOString(),
    line: String(meta.title ?? meta.id ?? source).slice(0, 1000), scopes: {}, name: id + ".md", content });
}
