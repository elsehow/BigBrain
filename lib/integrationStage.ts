/** Pollers stage discussable material; only the gardener admits evidence. */
import { hold } from "./door";
import { parseEnvelope } from "./envelope";
import { sha256hex } from "./hash";
import { integrationActive } from "./integrationAccess";
export async function stageIntegrationContent(root: string, source: string, content: string, account = source): Promise<boolean> {
  if (!integrationActive(root, source,account)) throw new Error("Integration became inactive; polling stopped.");
  const meta = parseEnvelope(content).envelope;
  const id = `${source}-${sha256hex(account+"\n"+content).slice(0, 32)}`;
  return hold(root, { id, source, account, at: typeof meta.date === "string" ? meta.date : new Date().toISOString(),
    line: String(meta.title ?? meta.id ?? source).slice(0, 1000), name: id + ".md", content });
}
