/**
 * api.ts — the authenticated HTTP intake handler. bin/api.ts serves it;
 * tests call it directly with `new Request(...)` — the handler is a pure
 * (Request) => Response function over injected deps, no sockets involved.
 *
 * Surface (everything else 404):
 *   POST   /v1/pair              unauthed: {code, client} → a browser's own token, once (#486, lib/pair.ts)
 *   GET    /v1/whoami            any valid token → {id, name, scopes}
 *   POST   /v1/drop?name          Bearer + inbox:write → stamp provenance → land
 *   POST   /v1/session           Bearer + inbox:write → retired capture receipt; no ingestion.
 *   POST   /v1/enqueue           Bearer + inbox:write → typed queue message
 *   POST   /v1/observe           Bearer + inbox:write → the memory pass's demand spool
 *   GET    /v1/status            Bearer + vault:read → queue depth + the newest run
 *   GET    /v1/note?path=…       Bearer + vault:read → one note: frontmatter parsed, links resolved
 *                                [&q= windows any note; &slack= &after= &before= &n= &order= &toc=1] (#618)
 *   GET    /v1/search?q&n=20     Bearer + vault:read → ranked query-surface hits (#86)
 *                                [&after=YYYY-MM-DD &before= &type=reference|entity] (#349)
 *   GET    /v1/memory?path=…     Bearer + vault:read → memory/MEMORY.md, or one topic file, raw (#105)
 *   GET    /v1/gardener/next     Bearer + tend → due work + context packs (#479; a pure read — no lease)
 *   POST   /v1/gardener/submit   Bearer + tend → host-validated events, per-item and idempotent (#479)
 *                                (each success stamps journal/tend/door.json — the door's last-run trace, #482)
 *
 * The surface above is ONE TABLE (`AUTHED_ROUTES` + `PUBLIC_ROUTES`, below) —
 * a route exists exactly once, as one `{method, path, scope, handler}` entry.
 * Dispatch walks the table to decide whether a path is known (→ auth
 * required), which entry matches (→ 404 on method mismatch), and applies
 * that entry's scope gate and rate limit before calling its handler — no
 * second list to fall out of sync with the first (#264).
 *
 * Auth answers are deliberately blunt: every failure on the wire is an
 * undifferentiated 401 (store missing, unknown id, bad secret, revoked —
 * an attacker learns nothing); the discriminating reason goes to the
 * server log, keyed by token id, never the token itself. 403 names the
 * missing scope — scope names aren't secret and the caller holds a valid
 * token, so being specific is kind.
 *
 * The API binds
 * localhost and tattles when it sees a plaintext-forwarded request.
 */

import { parseNoteWindow, NoteWindowError, type NoteWindow } from "./noteWindow";
import { intakeWireReceipt } from "./intakeWire";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hasScope, touchLastUsed, verifyToken, type TokenRecord } from "./auth";
import { ensureDir, writeAtomic } from "./fsx";
import { dropErrorStatus, FirewallUnavailable } from "./door";
import { IntakeError } from "./intake";
import { landDirective, landDrop } from "./landItem";
import { jailMemoryPath, noteMarkdownText, notePayload } from "./noteRead";
import { memoryForAgents, noteForAgent, rowsForAgent } from "./agentReads";
import { TEND_JOURNAL_DIR, tendJournalFiles } from "./tend";
import { journalFiles, readQueueJournalFile, type QueueJournalRecord } from "./run/journal";
import { landVoice, VoiceError } from "./voice";
import { recordUse } from "./retrieval";
import { clampLimit, scanSurface } from "./searchCore";
import { nextWork, submitWire, WORK_KINDS, type SubmitResult, type WorkItem, type WorkKind, dueIntakeCount } from "./work";
import { claudeAccount, ownerFor } from "./firstRun";
import { normalizeClient, redeemPairCode } from "./pair";

export interface ApiDeps {
  root: string;
  storePath: string;
  now?: () => Date;
  log?: (line: string) => void;
  /** Whose name a paired browser's credential carries — the person this
   * machine's Claude Code is signed in as, else the vault's git identity
   * (lib/firstRun.ts ownerFor). Tests inject. */
  pairOwner?: () => string;
}

const CORS = {
  // `*` is safe here: auth is a bearer header, never a cookie, so CORS
  // exposes no ambient authority — it just lets the extension (and any
  // future web client) present its capability from any origin.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
  // Chrome's private-network preflight: a page or extension on a public
  // origin reaching 127.0.0.1 must be let in by name, or the preflight
  // fails before the request is ever made. Same reasoning as `*` above —
  // the bearer header is the whole authority.
  "Access-Control-Allow-Private-Network": "true",
};

