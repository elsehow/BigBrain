/**
 * skipRules.ts — standing "never stage this" rules, per integration
 * (#744, 2026-09-04). A poller finds far more than the record wants — mail
 * most of all — and the gardener, passing on a staged arrival, may name a
 * SCOPE its verdict covers: every message from this sender, everything on
 * this list. The scope becomes a rule here, and the poller drops what a
 * rule covers before staging it, at zero tokens.
 *
 * Rules are CONFIG, not a log (Nick, 2026-08-31: no new event fields, find
 * the read-side fix): they live in vault.yaml under
 * `integrations.<name>.skip`, one map per rule — the scope's key/value plus
 * `reason` and `at` — committed as author `<name>` so `git log
 * --author=<name>` is the audit trail and the owner can delete a rule with
 * an editor. Nothing here knows what a sender or a list is: a poller
 * publishes each staged head's `scopes` (lib/stage.ts) and a rule is any
 * one of them, verbatim.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, YAMLMap, type Document } from "yaml";
import { writeAtomic } from "./fsx";
import { commitAs } from "./git";

/** One rule: exactly one scope key (anything but the two meta keys), its
 * value, and the meta. */
export interface SkipRule {
  reason: string;
  at: string;
  [scope: string]: string;
}

const META = new Set(["reason", "at"]);

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** The scope entry of a rule — its one non-meta key — or nothing when the
 * rule has none or several. */
export function ruleScope(rule: Readonly<Record<string, unknown>>): [string, string] | undefined {
  const keys = Object.keys(rule).filter((k) => !META.has(k));
  if (keys.length !== 1) return undefined;
  const v = str(rule[keys[0]!]);
  return v ? [keys[0]!, v.toLowerCase()] : undefined;
}

/** A block's `skip:` list, read tolerantly: a malformed rule is dropped,
 * never fatal — the file is hand-edited by contract. */
export function skipRules(block: Readonly<Record<string, unknown>> | undefined): SkipRule[] {
  const out: SkipRule[] = [];
  for (const raw of Array.isArray(block?.["skip"]) ? block!["skip"] : []) {
    if (!raw || typeof raw !== "object") continue;
    const scope = ruleScope(raw as Record<string, unknown>);
    if (!scope) continue;
    const r = raw as Record<string, unknown>;
    out.push({ [scope[0]]: scope[1], reason: str(r["reason"]) ?? "", at: str(r["at"]) ?? "" });
  }
  return out;
}

/** The rule that covers these scopes, if any — key and value must both
 * match, values case-insensitively. A poller's `scopes` are the exact
 * strings a rule may name (an address, a List-Id), never display text. */
export function skipMatches(
  scopes: Readonly<Record<string, string>>,
  rules: readonly SkipRule[]
): SkipRule | undefined {
  return rules.find((r) => {
    const scope = ruleScope(r);
    if (!scope) return false;
    const v = scopes[scope[0]];
    return typeof v === "string" && v.toLowerCase() === scope[1];
  });
}

function integrationMap(doc: Document, name: string): YAMLMap {
  if (!doc.hasIn(["integrations"])) doc.setIn(["integrations"], doc.createNode({}));
  if (!doc.hasIn(["integrations", name])) doc.setIn(["integrations", name], doc.createNode({}));
  const m = doc.getIn(["integrations", name]);
  if (!(m instanceof YAMLMap)) throw new Error(`vault.yaml: integrations.${name} is not a map`);
  return m;
}

/** Append rules under `integrations.<name>.skip`, skipping any already
 * there (and any repeated within the batch — several heads often name one
 * list), and commit as author `<name>`. Answers the rules that were new. */
export function appendSkipRules(root: string, name: string, rules: readonly SkipRule[]): SkipRule[] {
  if (!rules.length) return [];
  const yamlPath = join(root, "vault.yaml");
  const doc = parseDocument(readFileSync(yamlPath, "utf8"));
  const block = (doc.getIn(["integrations", name]) as { toJSON?: () => unknown } | undefined)?.toJSON?.();
  const existing = skipRules((block ?? {}) as Record<string, unknown>);
  const seen = new Set(existing.map((r) => ruleScope(r)!.join("=")));
  const fresh: SkipRule[] = [];
  for (const r of rules) {
    const scope = ruleScope(r);
    if (!scope) continue;
    const k = scope.join("=");
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push({ [scope[0]]: scope[1], reason: r.reason, at: r.at });
  }
  if (!fresh.length) return [];
  const raw = doc.getIn(["integrations", name, "skip"]);
  const list = raw && typeof (raw as { toJSON?: unknown }).toJSON === "function" ? ((raw as { toJSON: () => unknown }).toJSON() as unknown[]) : [];
  integrationMap(doc, name).set("skip", doc.createNode([...(Array.isArray(list) ? list : []), ...fresh]));
  writeAtomic(yamlPath, doc.toString());
  const what = fresh.map((r) => ruleScope(r)!.join(" ")).join(", ");
  commitAs(root, name, `${name}: skip ${what}`, ["vault.yaml"]);
  return fresh;
}
