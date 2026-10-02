import {includesEverything} from './inclusionMode';
import {readInclusionPolicy,integrationRuleScope} from './inclusionPolicy';
import {connectionStorePath} from './sharedConnections';
import {inclusionPermit} from './inclusionStagePermit';
import {rememberingRule} from './integrationAccess';
import { stageDir, bodyPath, headFiles, readHead, find, removeStaged, type StagedHead } from "./stageStorage";
import { withProjectionWrite } from "./projectionWriteLock";
import { isGranolaMcpContent, granolaRevision, receiveStagedGranola } from "./granolaRevision";
import { parseEnvelope } from "./envelope";
import { integrationAccounts } from "./integrationAccess";
import { receiveStagedTracks } from "./thatTracks";
import { integrationActive, MANAGED_INTEGRATIONS } from "./integrationAccess";
/** Pending integration arrivals live in the durable, gitignored .spool.
 * Heads are small files; bodies and attachments are opened only on demand.
 * Admission appends an insertion before removing pending data. Passing
 * persists any skip rule and audit entry before removing pending data.
 * Older .state/stage files are preserved lazily on first access. */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { admit } from "./door";
import { appendSkipRules, ruleScope, type SkipRule } from "./skipRules";

/** How many staged heads one `next` shows. A head is ~30 tokens, so the
 * overview of a busy week fits; the gardener works down the list oldest
 * first and the next call shows what is left. */
export const STAGE_BATCH_LIMIT = 80;

/** Inline cap for `open` — the same ceiling `next` puts on an insertion's
 * body (lib/work.ts WORK_BODY_INLINE_CHARS); a staged item has no
 * read_note path to page the rest, so the cap is the cap. */
export const STAGE_INLINE_CHARS = 20_000;

export function stagedHeads(root: string, limit = STAGE_BATCH_LIMIT): StagedHead[] {
  return headFiles(root).flatMap((f) => {
    const row = readHead(f.path);
    return row && (!MANAGED_INTEGRATIONS.has(row.source) || stagedRememberingEnabled(root,row)) && !reviewOwnsStage(root,row) ? [row] : [];
  }).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).slice(0, limit);
}

export function stagedIds(root: string): string[] {
  return stagedHeads(root, Infinity).map((h) => h.id);
}

export interface OpenedItem {
  id: string;
  line: string;
  content: string;
  content_length: number;
  truncated: boolean;
}

export interface OpenRefusal {
  id: string;
  error: string;
}

/** The bodies the gardener asked for, capped honestly. An id that is not
 * staged answers with an error row rather than failing the call. */
export function openStaged(root: string, ids: readonly string[]): (OpenedItem | OpenRefusal)[] {
  return ids.map((id) => {
    const hit = find(root, id);
    if (hit && MANAGED_INTEGRATIONS.has(hit.item.source) && !stagedRememberingEnabled(root,hit.item)) return { id, error: "Integration is inactive; pending data is retained." };
    if (!hit) return { id, error: "not staged — it may have been admitted or passed already" };
    const { content } = hit.item;
    const truncated = content.length > STAGE_INLINE_CHARS;
    return {
      id, line: hit.item.line,
      content: truncated ? content.slice(0, STAGE_INLINE_CHARS) : content,
      content_length: content.length, truncated,
    };
  });
}

export interface AdmitResult {
  id: string;
  ok: boolean;
  /** The insertion event the landing appended — what assertions cite. */
  insertion_id?: string;
  /** The item's id in the record (`source_id` on the projection). */
  source_id?: string;
  error?: string;
}

/** Land staged items through the door's `admit` — the firewall screened
 * them when the door staged them — and unstage them. From here on each is
 * an ordinary due arrival: `next` packs it, assertions cite its insertion id. */
export function admitStaged(root: string, ids: readonly string[]): AdmitResult[] {
  return withProjectionWrite(root, () => admitLocked(root, ids));
}
function admitLocked(root: string, ids: readonly string[]): AdmitResult[] {
  return ids.map((id) => {
    const hit = find(root, id);
    if (!hit) return { id, ok: false, error: "not staged — it may have been admitted or passed already" };
    try {
      if (MANAGED_INTEGRATIONS.has(hit.item.source) && !stagedRememberingEnabled(root,hit.item)) throw new Error("Integration is inactive; pending data is retained.");
      enforceReview(root,hit.item,true);
      const receipt = hit.item.source === "that-tracks" ? receiveStagedTracks(root, hit.item.content) : hit.item.source === "granola" && isGranolaMcpContent(hit.item.content) ? receiveStagedGranola(root, hit.item.content) : admit({
        root, content: hit.item.content,
        ...(hit.item.attachments?.length ? { attachments: hit.item.attachments } : {}),
      });
      removeStaged(root, hit);
      return {
        id, ok: true,
        insertion_id: receipt.insertionId,
        source_id: receipt.id,
      };
    } catch (e) {
      return { id, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) };
    }
  });
}

export interface PassResult {
  id: string;
  ok: boolean;
  /** The rule that was written for this head's source, when one was new. */
  rule?: SkipRule;
  error?: string;
}

/** The gardener's word that a staged item should not enter. `rule`, when
 * given, is ONE scope of the head — `{"list": "<List-Id>"}`, `{"sender":
 * "<address>"}` — and must match the head's own `scopes` verbatim; a scope
 * the head lists under `protect` (a person the record knows) is refused,
 * and the message alone is passed. The rule joins `integrations.<source>
 * .skip` and the poller drops matching arrivals before staging them. */
