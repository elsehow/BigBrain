import { workspaceURL, selectedWorkspace } from "./vaultScope";
import { vaultStorageKey, vaultReady, assertVaultCurrent } from "./vaultScope";
import { vaultFetch as fetch } from "./vaultScope";
import type {
  ConfigInfo,
  ConfigPatch,
  ConfigResult,
  DesktopNetwork,
  FoldsView,
  GraphData,
  NoteMeta,
  NoteResult,
  RecentEntry,
  UsageInfo,
  VaultInfo,
  PilotSecret,
  PilotState,
} from "./types";

// The GET endpoints' URL builders, shared by the plain api and the swr
// variants below so a cache key is always the exact URL fetched.
const U = {
  vault: () => "/api/vault",
  folds: () => "/api/entity/folds",
  recent: (limit = 40, offset = 0) => `/api/recent?limit=${limit}&offset=${offset}`,
  notes: (dir: string) => `/api/notes?dir=${encodeURIComponent(dir)}`,
  graph: () => "/api/graph",
  /** `assertions` (projection paths only): ask for just the latest N —
   * web/server.ts answers the truncated view plus its true total. */
  note: (path: string, assertions?: number) =>
    `/api/note?path=${encodeURIComponent(path)}${assertions ? `&assertions=${assertions}` : ""}`,
};

// ── stale-while-revalidate cache ────────────────────────────────────────────
// Views re-fetch on every live ping (app.rev) AND on every view switch — and
// the switch's round-trip is what made tab changes feel slow. Every GET
// lands in this cache (memory first, sessionStorage across reloads); swrGet
// hands a view whatever the last fetch returned so it paints instantly,
// while the fresh fetch updates it the moment it lands. The live ping stays
// the invalidation signal — the cache never suppresses a fetch, it only
// fills the gap while one is in flight.
const mem = new Map<string, unknown>();
const cachePrefix = () => vaultStorageKey("cache:");
function cachedOf<T>(url: string): T | undefined {
  if (selectedWorkspace || !vaultReady()) return undefined;
  if (mem.has(url)) return mem.get(url) as T;
  try {
    const raw = sessionStorage.getItem(cachePrefix() + url);
    if (raw != null) {
      const v = JSON.parse(raw) as T;
      mem.set(url, v);
      return v;
    }
  } catch {
    /* sessionStorage unavailable — the memory tier still works */
  }
  return undefined;
}

/** A JSON write: the engine's `{error}` on a refusal is the message. */
async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text().catch(() => "");
  let j: { error?: string } = {};
  try {
    j = JSON.parse(text) as { error?: string };
  } catch {
    /* non-JSON — surface the status */
  }
  if (!r.ok) throw new Error(j.error ?? `${url} → ${r.status}`);
  return j as T;
}

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, signal ? { signal } : undefined);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  const data = (await r.json()) as T;
  assertVaultCurrent();
  mem.set(url, data);
  try {
    if (!selectedWorkspace) sessionStorage.setItem(cachePrefix() + url, JSON.stringify(data));
  } catch {
    /* quota — memory holds it */
  }
  return data;
}

/** Drop response caches for this vault, preserving drafts and delivery IDs. */
export function clearSwrCache(): void {
  mem.clear();
  try {
    const prefix = cachePrefix();
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(prefix)) sessionStorage.removeItem(key);
    }
  } catch {
    /* unavailable — the memory tier was the real one */
  }
}

export interface Swr<T> {
  /** The last fetched value for this exact URL, if any — paint with it now. */
  cached: T | undefined;
  /** The in-flight revalidation — apply it when it lands. */
  fresh: Promise<T>;
}
export interface RecentPage {
  recent: RecentEntry[];
  nextOffset: number | null;
  total?: number;
}
const swrGet = <T>(url: string): Swr<T> => ({ cached: cachedOf<T>(url), fresh: get<T>(url) });

