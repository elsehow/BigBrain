#!/usr/bin/env bun
/**
 * firewall.ts — the intake firewall from the command line.
 *
 *   bigbrain firewall status      what this vault screens with, and whether it answers
 *   bigbrain firewall install     download the local model (~10 GB, resumable) and turn it on
 *   bigbrain firewall off         stop screening (and stop the local model server)
 *
 * The desktop app starts the local server (bin/firewall-server.ts) within a
 * second of `install` finishing. From then on every arrival is screened, and
 * intake waits whenever the server cannot answer.
 */

import { applyConfig } from "../lib/config";
import {
  firewallModel,
  installModel,
  llamaServerPath,
  localFirewallUrl,
  modelInstalled,
  modelPath,
} from "../lib/firewallModel";
import { loadManifest } from "../lib/manifest";
import { VAULT_ROOT } from "../lib/vaultRoot";

const [cmd = "status"] = process.argv.slice(2);
const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;

async function status(): Promise<void> {
  const cfg = loadManifest(VAULT_ROOT).firewall;
  if (!cfg) {
    console.log("firewall: off — arrivals are not screened (`bigbrain firewall install` turns it on)");
    return;
  }
  const url = cfg.url ?? localFirewallUrl();
  console.log(`firewall: on — ${cfg.url ? `hosted ${cfg.url}` : `local ${cfg.model}`}; threshold credential ${cfg.thresholds.credential}`);
  if (!cfg.url) {
    const m = firewallModel(cfg.model);
    console.log(`  model:  ${modelInstalled(m) ? modelPath(m) : `NOT INSTALLED (${m.file}) — run \`bigbrain firewall install\``}`);
    console.log(`  server: ${llamaServerPath() ?? "no llama-server in this install"}`);
  }
  const health = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(3000) }).then((r) => r.status).catch(() => 0);
  console.log(`  answering: ${health === 200 ? "yes" : "NO — intake is waiting"}`);
}

async function install(): Promise<void> {
  const name = process.argv[3] ?? loadManifest(VAULT_ROOT).firewall?.model ?? "clef-flash";
  const m = firewallModel(name);
  if (!modelInstalled(m)) {
    console.log(`firewall: downloading ${m.file} (${gb(m.bytes)}, ${m.license}) from ${m.repo}@${m.revision.slice(0, 7)}`);
    let last = 0;
    await installModel(m, (done, total) => {
      const now = Date.now();
      if (now - last < 1000 && done < total) return;
      last = now;
      process.stdout.write(`\r  ${gb(done)} / ${gb(total)} (${Math.floor((100 * done) / total)}%)   `);
    });
    process.stdout.write("\n  verified (sha256)\n");
  }
  const r = applyConfig({ firewall: { model: name } }, VAULT_ROOT);
  console.log(r.changed.length ? "firewall: on — the app starts the local model server within a second" : "firewall: already on");
}

switch (cmd) {
  case "status":
    await status();
    break;
  case "install":
    await install();
    break;
  case "off":
    console.log(applyConfig({ firewall: null }, VAULT_ROOT).changed.length ? "firewall: off" : "firewall: already off");
    break;
  default:
    console.error("usage: bigbrain firewall [status | install [model] | off]");
    process.exit(2);
}