// In-memory token bucket per token id: 30 requests/minute. Enough for any
// legitimate drop cadence; caps a runaway extension loop and the disk-fill
// a leaked token could attempt through uniquePath. Resets on restart and
// is deliberately not persisted — v1's threats don't survive a restart
// either, and real accounting belongs to a future gateway.
const RATE_CAPACITY = 30;
const RATE_REFILL_PER_MS = 30 / 60_000;

/** The whole-request transport cap, set on `Bun.serve` (bin/api.ts) as an
 * explicit DoS guard AND enforced here on the drop body so it is testable
 * without a socket. */
export const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

/** The newest queue run's headline fields for `/v1/status.last_run` — runIds
 * are ISO-ish and sort lexically, so the last name is the newest. */
/** The newest RUN across the tend journal (sharded `journal/tend/<YYYY-MM>/`)
 * and the frozen editor-era ledger (`journal/queue/`, flat — stage pre-pass
 * records skipped by content). One shape out, whichever era ran last. */
export function newestRun(root: string): {
  run: string;
  startedAt?: string;
  wallMs?: number;
  outcomes?: string[];
  model?: string;
} | null {
  type Candidate = { startedAt: string; out: NonNullable<ReturnType<typeof newestRun>> };
  const candidates: Candidate[] = [];
  for (const { runId, path } of journalFiles(join(root, "journal", "queue")).reverse()) {
    const rec = readQueueJournalFile(path)?.record;
    if (!rec || rec.stage) continue;
    candidates.push({
      startedAt: rec.startedAt ?? "",
      out: {
        run: rec.run ?? runId,
        ...(rec.startedAt ? { startedAt: rec.startedAt } : {}),
        ...(rec.wallMs !== undefined ? { wallMs: rec.wallMs } : {}),
        ...(rec.outcomes ? { outcomes: rec.outcomes } : {}),
        ...(rec.model ? { model: rec.model } : {}),
      },
    });
    break;
  }
  for (const { runId, path } of tendJournalFiles(root)) {
    const rec = readQueueJournalFile(path)?.record as
      | (QueueJournalRecord & {
          invocation_id?: string;
          started_at?: string;
          wall_ms?: number;
        })
      | undefined;
    if (!rec) continue;
    candidates.push({
      startedAt: rec.started_at ?? "",
      out: {
        run: rec.invocation_id ?? runId,
        ...(rec.started_at ? { startedAt: rec.started_at } : {}),
        ...(rec.wall_ms !== undefined ? { wallMs: rec.wall_ms } : {}),
        ...(rec.model ? { model: rec.model } : {}),
      },
    });
    break;
  }
  // The door's own trace (#482): a thin tender never writes a run journal —
  // its only server-side footprint is the submit, which stamps this one file.
  try {
    const rec = JSON.parse(
      readFileSync(join(root, TEND_JOURNAL_DIR, "door.json"), "utf8")
    ) as { at?: string };
    if (rec?.at) candidates.push({ startedAt: rec.at, out: { run: "door", startedAt: rec.at } });
  } catch {
    /* no door activity */
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return candidates[0]!.out;
}

// ── the product shell's read surface (#42): one note ───────────────────────
interface Bucket {
  tokens: number;
  last: number;
}

type Json = (status: number, body: unknown, headers?: Record<string, string>) => Response;

const json: Json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...headers },
  });

const unauthorized = () => json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });

/** Everything an unauthenticated handler (just `/v1/pair`) can touch. */
interface PublicCtx {
  req: Request;
  url: URL;
  json: Json;
  root: string;
  storePath: string;
  now: () => Date;
  /** Whose name a credential minted here carries (the pair route). */
  owner: () => string;
}

/** Everything an authed handler can touch — the request, the verified
 * token, this door's shared helpers, and the setters that feed the one
 * `respond()` log line (bytes shipped, where an item landed). Auth, rate
 * limiting and the scope gate have already run by the time a handler sees
 * this: it only does the route's own work. */
interface RouteCtx {
  req: Request;
  url: URL;
  root: string;
  now: () => Date;
  log: (line: string) => void;
  json: Json;
  record: TokenRecord;
  /** Captured path segments — only `hash` on the two `/v1/blob/:hash` routes. */
  params: Record<string, string>;
  setBytes: (n: number) => void;
  setLanded: (rel: string) => void;
}

interface PublicRoute {
  method: string;
  path: string;
  auth: false;
  handler: (ctx: PublicCtx) => Response | Promise<Response>;
}

