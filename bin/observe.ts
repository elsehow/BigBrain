#!/usr/bin/env bun
/**
 * observe.ts — `bigbrain observe "<text>" [--query "<q>"]`: the
 * discretionary door for observations — voice arrivals since #521. An
 * agent that learned
 * something the vault should eventually know — a gap it hit, context it
 * carried that the record lacks — submits EVIDENCE here; it never writes
 * memory/ itself. The scheduled memory pass weighs it and decides.
 *
 * The observation lands as an insertion event (lib/voice.ts).
 */

import { userInfo } from "node:os";
import { flagValue, positionals } from "../lib/cliflags";
import { VAULT_ROOT } from "../lib/vaultRoot";
import { landVoice } from "../lib/voice";

const argv = process.argv.slice(2);
const query = flagValue(argv, "query") || undefined;
// `--now` (the urgency knob, 2026-08-05) retired 2026-09-02 with the early
// trigger it drove: an observation waits for the sweep like every arrival.

const text = positionals(argv, new Set(["query"])).join(" ").trim();

if (!text) {
  console.error('usage: bigbrain observe "<observation>" [--query "<what was searched>"]');
  process.exit(2);
}

// #521: an observation is a voice ARRIVAL — an insertion event the
// memory pass consumes via its cursor, not a spool file.
const landed = landVoice(
  VAULT_ROOT,
  { kind: "observation", text, ...(query ? { query } : {}) },
  { from: userInfo().username || "local", via: "cli:observe" },
  { idPrefix: "cli" }
);
console.log(`observe: landed ${landed.path}`);
