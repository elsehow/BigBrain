#!/usr/bin/env bun
/**
 * firewall-server.ts — serve the intake firewall's local model (lib/firewallModel.ts).
 *
 * A long-lived job of bin/desktop.ts, planned only when the vault's firewall
 * has no `url` and the model is installed. It runs the bundled llama-server
 * on the loopback port lib/firewall.ts calls, and exits when that server does,
 * so the supervisor's restart loop brings both back. The server sleeps — drops
 * the weights — after ten idle minutes and reloads on the next request.
 *
 * Every poller and door fails closed while this is down: intake waits, it
 * never goes around.
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { firewallPort } from "../lib/env";
import { firewallModel, llamaServerPath, modelInstalled, modelPath } from "../lib/firewallModel";
import { loadManifest } from "../lib/manifest";
import { alive, dieWithSupervisor } from "../lib/parentWatch";
import { VAULT_ROOT } from "../lib/vaultRoot";

dieWithSupervisor("firewall");

const cfg = loadManifest(VAULT_ROOT).firewall;
if (!cfg || cfg.url) {
  console.error("firewall: this vault does not use the local model — nothing to serve");
  process.exit(0);
}
const model = firewallModel(cfg.model);
const server = llamaServerPath();
if (!server) {
  console.error("firewall: no llama-server beside bun and no BIGBRAIN_LLAMA_SERVER — intake waits");
  process.exit(1);
}
if (!modelInstalled(model)) {
  console.error(`firewall: ${model.file} is not installed — run \`bigbrain firewall install\`; intake waits`);
  process.exit(1);
}

// One server per vault. A SIGKILLed predecessor cannot take its child with
// it; the pidfile lets this one end the orphan holding the port and memory.
const pidfile = join(VAULT_ROOT, ".state", "firewall-server.pid");
try {
  const old = Number(readFileSync(pidfile, "utf8"));
  // Only if that pid is still a llama-server: pids are reused.
  const comm = old > 1 && alive(old) ? spawnSync("ps", ["-p", String(old), "-o", "comm="], { encoding: "utf8" }).stdout.trim() : "";
  if (comm.endsWith("llama-server")) process.kill(old, "SIGTERM");
} catch { /* none */ }

// Clef evaluates a whole prompt in one ubatch, so the batch sizes bound the
// longest window lib/firewall.ts may send (WINDOW, in characters).
const child = spawn(server, [
  "--model", modelPath(model),
  "--host", "127.0.0.1",
  "--port", String(firewallPort()),
  "--ctx-size", "8192",
  "--batch-size", "8192",
  "--ubatch-size", "8192",
  "--parallel", "1",
  "--sleep-idle-seconds", "600",
  "--no-webui",
], { stdio: ["ignore", "inherit", "inherit"] });
if (child.pid) writeFileSync(pidfile, String(child.pid));
console.log(`firewall: ${model.file} on 127.0.0.1:${firewallPort()} (pid ${child.pid})`);

const stop = () => { try { child.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", stop);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
child.on("exit", (code, signal) => {
  console.error(`firewall: llama-server exited (${signal ?? code})`);
  process.exit(code ?? 1);
});