interface AuthedRoute {
  method: string;
  path: string;
  /** hasScope gate, applied once at dispatch before the handler runs.
   * Absent means "any valid token" (whoami) or "the handler gates itself"
   * (DELETE /v1/blob/:hash, which checks token KIND, not a scope). An
   * array is ANY-of, not all-of — GET /v1/blob/:hash's only user (#69's
   * hostHasBlob) below. */
  scope?: string | string[];
  /** 30 req/min per token, applied once at dispatch, before the handler
   * runs — every route that writes or spends disk. */
  rateLimited?: boolean;
  /** `false` on /v1/whoami alone. Every other route stamps `last_used`
   * once at dispatch (#639: it was a hand-written `touch()` in ten
   * handlers, placed differently in each — first thing in one, after the
   * 404 in the next — so the field meant something different per route).
   * whoami is the validity PROBE: `bigbrain connect` calls it the instant
   * a token is minted, and counting that would make a credential that has
   * never done anything read as used on the agents card. */
  touch?: false;
  handler: (ctx: RouteCtx) => Response | Promise<Response>;
}

/** Matches a table path against a request path. A trailing `/:name`
 * segment captures everything after the prefix — mirroring the historic
 * `/^\/v1\/blob\/(.+)$/`, the only dynamic segment on this surface, so a
 * captured value may itself contain slashes (the handler, not the router,
 * decides whether that's well-formed). Returns null on no match. */
function matchPath(routePath: string, actualPath: string): Record<string, string> | null {
  const paramAt = routePath.indexOf("/:");
  if (paramAt === -1) return routePath === actualPath ? {} : null;
  const prefix = routePath.slice(0, paramAt);
  const name = routePath.slice(paramAt + 2);
  if (!actualPath.startsWith(`${prefix}/`) || actualPath.length <= prefix.length + 1) return null;
  return { [name]: actualPath.slice(prefix.length + 1) };
}

// ── handlers ──────────────────────────────────────────────────────────────

/** A JSON OBJECT request body, or the 400 that says which way it was
 * wrong. Four routes wrote this out, and the two that skipped the object
 * check went on to read a key off `null` (#639): `/v1/pair` THREW — an
 * unauthed route, from a two-byte body, and a throw never reaches
 * respond(), so it left no access-log line either — and
 * `/v1/gardener/submit` answered 400 with the interpreter's own words
 * ("null is not an object (evaluating 'body.items')"). `message`
 * overrides both refusals for the door that names the shape it wants. */
async function jsonObjectBody<T>(
  req: Request,
  json: Json,
  opts: { setBytes?: (n: number) => void; message?: string } = {}
): Promise<T | Response> {
  const raw = await req.text();
  opts.setBytes?.(Buffer.byteLength(raw));
  let draft: unknown;
  try {
    draft = JSON.parse(raw);
  } catch {
    return json(400, { error: opts.message ?? "bad JSON body" });
  }
  if (typeof draft !== "object" || draft === null || Array.isArray(draft))
    return json(400, { error: opts.message ?? "body must be a JSON object" });
  return draft as T;
}

/** Who is asking, derived from the TOKEN and never from the request body
 * (the agent-interop from/via rules). An agent token's principal is its
 * name; a person-device token's is its owner; a legacy (no-kind) token
 * falls back to its name. `fromKind` is "person" only for a person-device
 * token with a verified owner — it gates guidance-vs-data rendering
 * downstream — and is absent rather than guessed otherwise; a body that
 * claims one is ignored outright.
 *
 * `/v1/drop`'s stamp derives a DIFFERENT thing from the same record and
 * keeps its own spelling: it stamps nothing at all when there is no agent
 * name and no owner, where this always yields a `from`. */
function principalOf(record: TokenRecord): { from: string; via: string; fromKind?: "agent" | "person" } {
  return {
    from: record.kind === "agent" ? record.name : (record.owner ?? record.name),
    via: record.name,
    ...(record.kind === "agent"
      ? { fromKind: "agent" as const }
      : record.kind === "person-device" && record.owner
        ? { fromKind: "person" as const }
        : {}),
  };
}

/** The extension's half of pairing (lib/pair.ts): the code the app showed,
 * once, for this browser's own credential. Unauthenticated by nature — it
 * is how a client gets a token — so a miss answers slowly and says nothing
 * about why. `client` is what the browser calls itself; the engine names
 * the token. */
async function pairHandler({ req, json, root, storePath, now, owner }: PublicCtx): Promise<Response> {
  const body = await jsonObjectBody<{ code?: unknown; client?: unknown }>(req, json, {
    message: "expected a JSON body {code, client}",
  });
  if (body instanceof Response) return body;
  if (typeof body.code !== "string" || !body.code.trim()) return json(400, { error: "code is required" });
  const r = redeemPairCode(root, body.code, normalizeClient(body.client), {
    owner: owner(),
    storePath,
    now: now(),
  });
  if (!r) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return json(403, { error: "that code is not valid — mint a fresh one in the app" });
  }
  return json(200, { token: r.token, id: r.record.id, name: r.record.name, owner: r.record.owner ?? null });
}

