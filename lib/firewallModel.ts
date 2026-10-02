/** The intake firewall's LOCAL model: which weights, where they live on this
 * machine, how they get there, and the server binary that runs them.
 *
 * The app ships llama.cpp's `llama-server` beside bun (desktop/
 * build-llama-server.sh); it answers the same Jev/SystemOne
 * `/v1/systemone` API a hosted endpoint does, so lib/firewall.ts cannot tell
 * the difference. The weights are too big for the app bundle, so they are
 * downloaded once, on opt-in, pinned to a revision and checked against its
 * sha256 — a partial or tampered file is never served. They live outside
 * any vault: one copy per machine, like the app itself. */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, openSync, closeSync, writeSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { firewallPort, firewallModelsDir, llamaServerOverride } from "./env";
import { ensureDir } from "./fsx";

export interface FirewallModel {
  /** Hugging Face repo and the revision every download is pinned to. */
  repo: string;
  revision: string;
  file: string;
  bytes: number;
  sha256: string;
  license: string;
}

/** Cloudflare's Clef-flash (Apache-2.0), converted by ggml-org for llama.cpp. */
export const FIREWALL_MODELS: Record<string, FirewallModel> = {
  "clef-flash": {
    repo: "ggml-org/Clef-Flash-GGUF",
    revision: "4a7a08c09bc63baf043b62b5ba89dd67a0357d95",
    file: "Clef-Flash-Q8_0.gguf",
    bytes: 9_657_260_096,
    sha256: "8754b06f7d16d6d6ab63493b2ee385cc0ed6abde8c25c39298dc3e1eb05593d9",
    license: "Apache-2.0",
  },
  // 3 GB smaller, same decisions on deploy/firewall/eval at the default
  // thresholds — but the weakest credential mail scores 0.29 against Q8's
  // 0.40, a thinner margin over the 0.25 threshold. For 16 GB machines.
  "clef-flash-q4": {
    repo: "ggml-org/Clef-Flash-GGUF",
    revision: "4a7a08c09bc63baf043b62b5ba89dd67a0357d95",
    file: "Clef-Flash-Q4_K_M.gguf",
    bytes: 6_486_448_192,
    sha256: "3243a51d7a7bb205fb4fcf402a7df763f7d31e6645a9c10e5754c4395ab85b66",
    license: "Apache-2.0",
  },
};

export function firewallModel(name: string): FirewallModel {
  const m = FIREWALL_MODELS[name];
  if (!m) throw new Error(`no local firewall model named ${JSON.stringify(name)} (known: ${Object.keys(FIREWALL_MODELS).join(", ")})`);
  return m;
}

export const modelsDir = (): string => firewallModelsDir() ?? join(homedir(), ".local", "share", "bigbrain", "models");
export const modelPath = (m: FirewallModel): string => join(modelsDir(), m.file);

/** Installed means the verified file is in place; a download in progress
 * is a `.part` beside it and does not count. */
export const modelInstalled = (m: FirewallModel): boolean => {
  try { return statSync(modelPath(m)).size === m.bytes; } catch { return false; }
};

export const localFirewallUrl = (): string => `http://127.0.0.1:${firewallPort()}/v1/systemone`;

/** The bundled server beside bun (Contents/MacOS/ in the app), else an
 * explicit override for a checkout. Undefined: this install cannot serve. */
export function llamaServerPath(): string | undefined {
  const override = llamaServerOverride();
  if (override) return existsSync(override) ? override : undefined;
  const beside = join(dirname(process.execPath), "llama-server");
  return existsSync(beside) ? beside : undefined;
}

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Download, resuming a `.part` from where it stopped, then verify. Only a
 * file whose size and sha256 match the catalog is renamed into place. */
export async function installModel(
  m: FirewallModel,
  progress: (done: number, total: number) => void = () => {},
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const dest = modelPath(m);
  if (modelInstalled(m)) return dest;
  ensureDir(modelsDir());
  const part = `${dest}.part`;
  let have = existsSync(part) ? statSync(part).size : 0;
  if (have > m.bytes) { unlinkSync(part); have = 0; }
  if (have < m.bytes) {
    const url = `https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.file}`;
    const res = await fetchImpl(url, { headers: have ? { range: `bytes=${have}-` } : {} });
    if (!res.ok || !res.body) throw new Error(`model download failed: HTTP ${res.status} from ${url}`);
    if (have && res.status !== 206) have = 0; // the server ignored the range: start over
    const fd = openSync(part, have ? "a" : "w");
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        writeSync(fd, chunk);
        have += chunk.byteLength;
        progress(have, m.bytes);
      }
    } finally {
      closeSync(fd);
    }
  }
  if (statSync(part).size !== m.bytes) throw new Error(`model download incomplete: ${statSync(part).size} of ${m.bytes} bytes — run it again to resume`);
  const sum = await sha256File(part);
  if (sum !== m.sha256) {
    unlinkSync(part);
    throw new Error(`model download corrupt (sha256 ${sum}, expected ${m.sha256}) — deleted; run it again`);
  }
  renameSync(part, dest);
  return dest;
}
