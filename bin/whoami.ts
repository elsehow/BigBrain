#!/usr/bin/env bun
/**
 * whoami.ts — `bigbrain whoami [--declare "<name>"] [--alias <label>]...
 * [--email <addr>]`: who this vault is about (#572).
 *
 * A personal vault has exactly one subject who never emerges from the
 * record: named in every meeting and clip, asserted by none of them. Until
 * someone says who, the gardener is handed the sentence "No vault-owner
 * identity labels were supplied" on every run, the graph draws the self node
 * it exists to hide, and the memory pass re-derives the person from raw
 * record each time.
 *
 * The app asks this on first run. This is the same door for an engine run
 * from a checkout, where there is no app to ask.
 *
 *   bigbrain whoami                                   # what the record says, or nothing
 *   bigbrain whoami --declare "Ada Lovelace"          # say it
 *   bigbrain whoami --declare "Ada" --alias "Lovelace" --alias ada@example.org
 *
 * The email defaults to the vault's git `user.email`, else the signed-in
 * Claude Code account. It is ASSERTED, not verified — on your own machine
 * those are the same grade of evidence — and it becomes the declaration's
 * account id and first alias. `--alias` repeats; each one is a label the
 * record may know the person by.
 *
 * Declaring again is not an edit: each declaration is immutable, the newest
 * wins, and it says the whole alias list. The name becomes an entity label,
 * and ids are `hash(label)`, so a changed name is a NEW entity — `bigbrain
 * entity supersede` is how the old one's assertions move across.
 */

import { requireVaultRoot } from "../lib/engine";
import { suggestedOwnerEmail } from "../lib/firstRun";
import { declareUserIdentity, latestUserIdentity } from "../lib/userIdentity";
import { flagValue, flagValues, hasFlag } from "../lib/cliflags";

const USAGE =
  'usage: bigbrain whoami [--declare "<name>"] [--alias <label>]... [--email <addr>]';

const argv = process.argv.slice(2);
if (hasFlag(argv, "help")) {
  console.error(USAGE);
  process.exit(2);
}

const root = requireVaultRoot();
const name = flagValue(argv, "declare");
const problem = (error: unknown): string => (error instanceof Error ? error.message : String(error));

if (!name) {
  const me = latestUserIdentity(root);
  if (!me) {
    console.error('whoami: nobody has said who this vault is about — `bigbrain whoami --declare "Your Name"`');
    process.exit(1);
  }
  console.log(`${me.name} (${me.entity_id})`);
  console.log(`  declared ${me.created_at} as ${me.account_id}`);
  if (me.aliases.length) console.log(`  also known as ${me.aliases.join(", ")}`);
  process.exit(0);
}

const email = flagValue(argv, "email") ?? suggestedOwnerEmail(root);
if (!email) {
  console.error(
    "whoami: no email to attribute this to — pass --email, set git user.email in the vault, or sign in to Claude Code"
  );
  process.exit(2);
}

try {
  const me = declareUserIdentity(root, {
    name,
    email,
    aliases: flagValues(argv, "alias"),
  });
  console.log(`whoami: ${me.name} is the owner of this vault (${me.entity_id}, as ${me.account_id})`);
  if (me.aliases.length > 1) console.log(`  also known as ${me.aliases.slice(1).join(", ")}`);
} catch (error) {
  console.error(`whoami: ${problem(error)}`);
  process.exit(2);
}
