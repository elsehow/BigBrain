#!/usr/bin/env bun
/**
 * use.ts — `bigbrain use`: append a USE record to the retrieval ledger for
 * a note read outside the HTTP doors (#359).
 *
 * The caller that matters is the vault scaffold's PostToolUse hook on Read
 * (deploy/vault-template/settings.json): an agent that searches through a
 * door and then opens the hit with its own file tools was the ledger's
 * known blind spot — the search recorded, the read invisible, the pair
 * scored as a miss. `--hook` reads the Claude Code hook payload from
 * stdin; a path argument serves manual testing:
 *
 *   bigbrain use references/2026-08-14-some-note.md
 *
 * Only content notes are recorded (lib/retrieval.ts contentUseRel):
 * references/ and entities/ markdown, the trees search covers. memory/,
 * the journal, and anything outside the vault stay off the ledger.
 *
 * Hook posture throughout: print nothing, exit 0 no matter what — a
 * broken instrument must never cost the session its Read.
 */

import { discoverVaultRoot } from "../lib/engine";
import { contentUseRel, recordUse } from "../lib/retrieval";

try {
  const root = discoverVaultRoot();
  if (root) {
    let p: string | undefined;
    if (process.argv.includes("--hook")) {
      const payload = JSON.parse(await Bun.stdin.text()) as {
        tool_name?: string;
        tool_input?: { file_path?: string };
      };
      if (!payload.tool_name || payload.tool_name === "Read") p = payload.tool_input?.file_path;
    } else {
      p = process.argv[2];
    }
    const rel = p ? contentUseRel(root, p) : null;
    if (rel) recordUse(root, rel, "cli");
  }
} catch {
  /* hook posture: never fail the session */
}
process.exit(0);
