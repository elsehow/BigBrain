#!/usr/bin/env bun
/**
 * entity.ts — `bigbrain entity …`: the operator's door to entity aliases
 * (lib/entityAliasLog.ts). An assertion entity's id is a hash of its label,
 * so "Evan" and "Evan Keller" are two entities until someone says they are
 * one; this is where someone says it.
 *
 *   bigbrain entity alias "<label>" --into <ent_id|"Label">   declare: the label names that entity
 *   bigbrain entity alias "<label>" --retract                  the label is its own entity again
 *   bigbrain entity seed-aliases [--dry-run]                   declare every entities/*.md alias list
 *   bigbrain entity resolve "<label or ent_id>"                what the record resolves it to
 *   bigbrain entity aliases [<label or ent_id>]                the alias table, or one entity's
 *   bigbrain entity supersede <stub> --into <canonical> [--assertion ast_… …] [--dry-run]
 *                                                              correct the stub's assertions, one by one (#629)
 *   bigbrain entity folds [--propose [--model <m>]] [--json]   the labels that name one thing, as the memory
 *                                                              pass proposes them (#728) — accept with `alias`
 *
 * Host-authored, never a model's: the gardener links ids or writes labels
 * (its `[[…]]` grammar), and the intake guard refuses a would-be stub with
 * the candidates — the operator decides identities here. An alias is for a
 * deliberate, unambiguous label variant (an email, "JHo", an org rename)
 * and applies read-side only; a bare given name is never an alias — a past
 * split is corrected with `supersede`, and the future is the guard's.
 */

import { ownerEmail } from "../lib/env";
import { userInfo } from "node:os";
import { assertionEntityId } from "../lib/assertionLog";
import { AST_ID, ENT_ID } from "../lib/ids";
import { flagValue, flagValues, hasFlag, positionals } from "../lib/cliflags";
import {
  appendAndProjectEntityAlias,
  openAssertionProjectionReadonly,
  projectedAssertionEntity,
  retiredEntitySuccessor,
  syncAssertionProjection,
} from "../lib/assertionProjection";
import { requireVaultRoot } from "../lib/engine";
import { commitEntityAliasEvents, createEntityAliasEvent } from "../lib/entityAliasLog";
import { seedEntityAliases } from "../lib/entityAliasSeed";
import { supersedeEntity } from "../lib/entitySupersede";
import { describeFolds, liveFolds, proposeEntityFolds, readEntityFolds } from "../lib/entityFolds";
import { loadManifest } from "../lib/manifest";

const USAGE = `usage:
  bigbrain entity alias "<label>" --into <ent_id|"Label">
  bigbrain entity alias "<label>" --retract
  bigbrain entity seed-aliases [--dry-run]
  bigbrain entity resolve "<label or ent_id>"
  bigbrain entity aliases [<label or ent_id>]
  bigbrain entity supersede <stub> --into <canonical> [--assertion ast_… …] [--dry-run]
  bigbrain entity folds [--propose [--model <m>]] [--json]`;

const root = requireVaultRoot();
const [cmd, ...rest] = process.argv.slice(2);
const positional = positionals(rest, new Set(["into", "assertion", "model"]));
const author = { kind: "user" as const, id: ownerEmail() ?? userInfo().username };
const idOf = (ref: string): string => (ENT_ID.test(ref) ? ref : assertionEntityId(ref));
const show = (id: string): string => {
  const e = projectedAssertionEntity(root, id);
  if (!e) {
    const successor = retiredEntitySuccessor(root, id);
    return successor
      ? `${id} — retired; its assertions were superseded into ${successor.id} "${successor.label}"`
      : `${id} — not in the record`;
  }
  const aliases = e.aliases?.length ? ` · aliases: ${e.aliases.join(", ")}` : "";
  return `${e.id} "${e.label}" (${e.assertions} assertions)${aliases}`;
};