function whoamiHandler({ record, json }: RouteCtx): Response {
  return json(200, {
    id: record.id,
    name: record.name,
    owner: record.owner ?? null,
    kind: record.kind ?? null,
    scopes: record.scopes,
  });
}

// Read-back (§5): the hosted success loop's "watch it get tended" poll +
// the path-jailed reads of the committed record. All under vault:read.
// #498: the stored queue retired — `due` is the work-view count (the same
// number the viewer's "waiting for your agent" shows, lib/work.ts), and
// last_run reads the tend journal beside the frozen editor-era ledger.
function statusHandler({ root, json }: RouteCtx): Response {
  return json(200, {
    due: { intake: dueIntakeCount(root) },
    last_run: newestRun(root),
  });
}

/** A YYYY-MM-DD query parameter, or the 400 that says what WOULD work —
 * the caller is an agent that can immediately retry a corrected request. */
function dayParam(url: URL, name: string, json: Json): string | Response {
  const v = (url.searchParams.get(name) ?? "").trim();
  if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v))
    return json(400, { error: `bad ${name} "${v}" — use YYYY-MM-DD, e.g. ${name}=2026-08-01` });
  return v;
}

/** A flag query parameter: present and not an explicit off. Deliberately
 * lenient — `toc`, `toc=1`, `toc=true` all mean the same thing to an agent
 * writing the URL by hand, and there is no wrong answer to 400 over. */
function boolParam(url: URL, name: string): boolean {
  const v = url.searchParams.get(name);
  return v !== null && !["0", "false", "no"].includes(v.trim().toLowerCase());
}

// One note, render-ready: frontmatter parsed off, wikilinks resolved.
function noteHandler({ root, url, now, json, record, setBytes }: RouteCtx): Response {
  let window: NoteWindow;
  try { window = parseNoteWindow({ ...Object.fromEntries([...url.searchParams.keys()].map(key => [key, url.searchParams.get(key)])), toc: boolParam(url, "toc") }); }
  catch (error) {
    if (error instanceof NoteWindowError) return json(400, { error: error.message });
    throw error;
  }
  const format = (url.searchParams.get("format") ?? "").trim();
  if (format && format !== "json" && format !== "markdown")
    return json(400, { error: `bad format "${format}" — use format=json or format=markdown` });
  const p = notePayload(root, url.searchParams.get("path") ?? "", window);
  if (p.status !== 200) return json(p.status, { error: p.error });
  // Most note fetches follow a wikilink rather than a search; the
  // offline join drops the ones that attribute to nothing.
  const via = gardenerVia(url, record);
  recordUse(root, p.rel, via, now());
  // An agent reads it as local MCP does: provenance beside it, outside text
  // screened and fenced (lib/agentReads.ts). The gardener reads raw.
  const note = via === "gardener" ? p.note : noteForAgent(root, p.rel, p.note, n => n, now().getTime());
  if (format === "markdown") {
    // The same note as text with its newlines intact — the plugin saves this
    // beside a big note's JSON so a line-addressed reader can slice it.
    const buf = Buffer.from(noteMarkdownText(note), "utf8");
    setBytes(buf.byteLength);
    return new Response(buf, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8", ...CORS },
    });
  }
  return json(200, note);
}

// The product's shared query surface (lib/searchCore.ts): sources,
// assertions, linked entities and current memory, with openable paths. The viewer's
// omnibox calls the same primitive; this door only owns auth, parameters and
// its empty-query response.
function searchHandler({ root, url, now, json, log, record }: RouteCtx): Response {
  // THIS DOOR's empty-query policy (the per-door half of #259's
  // decision): a missing q is a malformed request, not a search that
  // found nothing — 400, like this file's other bad-parameter
  // answers, so a thin client can tell the two apart. A q that
  // survives sanitizing as no TERMS (pure punctuation) is still a
  // real query: 200, empty.
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return json(400, { error: "missing q" });
  const n = clampLimit(url.searchParams.get("n"), 20);
  // Filters (#349): validated here — the door owns its 400s — then applied
  // verbatim by the shared scan (lib/searchCore.ts). Errors say what WOULD
  // work: the caller is an agent that can immediately retry a corrected
  // request.
  const after = dayParam(url, "after", json);
  if (after instanceof Response) return after;
  const before = dayParam(url, "before", json);
  if (before instanceof Response) return before;
  const type = (url.searchParams.get("type") ?? "").trim();
  if (type && type !== "reference" && type !== "entity")
    return json(400, { error: `bad type "${type}" — use type=reference or type=entity` });
  const via = gardenerVia(url, record);
  const r = scanSurface(root, q, n, via, {
    now: now(),
    filters: {
      ...(url.searchParams.get("source")?.trim() && { source: url.searchParams.get("source")!.trim().toLowerCase() }),
      ...(after && { after }),
      ...(before && { before }),
      ...(type && { type: type as "reference" | "entity" }),
    },
  });
  if (!r.ok) {
    if (r.invalid_query) return json(400, { error: r.reason });
    // The projection is a rebuildable cache — its loss is the server's
    // fault, never the caller's, and never the process's: answer 500
    // in this file's JSON shape instead of letting a throw reach
    // Bun.serve.
    log(
      JSON.stringify({
        ts: now().toISOString(),
        warn: "search index unavailable",
        path: url.pathname,
        reason: r.reason,
      })
    );
    return json(500, { error: "search unavailable" });
  }
  // `relaxation` rides only when it fired: an agent seeing it knows these
  // hits came from the any-term rung, not the exact query (#361).
  // An agent's hits wear their provenance, as over local MCP (lib/agentReads.ts).
  const hits = via === "gardener" ? r.hits : rowsForAgent(root, r.hits, now().getTime());
  return json(200, { hits, ...(r.relaxation ? { relaxation: r.relaxation } : {}),
    applied_filters: r.applied_filters, only_agent_records: r.only_agent_records });
}

