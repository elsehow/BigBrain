/** That Tracks owns the change ordering; BigBrain owns the arrival log.
 * Production polling stages revisions for the gardener's remembering rule. The
 * checkpoint is durable operational data, published only after a full page
 * lands. Object heads come from the existing projection, never a second
 * source store; deleting either cache safely replays the API's full history. */
import { join } from "node:path";
import { parseEnvelope, serializeEnvelope } from "./envelope";
import { writeAtomic } from "./fsx";
import { sha256hex } from "./hash";
import { admit, land } from "./door";
import type { IntakeReceipt } from "./intake";
import { readCursorJson } from "./integrationCursor";
import { PollError } from "./integrationStatus";
import { openAssertionProjectionReadonly, syncAssertionProjection } from "./assertionProjection";

export const THAT_TRACKS_BASE = "https://emtsezwzrtglmgahksnb.supabase.co/functions/v1/api/v1";
export type TracksRecord = Record<string, unknown> & { id: string; revision: number; updatedAt: string };
export interface TracksChange {
  cursor: string;
  entity: "categories" | "trackers" | "events";
  operation: "upsert" | "delete";
  record: TracksRecord;
}
interface Page { items: TracksChange[]; nextCursor: string; hasMore: boolean }
interface Identity { id: string; scopes: string[]; trackerIDs: string[] | null }
interface Context { categories: Record<string, TracksRecord>; trackers: Record<string, TracksRecord> }
interface Checkpoint extends Context { grant: string; cursor: string; complete: boolean }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const cursor = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
const text = (v: unknown): string => typeof v === "string" ? v : "";