switch (cmd) {
  case "alias": {
    const label = positional[0]?.trim();
    const into = flagValue(rest, "into")?.trim();
    const retract = hasFlag(rest, "retract");
    if (!label || (!into && !retract) || (into && retract)) {
      console.error(USAGE);
      process.exit(2);
    }
    syncAssertionProjection(root);
    const aliasId = assertionEntityId(label);
    let entity: { id: string; label: string };
    if (retract) {
      const held = projectedAssertionEntity(root, aliasId);
      entity = { id: aliasId, label: held?.id === aliasId ? held.label : label };
    } else {
      const target = projectedAssertionEntity(root, idOf(into!));
      if (!target) {
        if (into!.startsWith("ent_")) {
          console.error(`bigbrain entity: ${into} is not in the record`);
          process.exit(2);
        }
        // A label no assertion has linked yet: declare toward it anyway —
        // the entity appears with its first assertion, under this label.
        entity = { id: assertionEntityId(into!), label: into!.replace(/\s+/g, " ") };
      } else entity = { id: target.id, label: target.label };
      if (entity.id === aliasId) {
        console.error(`bigbrain entity: "${label}" already IS ${entity.id} — nothing to declare`);
        process.exit(2);
      }
    }
    const event = createEntityAliasEvent({
      alias: label, entity, author, created_at: new Date().toISOString(),
      produced_by: { procedure: "entity-alias-cli", version: "1" },
    });
    const result = appendAndProjectEntityAlias(root, event);
    commitEntityAliasEvents(root, [result.path],
      retract ? `entity alias: retract "${label}"` : `entity alias: "${label}" → ${entity.label}`);
    console.log(retract
      ? `retracted: "${label}" is its own entity (${aliasId})`
      : `declared: "${label}" (${aliasId}) → ${show(entity.id)}`);
    break;
  }
  case "seed-aliases": {
    const result = seedEntityAliases(root, { author, dryRun: hasFlag(rest, "dry-run") });
    for (const d of result.declare)
      console.log(`${hasFlag(rest, "dry-run") ? "would declare" : "declared"}: "${d.alias}" (${d.alias_assertions}) → ${d.entity.id} "${d.entity.label}"  (${d.dossier})`);
    for (const s of result.skipped) console.log(`skipped: "${s.alias}" (${s.dossier}) — ${s.reason}`);
    console.log(`${result.appended} declared, ${result.declare.length - result.appended} planned, ${result.skipped.length} skipped`);
    break;
  }
  case "resolve": {
    const ref = positional[0]?.trim();
    if (!ref) { console.error(USAGE); process.exit(2); }
    syncAssertionProjection(root);
    console.log(show(idOf(ref)));
    break;
  }
  case "aliases": {
    syncAssertionProjection(root);
    const ref = positional[0]?.trim();
    const db = openAssertionProjectionReadonly(root);
    try {
      const rows = (ref
        ? db.query("SELECT alias, alias_id, entity_id, entity_label FROM entity_aliases WHERE entity_id = ? ORDER BY alias")
          .all(projectedAssertionEntity(root, idOf(ref))?.id ?? idOf(ref))
        : db.query("SELECT alias, alias_id, entity_id, entity_label FROM entity_aliases ORDER BY entity_label, alias").all()
      ) as { alias: string; alias_id: string; entity_id: string; entity_label: string }[];
      for (const r of rows) console.log(`"${r.alias}" (${r.alias_id}) → ${r.entity_id} "${r.entity_label}"`);
      if (!rows.length) console.log("no aliases declared");
    } finally { db.close(); }
    break;
  }
  case "folds": {
    // The feeder's door (#728): what the memory pass last proposed, or
    // — --propose — a run of it now, on the sweep's model unless --model
    // says otherwise. The proposals are derived state; an accept is
    // `bigbrain entity alias`, and stays the operator's.
    let folds = readEntityFolds(root);
    if (hasFlag(rest, "propose")) {
      const manifest = loadManifest(root);
      const model = flagValue(rest, "model") ?? manifest.memory.model;
      console.error(`entity folds: reading the census, proposing with ${model}…`);
      folds = (await proposeEntityFolds(root, { target: { ...manifest.memory, model }, auth: manifest.auth })).folds;
    }
    if (!folds) {
      console.log("no proposals yet — `bigbrain entity folds --propose`, or wait for the memory pass");
      break;
    }
    // what stands TODAY (liveFolds), not the file as written: a member
    // folded since, or a pair rejected since, is already gone here
    const live = liveFolds(root);
    console.log(hasFlag(rest, "json") ? JSON.stringify({ ...folds, groups: live.groups }, null, 2) : describeFolds(folds, live.groups));
    break;
  }
  case "supersede": {
    const from = positional[0]?.trim();
    const into = flagValue(rest, "into")?.trim();
    if (!from || !into) { console.error(USAGE); process.exit(2); }
    const only = flagValues(rest, "assertion");
    // A `--assertion` that names nothing must not quietly mean "all of them":
    // that is the difference between splitting a mixed stub and moving it.
    if (rest.includes("--assertion") && (!only.length || only.some((id) => !AST_ID.test(id)))) {
      console.error("bigbrain entity: every --assertion needs an ast_… id");
      process.exit(2);
    }
    const dryRun = hasFlag(rest, "dry-run");
    let r;
    try {
      r = supersedeEntity(root, { from, into, ...(only.length ? { only } : {}), operator: author.id, dryRun });
    } catch (error) {
      // One line, not a stack: an operator reads this in a loop's output.
      console.error(`bigbrain entity: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    for (const item of r.items)
      console.log(`${dryRun ? "would supersede" : "superseded"} ${item.original} → ${item.copy}: ${item.text.slice(0, 120)}`);
    console.log(`${r.appended} superseded [[${r.from.label}]] → ${r.into.id} "${r.into.label}"` +
      (r.left ? `; ${r.left} left on the stub` : "") + (dryRun ? ` (dry run: ${r.items.length} planned)` : ""));
    break;
  }
  default:
    console.error(USAGE);
    process.exit(cmd ? 2 : 0);
}
