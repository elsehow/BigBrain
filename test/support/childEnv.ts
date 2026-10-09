/**
 * childEnv.ts — the environment for an engine process a test spawns.
 *
 * test/preload.ts isolates the test process: a scratch key store and read
 * log, and no model-catalog network. A child given a hand-built env loses
 * all of it: it read the developer's real Jev key and put its drops to the
 * real firewall (#192), and an integration call would have landed in their
 * read log. This carries the isolation over, with a scratch HOME for
 * anything else the engine keeps under it.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "bb-test-home-"));
const CARRIED = ["BIGBRAIN_SHARED_CONNECTIONS", "BIGBRAIN_READ_LOG", "PI_OFFLINE"] as const;

export function childEnv(extra: Record<string, string>): Record<string, string> {
  const carried = Object.fromEntries(CARRIED.flatMap(k => process.env[k] ? [[k, process.env[k]]] : []));
  return { PATH: process.env.PATH!, HOME: home, ...carried, ...extra };
}
