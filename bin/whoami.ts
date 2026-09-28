#!/usr/bin/env bun
/**
 * whoami.ts — `bigbrain whoami [--declare "<name>"] [--alias <label>]...
 * [--email <addr>] [--adopt-dossier]`: who this vault is about (#572).
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
 *   bigbrain whoami --adopt-dossier                   # fold a hosted-era dossier in (#683)
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
 *
 * A hosted-era vault may still carry the retired editor's answer, an
 * entities/ dossier flagged `human_user: true`. No prompt reads it any more:
 * `--declare` carries its labels along, and `--adopt-dossier` restates the
 * newest declaration with them folded in — the same name and entity, one
 * more event, the file left alone.
 */

import { requireVaultRoot } from "../lib/engine";
import { suggestedOwnerEmail } from "../lib/firstRun";
import {
  adoptLegacyUserDossier,
  declareUserIdentity,
  latestUserIdentity,
  legacyUserLabels,
  planLegacyUserAdoption,
} from "../lib/userIdentity";
import { flagValue, flagValues, hasFlag } from "../lib/cliflags";

const USAGE =
  'usage: bigbrain whoami [--declare "<name>"] [--alias <label>]... [--email <addr>] [--adopt-dossier]';

const argv = process.argv.slice(2);
if (hasFlag(argv, "help")) {
  console.error(USAGE);
  process.exit(2);
}

const root = requireVaultRoot();
const name = flagValue(argv, "declare");
const problem = (error: unknown): string => (error instanceof Error ? error.message : String(error));

if (hasFlag(argv, "adopt-dossier")) {
  if (name) {
    console.error(`whoami: --adopt-dossier restates the newest declaration; it takes no --declare\n${USAGE}`);
    process.exit(2);
  }
  const plan = planLegacyUserAdoption(root);
  if (!plan) {
    console.log("whoami: no entities/ dossier carries human_user: true — nothing to adopt");
    process.exit(0);
  }
  if (!plan.prior) {
    console.error(
      `whoami: nobody has said who this vault is about — \`bigbrain whoami --declare "Your Name"\` carries ${plan.dossiers.join(", ")} along`
    );
    process.exit(2);
  }
  if (!plan.missing.length) {
    console.log(`whoami: the declaration already says everything ${plan.dossiers.join(", ")} does — nothing to adopt`);
    process.exit(0);
  }
  const email = flagValue(argv, "email") ?? plan.email ?? suggestedOwnerEmail(root);
  if (!email) {
    console.error(
      "whoami: no email to attribute this to — pass --email, set git user.email in the vault, or sign in to Claude Code"
    );
    process.exit(2);
  }
  try {
    const me = adoptLegacyUserDossier(root, { email });
    console.log(
      `whoami: adopted ${plan.dossiers.join(", ")} — ${me.name} is also known as ${plan.missing.join(", ")} (${me.entity_id}, as ${me.account_id})`
    );
  } catch (error) {
    console.error(`whoami: ${problem(error)}`);
    process.exit(2);
  }
  process.exit(0);
}

if (!name) {
  const me = latestUserIdentity(root);
  const plan = planLegacyUserAdoption(root);
  if (!me) {
    console.error(
      'whoami: nobody has said who this vault is about — `bigbrain whoami --declare "Your Name"`' +
        (plan ? ` (${plan.dossiers.join(", ")} comes along)` : "")
    );
    process.exit(1);
  }
  console.log(`${me.name} (${me.entity_id})`);
  console.log(`  declared ${me.created_at} as ${me.account_id}`);
  if (me.aliases.length) console.log(`  also known as ${me.aliases.join(", ")}`);
  if (plan?.missing.length)
    console.log(
      `  ${plan.dossiers.join(", ")} still holds ${plan.missing.length} label(s) the declaration lacks: ` +
        `${plan.missing.join(", ")} — \`bigbrain whoami --adopt-dossier\` folds them in`
    );
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
    aliases: [...flagValues(argv, "alias"), ...legacyUserLabels(root)],
  });
  console.log(`whoami: ${me.name} is the owner of this vault (${me.entity_id}, as ${me.account_id})`);
  if (me.aliases.length > 1) console.log(`  also known as ${me.aliases.slice(1).join(", ")}`);
} catch (error) {
  console.error(`whoami: ${problem(error)}`);
  process.exit(2);
}