export class ThatTracksClient {
  constructor(private key: string, private base = THAT_TRACKS_BASE, private request: typeof fetch = fetch) {}
  private async get(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(`${this.base}${path}`, {
        headers: { Authorization: `Bearer ${this.key}` }, redirect: "error", signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new PollError("Could not reach That Tracks; will retry", "network"); }
    if (response.status === 401 || response.status === 403)
      throw new PollError("That Tracks rejected the key. Replace it with a valid read key.", "credentials");
    if (response.status === 429) throw new PollError("That Tracks is rate limiting requests; will retry");
    if (!response.ok) throw new PollError(`That Tracks returned HTTP ${response.status}; will retry`);
    try { return await response.json(); }
    catch { throw new PollError("That Tracks returned an invalid response; will retry", "format"); }
  }
  async identity(): Promise<Identity> {
    const value = await this.get("/me");
    if (!object(value) || !uuid(value.id) || !Array.isArray(value.scopes) || !value.scopes.includes("read") ||
      !(value.trackerIDs === null || (Array.isArray(value.trackerIDs) && value.trackerIDs.every(uuid))))
      throw new PollError("That Tracks did not return a readable account", "format");
    return value as unknown as Identity;
  }
  async changes(after: string): Promise<Page> {
    const value = await this.get(`/changes?cursor=${after}&limit=100`);
    if (!object(value) || !Array.isArray(value.items) || !cursor(value.nextCursor) || typeof value.hasMore !== "boolean")
      throw new PollError("That Tracks returned an invalid change page; will retry", "format");
    let last = BigInt(after);
    for (const c of value.items) {
      if (!object(c) || !cursor(c.cursor) || BigInt(c.cursor) <= last ||
        !["categories", "trackers", "events"].includes(String(c.entity)) || !["upsert", "delete"].includes(String(c.operation)) ||
        !object(c.record) || !uuid(c.record.id) || !Number.isSafeInteger(c.record.revision) || Number(c.record.revision) < 1 ||
        typeof c.record.updatedAt !== "string" || !Number.isFinite(Date.parse(c.record.updatedAt)))
        throw new PollError("That Tracks returned an invalid change; no checkpoint was advanced", "format");
      if (c.entity === "events" && (!uuid(c.record.trackerID) || (c.operation === "upsert" &&
        (typeof c.record.timestamp !== "string" || !Number.isFinite(Date.parse(c.record.timestamp)) ||
         typeof c.record.value !== "number" || !Number.isFinite(c.record.value)))))
        throw new PollError("That Tracks returned an invalid event; no checkpoint was advanced", "format");
      if (c.entity !== "events" && c.operation === "upsert" && typeof c.record.name !== "string")
        throw new PollError("That Tracks returned an invalid tracker or category; will retry", "format");
      last = BigInt(c.cursor);
    }
    if (BigInt(value.nextCursor) < last || (value.hasMore && BigInt(value.nextCursor) <= BigInt(after)))
      throw new PollError("That Tracks returned a non-advancing change page; will retry");
    return value as unknown as Page;
  }
}

export const tracksSourceId = (account: string, c: TracksChange): string => `that-tracks-${account}-${c.entity}-${c.record.id}`;

/** Source timestamps stay exact. No day buckets: the API normalizes to UTC
 * and does not retain the phone's original timezone. A missing day is never
 * fabricated as a zero. Notes are verbatim and original JSON rides with them. */
export function tracksContent(account: string, c: TracksChange, context: Context, supersedes?: string): string {
  const r = c.record;
  const tracker = c.entity === "events" ? context.trackers[text(r.trackerID)] : c.entity === "trackers" ? (c.operation === "delete" ? context.trackers[r.id] : r) : undefined;
  const category = c.entity === "categories" ? (c.operation === "delete" ? context.categories[r.id] : r) : context.categories[text(tracker?.categoryID)];
  const name = text(c.entity === "categories" ? category?.name : tracker?.name) || `${c.entity} ${r.id}`;
  const deleted = c.operation === "delete";
  const date = c.entity === "events" && !deleted ? text(r.timestamp) : r.updatedAt;
  const title = deleted ? `Withdrawn from That Tracks — ${name}`
    : c.entity === "events" ? `${name} — ${date}` : `That Tracks ${c.entity === "trackers" ? "tracker" : "category"}: ${name}`;
  const lines = [`# ${title}`, ""];
  if (deleted) lines.push(`This ${c.entity === "events" ? "event" : c.entity === "trackers" ? "tracker" : "category"} was deleted in That Tracks at ${text(r.deletedAt) || r.updatedAt}.`,
    "It is withdrawn evidence, not a currently logged entry. Earlier revisions remain in the vault's history.");
  else if (c.entity === "events") {
    const config = object(tracker?.config) ? tracker.config : {};
    const amount = object(config.amount) ? config.amount : {};
    const unit = r.value === 1 ? text(amount.unit) : text(amount.plural) || text(amount.unit);
    lines.push(`Timestamp: ${text(r.timestamp)}`, `Tracker: ${name}`,
      ...(category ? [`Category: ${text(category.name)}`] : []),
      `Value: ${r.value}${unit ? ` ${unit}` : ""}`,
      ...(typeof r.option === "string" ? [`Selected: ${r.option}`] : []),
      ...(Array.isArray(r.options) ? [`Selected: ${r.options.join(", ")}`] : []),
      ...(typeof r.source === "string" ? [`Logged via: ${r.source}`] : []),
      ...(typeof r.note === "string" ? ["", "## Note", "", r.note] : []));
  } else {
    lines.push(`Name: ${name}`, ...(c.entity === "trackers" ? [
      `Category: ${text(category?.name) || "Ungrouped"}`, `Archived: ${r.archived === true ? "yes" : "no"}`,
      "", "Configuration:", JSON.stringify(r.config ?? {}, null, 2),
    ] : []));
  }
  return serializeEnvelope({
    id: tracksSourceId(account, c), source: "that-tracks", from: "that-tracks", from_kind: "service",
    type: "reference", tags: ["that-tracks", deleted ? "withdrawal" : c.entity === "events" ? "tracked-event" : "tracker-configuration"],
    title, date, stream: `that-tracks:${account}`, key: `${c.entity}:${r.id}`, seq: r.revision,
    ...(supersedes ? { supersedes } : {}),
    that_tracks: c,
    ...(text(tracker?.name).trim() ? { tracker_name: text(tracker?.name).trim() } : {}),
  }, lines.join("\n") + "\n");
}

interface Head { revision: number; insertionId: string }
function sourceHeads(root: string, account: string): Map<string, Head> {
  syncAssertionProjection(root);
  const db = openAssertionProjectionReadonly(root);
  try {
    const rows = db.query(`SELECT source_id, insertion_id,
      json_extract(event_json, '$.envelope.seq') AS revision FROM sources
      WHERE source_id LIKE ?`).all(`that-tracks-${account}-%`) as { source_id: string; insertion_id: string; revision: number }[];
    const heads = new Map<string, Head>();
    for (const r of rows) if (Number.isSafeInteger(r.revision) && r.revision > (heads.get(r.source_id)?.revision ?? 0))
      heads.set(r.source_id, { revision: r.revision, insertionId: r.insertion_id });
    return heads;
  } finally { db.close(); }
}

/** Resolve revision links at admission: other revisions may have landed while pending. */
export function receiveStagedTracks(root: string, content: string): Pick<IntakeReceipt, "id" | "insertionId"> {
  const { envelope, body } = parseEnvelope(content);
  const account = typeof envelope.stream === "string" && envelope.stream.startsWith("that-tracks:") ? envelope.stream.slice(12) : "";
  if (!account || typeof envelope.id !== "string" || !Number.isSafeInteger(envelope.seq)) throw new Error("Invalid staged That Tracks revision.");
  const head = sourceHeads(root, account).get(envelope.id);
  if (head && head.revision > Number(envelope.seq)) throw new Error("A newer revision is already admitted; pass this older pending revision.");
  if (head && head.revision === envelope.seq) return { id: envelope.id, insertionId: head.insertionId };
  const { supersedes: _prior, ...meta } = envelope;
  return admit({ root, content: serializeEnvelope({ ...meta, ...(head ? {supersedes:head.insertionId} : {}) }, body) });
}

export async function pollThatTracks(root: string, key: string, options: {
  accountInstance?: string;
  client?: ThatTracksClient;
  land?: (opts: Parameters<typeof land>[0]) => Promise<IntakeReceipt>;
  stage?: (content: string) => Promise<boolean>;
  authorize?: () => void;
  progress?: (state: "checking" | "importing") => void;
  maxPages?: number;
} = {}): Promise<{ arrivals: number; detail?: string }> {
  const client = options.client ?? new ThatTracksClient(key);
  options.authorize?.();
  const me = await client.identity();
  // Key replacement restarts discovery even for the same account. The key
  // itself never enters either the checkpoint or an arrival.
  const grant = sha256hex(JSON.stringify([me.id, key, me.trackerIDs]));
  const instance=options.accountInstance;
  if(instance && !/^account-[a-f0-9]{16}$/.test(instance))throw new Error("Invalid account instance.");
  const checkpointPath = join(root, ".spool", "that-tracks", instance ? `checkpoint-${instance}.json` : "checkpoint.json");
  const raw = readCursorJson(checkpointPath);
  const validContext = (v: unknown): v is Record<string, TracksRecord> => object(v) &&
    Object.values(v).every(r => object(r) && uuid(r.id) && Number.isSafeInteger(r.revision));
  let cp: Checkpoint = raw?.grant === grant && cursor(raw.cursor) && validContext(raw.categories) && validContext(raw.trackers)
    ? raw as unknown as Checkpoint : { grant, cursor: "0", complete: false, categories: {}, trackers: {} };
  let heads: Map<string, Head> | undefined;
  let arrivals = 0;
  // Bound a run so disabling takes effect even during a very large import.
  // The next scheduled run resumes the last durably delivered page.
  for (let pageNumber = 0; pageNumber < (options.maxPages ?? 50); pageNumber++) {
    options.progress?.(cp.complete ? "checking" : "importing");
    options.authorize?.();
    const page = await client.changes(cp.cursor);
    options.authorize?.();
    if (page.items.length) heads ??= sourceHeads(root, me.id);
    for (const change of page.items) {
      const r = change.record;
      // Replaying metadata in cursor order preserves the labels/config that
      // applied to each historical event. Tombstones keep the previous label
      // in context for a readable withdrawal; no current record is invented.
      const content = () => tracksContent(me.id, change, cp, heads?.get(tracksSourceId(me.id, change))?.insertionId);
      const sourceId = tracksSourceId(me.id, change);
      if (r.revision > (heads?.get(sourceId)?.revision ?? 0)) {
        if (options.stage) {
          if (await options.stage(content())) arrivals++;
          heads!.set(sourceId, { revision: r.revision, insertionId: heads?.get(sourceId)?.insertionId ?? "" });
        } else {
          const receipt = await (options.land ?? land)({ root, content: content(), source: "that-tracks" });
          heads!.set(sourceId, { revision: r.revision, insertionId: receipt.insertionId });
          if (!receipt.deduped) arrivals++;
        }
      }
      if (change.entity !== "events") {
        const table = cp[change.entity];
        if (change.operation === "upsert") table[r.id] = r;
        // Keep deleted metadata's last label for following event tombstones.
      }
    }
    cp = { ...cp, cursor: page.nextCursor, complete: !page.hasMore };
    writeAtomic(checkpointPath, JSON.stringify(cp) + "\n", 0o600);
    if (!page.hasMore) return { arrivals };
  }
  return { arrivals, detail: "Importing history; continuing on the next check" };
}