// The memory tree (#105): the index, or one topic file, as written, save
// that a claim drawn from outside arrives fenced with its source
// (lib/memoryProvenance.ts). Raw markdown on purpose — links are NOT
// resolved the way /v1/note resolves them, because the consumer is an
// agent that follows each `[[memory/slug]]` back here with `?path=slug`
// and each record link through /v1/note.
//
// No recordUse here, deliberately (#359): this door's traffic is
// dominated by session-start machinery auto-fetching the working set —
// machine reads, not knowledge demand (lib/retrieval.ts header, rule 3).
// The asymmetry with the web viewer, which DOES record its memory reads,
// is intentional: there the read is a person clicking. The tree is bounded (lib/memoryRun.ts: 9 files,
// ~3,300 words), so there is nothing to paginate.
function memoryHandler({ root, url, json, setBytes, record }: RouteCtx): Response {
  const slug = url.searchParams.get("path") ?? "";
  const abs = jailMemoryPath(root, slug ? `${slug}.md` : "MEMORY.md");
  if (!abs) return json(403, { error: "forbidden path" });
  try {
    if (!statSync(abs).isFile()) return json(404, { error: "not a file" });
    const raw = readFileSync(abs, "utf8");
    const buf = Buffer.from(gardenerVia(url, record) === "gardener" ? raw : memoryForAgents(raw), "utf8");
    setBytes(buf.byteLength);
    return new Response(buf, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8", ...CORS },
    });
  } catch {
    return json(404, { error: "not found" });
  }
}

async function dropHandler({
  req,
  url,
  root,
  record,
  now,
  json,
  setBytes,
  setLanded,
}: RouteCtx): Promise<Response> {
  // Two wire shapes: raw markdown (the original contract), or JSON
  // { content, attachments: [{name, b64}] } when binaries ride along.
  // No request-size gate (2026-08-06): attachments are unbounded by
  // design (the CAS is add-only disk, not git history); the item
  // TEXT is still capped — receive() enforces MAX_BYTES on it and
  // this route surfaces that as 413.
  const raw = await req.text();
  const bytes = Buffer.byteLength(raw);
  setBytes(bytes);
  // whole-request cap (§5): the inline drop body — text plus any b64
  // attachments — is bounded.
  if (bytes > MAX_REQUEST_BYTES)
    return json(413, { error: `request exceeds ${MAX_REQUEST_BYTES} bytes` });
  let content = raw;
  let attachments: { name: string; b64: string }[] | undefined;
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const j = JSON.parse(raw) as {
        content?: string;
        attachments?: { name: string; b64: string }[];
      };
      content = j.content ?? "";
      attachments = Array.isArray(j.attachments) ? j.attachments : undefined;
    } catch {
      return json(400, { error: "bad JSON body" });
    }
  }
  if (!content.trim()) return json(400, { error: "empty item" });

  let receipt;
  try {
    // The one stamp → land → read-back path (lib/landItem.ts). The
    // credential's principal: an agent token IS its agent; a
    // person-device token speaks for its owner. Legacy tokens
    // (no owner) stamp no principal — the item still lands.
    receipt = await landDrop({
      root,
      content,
      stamp: {
        tokenId: record.id,
        tokenName: record.name,
        ...(record.kind === "agent"
          ? { from: record.name, fromKind: "agent" as const }
          : record.owner
            ? { from: record.owner, fromKind: "person" as const }
            : {}),
        now: now(),
      },
      attachments,
    });
  } catch (e) {
    if (e instanceof IntakeError || e instanceof FirewallUnavailable) return json(dropErrorStatus(e), { error: e.message });
    throw e;
  }

  setLanded(receipt.path);
  return json(200, intakeWireReceipt(receipt, url.searchParams.get("name") ?? undefined));
}

