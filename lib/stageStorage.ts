/** Durable staged heads, bodies, and legacy preservation. No admission policy. */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createAtomic } from "./fsx";
import { ensureSpool, spoolDir } from "./spool";
import type { Attachment } from "./intake";

export interface StagedHead {
  /** The item's own id — the poller derives it from the source's identity
   * (a Message-ID), so a re-poll converges on one staged item. */
  id: string;
  /** The integration that staged it (`integrations/<source>/`). */
  source: string;
  /** Account instance; older pending bodies retain their original envelope. */
  account?: string;
  /** When it happened at the source (a message's date) — the sort key. */
  at: string;
  /** The one-line head the poller composed: who, what, how big, marks. */
  line: string;
}

export interface StagedItem extends StagedHead {
  /** The integration's original filename, retained as metadata. */
  name: string;
  /** The item as it would land — envelope and body, whole. */
  content: string;
  attachments?: Attachment[];
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/u;
const SOURCE_RE = /^[a-z][a-z0-9-]{0,40}$/u;

export const stageDir = (root: string): string => join(spoolDir(root), "stage");

function itemPath(root: string, source: string, id: string): string {
  if (!SOURCE_RE.test(source)) throw new Error(`stage: bad source name ${JSON.stringify(source)}`);
  if (!ID_RE.test(id)) throw new Error(`stage: bad item id ${JSON.stringify(id)}`);
  return join(stageDir(root), source, `${id}.json`);
}

export const bodyPath = (root: string, source: string, id: string): string =>
  join(stageDir(root), source, "bodies", `${id}.json`);

/** The body is published before its head. A concurrent retry uses the
 * winning body's metadata, so a head can never describe different bytes. */
export function stage(root: string, item: StagedItem): boolean {
  const path = itemPath(root, item.source, item.id);
  ensureSpool(root);
  const payload = bodyPath(root, item.source, item.id);
  const fresh = createAtomic(payload, JSON.stringify(item));
  const held = fresh ? item : readItem(payload);
  if (!held) throw new Error(`stage: unreadable pending body ${item.id}`);
  return createAtomic(path, JSON.stringify(head(held)));
}

/** Operational data from older engines is retained before their cache can
 * be discarded. This never edits event logs or curated content. */
export function preserveStaged(root: string): void {
  const legacy = join(root, ".state", "stage");
  let sources: string[];
  try { sources = readdirSync(legacy, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return; }
  for (const source of sources) {
    for (const name of readdirSync(join(legacy, source)).filter((f) => f.endsWith(".json"))) {
      const path = join(legacy, source, name);
      const item = readItem(path);
      if (!item) continue;
      stage(root, item);
      rmSync(path, { force: true });
    }
  }
  try {
    const audit = readFileSync(join(legacy, "passed.jsonl"));
    ensureSpool(root);
    createAtomic(join(stageDir(root), "passed-legacy.jsonl"), audit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function readItem(path: string): StagedItem | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<StagedItem>;
    if (typeof raw.id !== "string" || typeof raw.content !== "string" || typeof raw.source !== "string") return undefined;
    return {
      id: raw.id,
      source: raw.source,
      ...(typeof raw.account === "string" ? {account:raw.account} : {}),
      at: typeof raw.at === "string" ? raw.at : "",
      line: typeof raw.line === "string" ? raw.line : raw.id,
      name: typeof raw.name === "string" ? raw.name : `${raw.id}.md`,
      content: raw.content,
      ...(Array.isArray(raw.attachments) ? { attachments: raw.attachments as Attachment[] } : {}),
    };
  } catch {
    return undefined; // a file mid-write, or corrupt: represents nothing this read
  }
}

const head = (i: StagedHead): StagedHead => ({
  id: i.id, source: i.source, ...(i.account ? {account:i.account} : {}), at: i.at, line: i.line,
});

export function readHead(path: string): StagedHead | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as StagedHead;
    if (!ID_RE.test(value.id) || !SOURCE_RE.test(value.source) ||
        typeof value.at !== "string" || typeof value.line !== "string") return undefined;
    return head(value);
  } catch { return undefined; }
}

/** Enumerating pending work never reads bodies or base64 attachments. */
export function headFiles(root: string): { id: string; source: string; path: string }[] {
  preserveStaged(root);
  const base = stageDir(root);
  let sources: string[];
  try { sources = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && SOURCE_RE.test(d.name)).map((d) => d.name); }
  catch { return []; }
  return sources.flatMap((source) => readdirSync(join(base, source))
    .filter((f) => f.endsWith(".json") && ID_RE.test(f.slice(0, -5)))
    .map((f) => ({ id: f.slice(0, -5), source, path: join(base, source, f) })));
}

export function stagedCount(root: string): number {
  return headFiles(root).filter((f) => readHead(f.path)).length;
}

export function find(root: string, id: string): { item: StagedItem; path: string } | undefined {
  if (!ID_RE.test(id)) return undefined;
  const file = headFiles(root).find((f) => f.id === id);
  if (!file) return undefined;
  const item = readItem(bodyPath(root, file.source, id));
  return item ? { item, path: file.path } : undefined;
}

export function removeStaged(root: string, hit: { item: StagedItem; path: string }): void {
  rmSync(hit.path, { force: true });
  rmSync(bodyPath(root, hit.item.source, hit.item.id), { force: true });
}

/** Full durable payloads for source-side recovery, including inactive accounts. */
export function stagedItems(root:string,source:string):StagedItem[] {
 return headFiles(root).filter(f=>f.source===source).map(f=>{
  const item=readItem(bodyPath(root,f.source,f.id));
  if(!item)throw Error('Unreadable pending integration item: '+f.id);
  return item;
 });
}
