#!/usr/bin/env bun
/**
 * open.ts — `bigbrain open [--print] [--port <web port>]`: the viewer in a
 * browser on this machine.
 *
 * The viewer answers only this launch's session (lib/viewerSession.ts). This
 * hands the browser a link that starts one and stops working two minutes
 * later, so the browser's history keeps nothing usable. `--print` prints it
 * instead: over `ssh -L 4747:127.0.0.1:4747`, run `bigbrain open --print` on
 * the machine with the app and open the link where the tunnel ends.
 */

import { flagValue, hasFlag } from "../lib/cliflags";
import { handoffProcessEnv, webPort } from "../lib/env";
import { readViewerSession, viewerLink, viewerSessionPath } from "../lib/viewerSession";

const args = process.argv.slice(2);
const port = Number(flagValue(args, "port") ?? webPort());
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("usage: bigbrain open [--print] [--port <web port>]");
  process.exit(2);
}
const secret = readViewerSession(port);
if (!secret) {
  console.error(`bigbrain: no viewer session for :${port} (${viewerSessionPath(port)}) — is the app running?`);
  process.exit(1);
}
const link = viewerLink(port, secret);
if (hasFlag(args, "print")) {
  console.log(link);
} else {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const r = Bun.spawnSync([opener, link], { env: handoffProcessEnv(), stdout: "ignore", stderr: "ignore" });
  if (r.exitCode !== 0) {
    console.error(`bigbrain: ${opener} failed; \`bigbrain open --print\` prints the link (it works for two minutes)`);
    process.exit(1);
  }
}