/** Compatibility receipt for old plugins. Never parse or land their transcripts.
 * A success lets installed uploaders advance their cursor instead of retrying. */
async function sessionHandler({ json }: RouteCtx): Promise<Response> {
  return json(200, { skipped: "External chat capture has been retired" });
}

// The DIRECTIVE door (#521 — voice as arrivals): the wire shape the
// clients always sent ({refs, guidance}) now lands an immutable voice
// insertion (lib/voice.ts), refs canonicalized into `about`. Identity
// still stamps from the TOKEN, never from body claims.
async function enqueueHandler({
  req,
  root,
  record,
  json,
  setBytes,
  setLanded,
}: RouteCtx): Promise<Response> {
  const draft = await jsonObjectBody<{
    refs?: unknown;
    guidance?: unknown;
    verb?: unknown;
    params?: unknown;
  }>(req, json, { setBytes });
  if (draft instanceof Response) return draft;
  const { from, via, fromKind } = principalOf(record);

  // legacy body shape (one release): a free-text param carried what
  // guidance carries now; a verb key is ignored outright
  let guidance = typeof draft.guidance === "string" ? draft.guidance : undefined;
  if (!guidance && typeof draft.params === "object" && draft.params !== null)
    for (const k of ["scope", "focus", "action"]) {
      const v = (draft.params as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) guidance = v;
    }

  try {
    // Land → commit (#67: in the lake the moment the door accepts it —
    // a directive is a mind's words, and nothing else can regenerate
    // them), one path (lib/landItem.ts → lib/voice.ts). The id returned
    // is the insertion event's — what settles it when cited.
    const r = landDirective(
      root,
      {
        refs: (draft.refs as string[] | undefined) ?? [],
        ...(guidance !== undefined ? { guidance } : {}),
      },
      {
        from,
        via,
        ...(fromKind ? { from_kind: fromKind } : {}),
      },
      { idPrefix: "api" }
    );
    setLanded(r.path);
    return json(200, { id: r.id, path: r.path });
  } catch (e) {
    if (e instanceof VoiceError) return json(400, { error: e.message, code: e.code });
    throw e;
  }
}

// Observations (the memory pass's demand signal) — voice arrivals since
// #521: free text + optional query, identity stamped from the TOKEN like
// enqueue. The landing admits no about/refs for observations by shape —
// an observation is evidence, structurally unable to pose as a work
// order — and the memory pass consumes it via its insertion cursor.
async function observeHandler({
  req,
  root,
  record,
  json,
  setBytes,
  setLanded,
}: RouteCtx): Promise<Response> {
  const draft = await jsonObjectBody<{
    observation?: unknown;
    query?: unknown;
    urgency?: unknown;
  }>(req, json, { setBytes });
  if (draft instanceof Response) return draft;
  const { from, via, fromKind } = principalOf(record);

  try {
    const landed = landVoice(
      root,
      {
        kind: "observation",
        text: String(draft.observation ?? ""),
        ...(typeof draft.query === "string" && draft.query.trim() ? { query: draft.query } : {}),
        // urgency passes through as-is: landVoice is the one validator
        // ("now" or nothing), so CLI and HTTP can't drift
        ...(draft.urgency !== undefined ? { urgency: draft.urgency as "now" } : {}),
      },
      {
        from,
        via,
        ...(fromKind ? { from_kind: fromKind } : {}),
      },
      { idPrefix: "api" }
    );
    setLanded(landed.path);
    return json(200, { id: landed.id, path: landed.path });
  } catch (e) {
    if (e instanceof VoiceError) return json(400, { error: e.message, code: e.code });
    throw e;
  }
}

// ── the gardener door (#479) ──────────────────────────────────────────────
//
// next/submit ARE lib/work.ts (#520) — the same contract the MCP server
// serves on this disk; this door serves it to a caller that is not on it. `next` is a pure read of the due-work view — no claim, no
// lease, by decision (#479 revised: the tender's client-side pid lock
// single-flights; the server's only tending state is the logs). `submit`
// runs the one wire validator (lib/work.ts submitWire), so a rejection here
// is word-for-word the MCP submit tool's. Neither route is rate-limited: submit is
// per-ITEM by contract (a killed tab loses at most one item's in-context
// work), so a normal round legitimately exceeds 30 req/min — the tend
// scope (ONE designated machine per vault) is the gate, submits are
// idempotent validated appends, and the transport cap bounds abuse.