export function passStaged(
  root: string,
  ids: readonly string[],
  reason: string,
  rule?: Readonly<Record<string, unknown>>,
  now = new Date()
): PassResult[] {
  return withProjectionWrite(root, () => passLocked(root, ids, reason, rule, now));
}
function passLocked(root: string, ids: readonly string[], reason: string, rule: Readonly<Record<string, unknown>> | undefined, now: Date): PassResult[] {
  const scope = rule ? ruleScope(rule) : undefined;
  if (rule && !scope) {
    const msg = "rule must name exactly one scope: {\"<scope>\": \"<value>\"} taken from the head's scopes";
    return ids.map((id) => ({ id, ok: false, error: msg }));
  }
  const results: PassResult[] = [];
  const plans: { hit: NonNullable<ReturnType<typeof find>>; rule?: SkipRule }[] = [];
  const toWrite = new Map<string, SkipRule[]>();
  const today = now.toISOString().slice(0, 10);
  for (const id of ids) {
    const hit = find(root, id);
    if (!hit) {
      results.push({ id, ok: false, error: "not staged — it may have been admitted or passed already" });
      continue;
    }
    const { item } = hit;
    if (MANAGED_INTEGRATIONS.has(item.source) && !stagedRememberingEnabled(root,item)) { results.push({id,ok:false,error:"Integration is inactive; pending data is retained."}); continue; }
    try{enforceReview(root,item,false);}catch(e){results.push({id,ok:false,error:(e as Error).message});continue;}
    let ruleFor: SkipRule | undefined;
    if (scope) {
      const [key, value] = scope;
      const own = item.scopes[key];
      if (typeof own !== "string" || own.toLowerCase() !== value) {
        results.push({ id, ok: false, error: `this head carries no ${key} ${JSON.stringify(value)} — its scopes are ${JSON.stringify(item.scopes)}` });
        continue;
      }
      if (item.protect?.includes(key)) {
        results.push({ id, ok: false, error: `${key} ${JSON.stringify(value)} is a person the record knows — pass the message alone, without a rule` });
        continue;
      }
      ruleFor = { [key]: value, reason: reason || item.line, at: today };
      toWrite.set(item.source, [...(toWrite.get(item.source) ?? []), ruleFor]);
    }
    plans.push({ hit, ...(ruleFor ? { rule: ruleFor } : {}) });
  }
  const written = new Map<string, Set<string>>();
  const failures = new Map<string, string>();
  for (const [source, rules] of toWrite) {
    try {
      written.set(source, new Set(appendSkipRules(root, source, rules).map((r) => ruleScope(r)!.join("="))));
    } catch (error) {
      failures.set(source, error instanceof Error ? error.message : String(error));
    }
  }
  for (const { hit, rule: ruleFor } of plans) {
    const { item } = hit;
    const failed = failures.get(item.source);
    if (ruleFor && failed) {
      results.push({ id: item.id, ok: false, error: failed });
      continue;
    }
    try {
      mkdirSync(stageDir(root), { recursive: true });
      appendFileSync(join(stageDir(root), "passed.jsonl"),
        `${JSON.stringify({ at: now.toISOString(), id: item.id, source: item.source, line: item.line, reason, ...(item.source === "granola" && isGranolaMcpContent(item.content) ? { revision: granolaRevision(item.content) } : {}), ...(ruleFor ? { rule: ruleFor } : {}) })}\n`);
      removeStaged(root, hit);
      const fresh = ruleFor && written.get(item.source)?.has(ruleScope(ruleFor)!.join("="));
      results.push({ id: item.id, ok: true, ...(fresh ? { rule: ruleFor } : {}) });
    } catch (error) {
      results.push({ id: item.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
}

/** Older pending records are resolved from their envelope without rewriting history. */
export function stagedAccount(root:string,item:StagedHead):string|undefined {
  if(item.account)return item.account;
  if(item.source!=="email")return item.source;
  try { const body=readFileSync(bodyPath(root,item.source,item.id),"utf8");const parsed=JSON.parse(body);const meta=parseEnvelope(parsed.content).envelope;if(typeof meta.inbox==="string")return meta.inbox; }catch{/* Missing/corrupt bodies remain pending. */}
  const accounts=integrationAccounts(root,item.source);return accounts.length===1?accounts[0]:undefined;
}
function stagedRememberingEnabled(root:string,item:StagedHead):boolean {
  const account=stagedAccount(root,item);return !!account&&integrationActive(root,item.source,account);
}


// Preserve maintenance entry points while low-level consumers import storage directly.
export { stageDir, preserveStaged, stagedCount, stagedItems, type StagedHead, type StagedItem } from "./stageStorage";

function reviewOwnsStage(root:string,item:StagedHead){const account=stagedAccount(root,item);return !!account&&(includesEverything(rememberingRule(root,item.source,account))||!!readInclusionPolicy(root,connectionStorePath(),integrationRuleScope(item.source,account)));}
function enforceReview(root:string,item:import('./stageStorage').StagedItem,include:boolean){const account=stagedAccount(root,item);if(account&&!inclusionPermit(root,connectionStorePath(),integrationRuleScope(item.source,account),rememberingRule(root,item.source,account),item,include))throw Error('This item is awaiting its reviewed inclusion rule.');}
