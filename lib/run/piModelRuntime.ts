/** Vault API keys override only this runtime; never copy them into Pi's global store. */
import { readEnvValues } from "../envFile";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
export async function configureVaultModelAuth(runtime: ModelRuntime, root?: string): Promise<void> {
  const key = root && readEnvValues(root).OPENAI_API_KEY;
  if (key) await runtime.setRuntimeApiKey("openai", key);
  else await runtime.removeRuntimeApiKey("openai");
}