/** Machine traffic must not pollute the demand ledger (#502): a caller
 * holding the tend scope may declare `via=gardener` on a read; anyone
 * else's claim is ignored, not refused — the read still answers, ledgered
 * as the agent surface. */
function gardenerVia(url: URL, record: TokenRecord): "gardener" | "api" {
  return url.searchParams.get("via") === "gardener" && hasScope(record, "tend")
    ? "gardener"
    : "api";
}

function gardenerNextHandler({ root, url, json }: RouteCtx): Response {
  const kindsRaw = (url.searchParams.get("kinds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const k of kindsRaw)
    if (!(WORK_KINDS as readonly string[]).includes(k))
      return json(400, { error: `bad kind "${k}" — use ${WORK_KINDS.join(", ")}` });
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  let items: WorkItem[];
  try {
    items = nextWork(root, {
      ...(kindsRaw.length ? { kinds: kindsRaw as WorkKind[] } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  } catch (e) {
    // nextWork's own refusals (limit out of range) say what would work.
    return json(400, { error: e instanceof Error ? e.message : String(e) });
  }
  return json(200, { items });
}

async function gardenerSubmitHandler({
  req,
  root,
  record,
  now,
  log,
  json,
  setBytes,
}: RouteCtx): Promise<Response> {
  const body = await jsonObjectBody<{ items?: unknown }>(req, json, { setBytes });
  if (body instanceof Response) return body;
  let result: SubmitResult;
  try {
    result = submitWire(root, body.items, {
      // The token's surface is the author (sender-identity rules: the
      // machine, never the person) — record.name is the card the user
      // consented to ("claude code on …"). A STABLE invocation id, same
      // reasoning as the MCP submit tool's: the event identity hash covers author,
      // and a retried submission must converge on the prior event.
      author: { kind: "model", id: record.name, invocation_id: "door" },
      produced_by: { procedure: "bigbrain-door", version: "v1" },
      now: () => now(),
    });
  } catch (e) {
    // submitWire's top-level refusals (not an array, oversized batch);
    // per-item problems come back as rejected rows in a 200, same as the
    // MCP submit tool's result.
    return json(400, { error: e instanceof Error ? e.message : String(e) });
  }
  // #482: the door tender's only server-side footprint. One overwritten file
  // — when tending last happened, by whom, settling how much — so
  // /v1/status.last_run answers for a vault tended only through this door.
  // Failure must not fail the submit: the events are already
  // appended, and a retry would only dedup.
  try {
    ensureDir(join(root, TEND_JOURNAL_DIR));
    writeAtomic(
      join(root, TEND_JOURNAL_DIR, "door.json"),
      `${JSON.stringify({
        format: "bigbrain-tend-door/v1",
        at: now().toISOString(),
        settled: result.appended + result.deduped,
        by: record.name,
      })}\n`
    );
  } catch (e) {
    log(`gardener/submit: door.json write failed: ${e instanceof Error ? e.message : e}`);
  }
  return json(200, result);
}

// ── the route table ──────────────────────────────────────────────────────

const PUBLIC_ROUTES: PublicRoute[] = [
  { method: "POST", path: "/v1/pair", auth: false, handler: pairHandler },
];

const AUTHED_ROUTES: AuthedRoute[] = [
  { method: "GET", path: "/v1/whoami", touch: false, handler: whoamiHandler },
  {
    method: "POST",
    path: "/v1/drop",
    scope: "inbox:write",
    rateLimited: true,
    handler: dropHandler,
  },
  {
    method: "POST",
    path: "/v1/session",
    scope: "inbox:write",
    rateLimited: true,
    handler: sessionHandler,
  },
  {
    method: "POST",
    path: "/v1/enqueue",
    scope: "inbox:write",
    rateLimited: true,
    handler: enqueueHandler,
  },
  {
    method: "POST",
    path: "/v1/observe",
    scope: "inbox:write",
    rateLimited: true,
    handler: observeHandler,
  },
  { method: "GET", path: "/v1/status", scope: "vault:read", handler: statusHandler },
  { method: "GET", path: "/v1/note", scope: "vault:read", handler: noteHandler },
  { method: "GET", path: "/v1/search", scope: "vault:read", handler: searchHandler },
  { method: "GET", path: "/v1/memory", scope: "vault:read", handler: memoryHandler },
  // The gardener door (#479) — deliberately not rate-limited; see its
  // section header above.
  { method: "GET", path: "/v1/gardener/next", scope: "tend", handler: gardenerNextHandler },
  { method: "POST", path: "/v1/gardener/submit", scope: "tend", handler: gardenerSubmitHandler },
];

/** The declared surface, method+path+scope only (no handler references) —
 * exported so a test can assert every table entry is reachable and that
 * nothing answers outside the table, without reaching into dispatch
 * internals. */
export const ROUTES: readonly { method: string; path: string; scope?: string | string[] }[] = [
  ...PUBLIC_ROUTES.map(({ method, path }) => ({ method, path })),
  ...AUTHED_ROUTES.map(({ method, path, scope }) => ({ method, path, scope })),
];

export function makeApiHandler(deps: ApiDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const pairOwner = deps.pairOwner ?? (() => ownerFor(deps.root, claudeAccount()));
  const buckets = new Map<string, Bucket>();

  function takeToken(id: string): { ok: true } | { ok: false; retryAfter: number } {
    const t = now().getTime();
    const b = buckets.get(id) ?? { tokens: RATE_CAPACITY, last: t };
    b.tokens = Math.min(RATE_CAPACITY, b.tokens + (t - b.last) * RATE_REFILL_PER_MS);
    b.last = t;
    if (b.tokens < 1) {
      buckets.set(id, b);
      return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / RATE_REFILL_PER_MS / 1000) };
    }
    b.tokens -= 1;
    buckets.set(id, b);
    return { ok: true };
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    let status = 0;
    let tokenId: string | undefined;
    let tokenName: string | undefined;
    let bytes = 0;
    let landed: string | undefined;

    const respond = (r: Response): Response => {
      status = r.status;
      log(
        JSON.stringify({
          ts: now().toISOString(),
          method: req.method,
          path,
          status,
          ...(tokenId ? { token: tokenId, name: tokenName } : {}),
          ...(bytes ? { bytes } : {}),
          ...(landed ? { landed } : {}),
        })
      );
      return r;
    };

    if (req.headers.get("x-forwarded-proto") === "http")
      log(
        JSON.stringify({
          ts: now().toISOString(),
          warn: "plaintext-forwarded request — front the API with TLS",
          path,
        })
      );

    if (req.method === "OPTIONS")
      return respond(new Response(null, { status: 204, headers: CORS }));

    for (const route of PUBLIC_ROUTES) {
      if (route.method !== req.method) continue;
      if (matchPath(route.path, path) === null) continue;
      return respond(
        await route.handler({ req, url, json, root: deps.root, storePath: deps.storePath, now, owner: pairOwner })
      );
    }

    // A path with no entry at all — not even under the wrong method —
    // 404s without ever asking for a token, same as an unauthed route
    // would leak nothing about a path that doesn't exist.
    const known = AUTHED_ROUTES.some((r) => matchPath(r.path, path) !== null);
    if (!known) return respond(json(404, { error: "not found" }));

    const authHeader = req.headers.get("authorization") ?? "";
    const presented = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const verdict = verifyToken(deps.storePath, presented);
    if (!verdict.ok) {
      const idHint = /^bb_([0-9a-f]{8})_/.exec(presented)?.[1];
      log(
        JSON.stringify({
          ts: now().toISOString(),
          warn: "auth refused",
          path,
          reason: verdict.reason,
          ...(idHint ? { token: idHint } : {}),
        })
      );
      return respond(unauthorized());
    }
    const record = verdict.record;
    tokenId = record.id;
    tokenName = record.name;
    let route: AuthedRoute | undefined;
    let params: Record<string, string> = {};
    for (const r of AUTHED_ROUTES) {
      if (r.method !== req.method) continue;
      const p = matchPath(r.path, path);
      if (p === null) continue;
      route = r;
      params = p;
      break;
    }
    // Known path, wrong method (e.g. DELETE /v1/drop): the token was
    // still real, but there is no entry to dispatch to.
    if (!route) return respond(json(404, { error: "not found" }));

    if (route.scope) {
      const scopes = Array.isArray(route.scope) ? route.scope : [route.scope];
      if (!scopes.some((s) => hasScope(record, s)))
        return respond(json(403, { error: `missing scope ${scopes.join(" or ")}` }));
    }

    if (route.rateLimited) {
      const rate = takeToken(record.id);
      if (!rate.ok)
        return respond(
          json(429, { error: "rate limited" }, { "Retry-After": String(rate.retryAfter) })
        );
    }

    // The credential was accepted, carried its scope, and is being handed
    // to a route: that is what `last_used` means, and it means it here for
    // every route rather than wherever ten handlers each happened to write
    // it. A refusal INSIDE the handler (a bad body, a missing note) still
    // counts — the credential worked; the request did not.
    if (route.touch !== false) touchLastUsed(deps.storePath, record.id, now());

    return respond(
      await route.handler({
        req,
        url,
        root: deps.root,
        now,
        log,
        json,
        record,
        params,
        setBytes: (n: number) => {
          bytes = n;
        },
        setLanded: (rel: string) => {
          landed = rel;
        },
      })
    );
  };
}
