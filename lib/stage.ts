import { stageDir, bodyPath, headFiles, readHead, find, removeStaged, type StagedHead } from "./stageStorage";
import { withProjectionWrite } from "./projectionWriteLock";
import { isGranolaMcpContent, granolaRevision, receiveStagedGranola } from "./granolaRevision";
import { parseEnvelope } from "./envelope";
import { receiveStagedTracks } from "./thatTracks";
import { integrationAccounts, integrationActive, MANAGED_INTEGRATIONS } from "./integrationAccess";
/** Pending integration arrivals live in the durable, gitignored .spool.
 * Heads are small files; bodies and attachments are opened only on demand.
 * Admission appends an insertion before removing pending data. Passing
 * persists its audit entry before removing pending data.
 * Older .state/stage files are preserved lazily on first access. */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { admit } from "./door";

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
    // a managed integration's arrivals are admitted by its own step (lib/integrationAdmission.ts), not the gardener
    return row && !MANAGED_INTEGRATIONS.has(row.source) ? [row] : [];
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
  error?: string;
}

/** A staged item should not enter: one audit line in passed.jsonl, then the
 * pending data goes. */
export function passStaged(root: string, ids: readonly string[], reason: string, now = new Date()): PassResult[] {
  return withProjectionWrite(root, () => passLocked(root, ids, reason, now));
}
function passLocked(root: string, ids: readonly string[], reason: string, now: Date): PassResult[] {
  const results: PassResult[] = [];
  for (const id of ids) {
    const hit = find(root, id);
    if (!hit) {
      results.push({ id, ok: false, error: "not staged — it may have been admitted or passed already" });
      continue;
    }
    const { item } = hit;
    if (MANAGED_INTEGRATIONS.has(item.source) && !stagedRememberingEnabled(root,item)) { results.push({id,ok:false,error:"Integration is inactive; pending data is retained."}); continue; }
    try {
      mkdirSync(stageDir(root), { recursive: true });
      appendFileSync(join(stageDir(root), "passed.jsonl"),
        `${JSON.stringify({ at: now.toISOString(), id: item.id, source: item.source, line: item.line, reason, ...(item.source === "granola" && isGranolaMcpContent(item.content) ? { revision: granolaRevision(item.content) } : {}) })}\n`);
      removeStaged(root, hit);
      results.push({ id: item.id, ok: true });
    } catch (error) {
      results.push({ id: item.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
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