/** Cache-first variants of the hot read endpoints. */
export const swr = {
  vault: () => swrGet<VaultInfo>(U.vault()),
  recent: (limit = 40, offset = 0) => swrGet<RecentPage>(U.recent(limit, offset)),
  notes: (dir: string) => swrGet<{ dir: string; notes: NoteMeta[] }>(U.notes(dir)),
  graph: () => swrGet<GraphData>(U.graph()),
  note: (path: string, assertions?: number) => swrGet<NoteResult>(U.note(path, assertions)),
  /** the memory pass's fold proposals (#728) — home's triage block */
  folds: () => swrGet<FoldsView>(U.folds()),
};

// ── drop bodies without giant strings ───────────────────────────────────────
// The /api/drop wire shape is JSON with base64 attachments, but nothing
// forces the CLIENT to hold that JSON as one string. Encoding happens per
// slice — each a multiple of 3 bytes, so every part's base64 ends on a
// character boundary with no mid-stream padding and the parts concatenate
// into one valid encoding.
export interface DropAttachment {
  name: string;
  file: Blob;
}

const B64_SLICE = 3 * 512 * 1024; // 1.5MB of file → 2MB of base64 per part

async function b64PartsOf(file: Blob, onSlice?: (bytes: number) => void): Promise<string[]> {
  const parts: string[] = [];
  for (let off = 0; off < file.size; off += B64_SLICE) {
    const bytes = new Uint8Array(await file.slice(off, off + B64_SLICE).arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    parts.push(btoa(bin));
    onSlice?.(bytes.length);
  }
  return parts;
}

/** The request body as a Blob: JSON.stringify shapes the small pieces, and
 * the base64 parts are spliced RAW between quotes — the base64 alphabet
 * (A–Z a–z 0–9 + / =) contains nothing JSON needs escaped. Exported for the
 * same reason the stream backoff is: the XHR around it is untestable here, the
 * encoding is not (test/dropBody.test.ts).
 *
 * `onEncode` reports FILE bytes encoded so far against the total across all
 * attachments — the encode leg is seconds of dead air on a big recording,
 * and dead air on top of a minutes-long upload reads as a hang. */
export async function dropBody(
  name: string,
  content: string,
  attachments?: DropAttachment[],
  onEncode?: (done: number, total: number) => void
): Promise<Blob> {
  const head = JSON.stringify({ name, content });
  if (!attachments?.length) return new Blob([head], { type: "application/json" });
  const grand = attachments.reduce((n, a) => n + a.file.size, 0);
  let done = 0;
  const tally =
    onEncode &&
    ((bytes: number) => {
      done += bytes;
      onEncode(done, grand);
    });
  const pieces: string[] = [head.slice(0, -1), ',"attachments":['];
  for (const [i, a] of attachments.entries()) {
    pieces.push(
      `${i ? "," : ""}{"name":${JSON.stringify(a.name)},"b64":"`,
      ...(await b64PartsOf(a.file, tally)),
      '"}'
    );
  }
  pieces.push("]}");
  return new Blob(pieces, { type: "application/json" });
}

export const api = {
  vault: () => get<VaultInfo>(U.vault()),
  cachedRecent: (limit = 40, offset = 0) => cachedOf<RecentPage>(U.recent(limit, offset)),
  recent: (limit = 40, offset = 0, signal?: AbortSignal) => get<RecentPage>(U.recent(limit, offset), signal),
  notes: (dir: string) => get<{ dir: string; notes: NoteMeta[] }>(U.notes(dir)),
  note: (path: string, assertions?: number) => get<NoteResult>(U.note(path, assertions)),
  search: (q: string, limit = 100, signal?: AbortSignal, source = "") =>
    get<{ query: string; hits: { dir: string; note: NoteMeta; title: string; snippet: string }[] }>(
      `/api/search?q=${encodeURIComponent(q)}&limit=${limit}&source=${encodeURIComponent(source)}`,
      signal
    ),
  searchPage: (q: string, offset: number, limit: number, signal?: AbortSignal, mention = false) =>
    get<{ hits: import("./omnibox.svelte").SearchHit[]; nextOffset: number | null }>(
      `/api/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}${mention ? "&purpose=mention" : ""}`, signal),
  graph: () => get<GraphData>(U.graph()),
  /** The v2 view's who and what (lib/v2Feed.ts): agents and the latest assertions. */
  v2: () => get<import("./v2/model").V2Feed>("/api/v2"),
  /** The sorted feed (lib/feedStage.ts); empty when the vault has no feed. */
  v2Sorted: () => get<{ rows: import("../../../../lib/v2Feed").V2SortedRow[] }>("/api/v2/sorted"),
  /** One entity's latest assertions, dated by when each claim was first recorded. */
  v2Entity: (id: string) => get<{ rows: import("./v2/model").V2FeedRow[] }>(`/api/v2/entity?id=${encodeURIComponent(id)}`),
  folds: () => get<FoldsView>(U.folds()),
  /** ACCEPT a fold: every member's label becomes an alias of the canonical. */
  acceptFold: (canonical: string, members: string[]) =>
    post<{ canonical: { id: string; label: string }; aliased: { id: string; label: string }[] }>("/api/entity/folds/accept", { canonical, members }),
  /** REJECT: `member` is not the same thing as any of `others` — remembered. */
  rejectFold: (member: string, others: string[]) =>
    post<{ member: { id: string; label: string }; against: { id: string; label: string }[] }>("/api/entity/folds/reject", { member, others }),
  /** OPEN a source's origin on this machine — the desktop door for a file
   * origin (lib/sourceOpen.ts); a URL origin the viewer opens itself. */
  /** A person's word on two sources: one document, or not (lib/sourceCopyReview.ts). */
  sourceCopies: (a: string, b: string, same: boolean) => post<unknown>("/api/source/copies", { a, b, same }),
  openSource: (path: string, sha256?: string) => post<{ ok: true; opened: string }>("/api/source/open", { path, ...(sha256 ? { sha256 } : {}) }),
  config: () => get<ConfigInfo>("/api/config"),
  /** The pilot (#770, lib/pilot.ts): is a key set; save one ("" removes);
   * mint one session's client secret; run one tool call (a 400 is the
   * door's refusal, thrown with its words — the page hands them back to the
   * model); post one transcript turn; end the conversation (keepalive on
   * pagehide, so the settle request outlives the page). */
  pilot: () => get<PilotState>("/api/pilot"),
  pilotPermissions: (permissions: import("../../../../lib/workPermissions").WorkPermissions) => post<PilotState>("/api/pilot/permissions", permissions),
  pilotEnabled: (enabled: boolean) => post<PilotState>("/api/pilot/enabled", { enabled }),
  /** Where coding desktops' commands may reach beyond this machine (lib/desktopNetwork.ts): the defaults, and the person's additions. */
  desktopNetwork: () => get<DesktopNetwork>("/api/desktops/network"),
  saveDesktopNetwork: (hosts: string[]) => post<DesktopNetwork>("/api/desktops/network", { hosts }),
  pilotKey: (key: string) => post<PilotState>("/api/pilot/key", { key }),
  pilotSecret: () => post<PilotSecret>("/api/pilot/secret", {}),
  pilotTurn: (conversation: string, turn: { id?: string; speaker: "user" | "pilot"; text: string; at: string; tools?: string[] }) =>
    post<{ turns: number }>("/api/pilot/turn", { conversation, ...turn }),
  pilotEnd: (conversation: string, keepalive = false): Promise<void> =>
    fetch("/api/pilot/end", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversation }),
      keepalive,
    }).then(() => undefined),
  /** Reported role tokens and separate provider account readings. */
  usage: () => get<UsageInfo>("/api/usage"),
  /** Land one item. `id` is the reference id it landed under — what a follow-up
   * directive names in its refs (issue #50). Absent when the engine is too
   * old to report it.
   *
   * Attachments arrive as Blobs, not strings — the wire format is still
   * `{name, b64}` JSON, but the base64 is produced in slices and the body
   * assembled as a Blob (dropBody). A ~500MB screen recording encoded into
   * ONE string died in the browser with "allocation size overflow" before
   * the request ever left: btoa over the whole binary, then JSON.stringify
   * copying it again. Blob parts never become one contiguous string, and
   * the engine may even page them to disk.
   *
   * XHR rather than fetch, for one reason: `upload.onprogress` — fetch
   * still has no upload progress. `onProgress` reports two legs, each
   * 0→total in its own unit: "encode" (file bytes sliced into base64 —
   * seconds of otherwise-dead air on a big recording) then "upload"
   * (request bytes on the wire; the browser→server leg only — the landing
   * itself is invisible from here). */
  drop: async (
    name: string,
    content: string,
    attachments?: DropAttachment[],
    onProgress?: (leg: "encode" | "upload", done: number, total: number) => void
  ): Promise<{ path: string; via: string; id?: string; ref_path?: string; queued?: boolean }> => {
    const body = await dropBody(
      name,
      content,
      attachments,
      onProgress && ((done, total) => onProgress("encode", done, total))
    );
    const { status, text } = await new Promise<{ status: number; text: string }>(
      (resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", workspaceURL("/api/drop"));
        xhr.setRequestHeader("content-type", "application/json");
        if (onProgress)
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onProgress("upload", e.loaded, e.total);
          };
        xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
        xhr.onerror = () => reject(new Error("network error — the drop never reached the host"));
        xhr.send(body);
      }
    );
    let j: { path?: string; via?: string; id?: string; ref_path?: string; queued?: boolean; error?: string } = {};
    try {
      j = JSON.parse(text);
    } catch {
      /* non-JSON (e.g. a pre-route server's "not found") — surface the raw body */
    }
    if (status < 200 || status >= 300)
      throw new Error(j.error ?? `${status}: ${text.slice(0, 120) || "drop failed"}`);
    // `ref_path` is the landed insertion event's own vault path — the note
    // the picture opens on the arrival (DropZone, 2026-09-06). A queued drop
    // (202) has none yet: it waits for the firewall, and its id is the
    // arrival's, not a reference's.
    if (j.queued) return { path: "", via: j.via ?? "", queued: true };
    return { path: j.path ?? "", via: j.via ?? "", ...(j.id ? { id: j.id } : {}), ...(j.ref_path ? { ref_path: j.ref_path } : {}) };
  },
  /** Enqueue a DIRECTIVE — prose about refs, addressed to the editor. This
   * is where a note typed beside a drop goes: it is a work order, not a
   * record of the world, so it belongs in the queue and never in
   * references/. The server stamps the principal from the verified
   * identity; the body never claims one. */
  enqueue: async (draft: { refs?: string[]; guidance?: string }): Promise<{
    path: string;
    via: string;
  }> => {
    const r = await fetch("/api/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
    const text = await r.text().catch(() => "");
    let j: { path?: string; via?: string; error?: string } = {};
    try {
      j = JSON.parse(text);
    } catch {
      /* non-JSON — surface the raw body */
    }
    if (!r.ok) throw new Error(j.error ?? `${r.status}: ${text.slice(0, 120) || r.statusText}`);
    return { path: j.path ?? "", via: j.via ?? "" };
  },
  saveConfig: async (patch: ConfigPatch): Promise<ConfigResult> => {
    const r = await fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
    const j = (await r.json().catch(() => ({}))) as ConfigResult & { error?: string };
    if (!r.ok) throw new Error(j.error ?? `save failed (${r.status})`);
    return j;
  },
};
