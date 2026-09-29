/**
 * sharedVaultApi.ts — the shared vault's HTTP door. bin/shared.ts serves
 * it; tests call it with `new Request(...)` — a pure (Request) => Response
 * over injected deps, no socket involved (the same shape as lib/api.ts,
 * whose dispatcher this follows).
 *
 * Every route requires a member credential (lib/sharedMembers.ts) — there
 * is no unauthenticated surface at all, not a health probe, not a 404: an
 * unauthenticated request learns nothing, including whether a path exists.
 * Auth failures are an undifferentiated 401 (the reason goes to the server
 * log by credential id, never the secret). 403 names the missing
 * permission — the caller holds a real credential and may as well know.
 *
 *   GET  /v1/whoami                         any member   the verified actor
 *   POST /v1/evidence                       write        {title, body, origin?} → {id, source_id, deduped, seq}
 *   GET  /v1/evidence?limit&cursor          read         a page of evidence
 *   GET  /v1/evidence/:id                   read         one insertion event
 *   POST /v1/assertions                     write        {text, sources, confidence?} → {id, deduped, seq}
 *   GET  /v1/assertions?limit&cursor[&include_revoked]   read   a page of assertions with status
 *   GET  /v1/assertions/:id                 read         one assertion with its revocation/resolution
 *   POST /v1/assertions/:id/correct         write+author {text, sources, confidence?, reason?}
 *   POST /v1/assertions/:id/retract         write+author {reason}
 *   POST /v1/moderation                     write+OWNER  {assertion_id, reason}
 *   GET  /v1/search?q&limit                 read         term-AND hits over evidence and live assertions
 *   GET  /v1/feed?after&limit               read         the durable change feed from a cursor
 *
 * The door reads and writes ONLY the vault's logs through lib/sharedVault.ts
 * — never a path a client names. Ids are validated by pattern before
 * anything touches the filesystem, so `/v1/evidence/../x` is a 400 that
 * never became a path.
 */

import {
  hasPermission,
  touchCredential,
  verifyCredential,
  type SharedActor,
  type SharedPermission,
} from "./sharedMembers";
import {
  FEED_PAGE_CAP,
  LIST_PAGE_CAP,
  MAX_EVIDENCE_BYTES,
  SEARCH_CAP,
  SharedVault,
  SharedVaultError,
} from "./sharedVault";

export interface SharedApiDeps {
  root: string;
  storePath: string;
  now?: () => Date;
  log?: (line: string) => void;
  /** An already-opened vault (the server's), else one is opened on `root`. */
  vault?: SharedVault;
}

/** Whole-request cap: the evidence body cap plus JSON overhead. Set on
 * `Bun.serve` by bin/shared.ts AND enforced here so it is testable. */
export const MAX_SHARED_REQUEST_BYTES = MAX_EVIDENCE_BYTES + 64 * 1024;

// Per-credential token bucket on writes: 60/min. Bounds a runaway client
// and the disk a leaked credential could fill; resets on restart.
const RATE_CAPACITY = 60;
const RATE_REFILL_PER_MS = 60 / 60_000;

type Json = (status: number, body: unknown, headers?: Record<string, string>) => Response;

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const json: Json = (status, body, headers = {}) =>
  new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...headers },
  });

const unauthorized = (): Response => json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });

interface RouteCtx {
  url: URL;
  vault: SharedVault;
  actor: SharedActor;
  params: Record<string, string>;
  json: Json;
  /** The parsed JSON body on POST routes (read by the dispatcher, after
   * which the credential is verified AGAIN — see makeSharedApiHandler). */
  body: unknown;
}

interface Route {
  method: "GET" | "POST";
  /** Exact, or with one `:name` segment. */
  path: string;
  /** The permission the route needs; absent = any live member (whoami). */
  permission?: SharedPermission;
  rateLimited?: boolean;
  handler: (ctx: RouteCtx) => Response | Promise<Response>;
}

/** `/v1/assertions/:id/correct` against `/v1/assertions/ast_…/correct`:
 * one captured segment, which may not contain a slash. */
function matchPath(routePath: string, actual: string): Record<string, string> | null {
  const want = routePath.split("/");
  const got = actual.split("/");
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = got[i]!;
    if (w.startsWith(":")) {
      if (!g) return null;
      params[w.slice(1)] = g;
    } else if (w !== g) return null;
  }
  return params;
}

function intParam(url: URL, name: string, fallback: number, max: number, json: Json): number | Response {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  // Decimal digits only: `1e3`, `0x10` and `1.0` are not sequence numbers.
  const n = /^\d{1,15}$/u.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < (name === "after" ? 0 : 1) || n > (name === "after" ? Number.MAX_SAFE_INTEGER : max))
    return json(400, { error: `bad ${name} "${raw}" — ${name === "after" ? "a non-negative integer" : `an integer 1-${max}`}` });
  return n;
}

async function jsonBody(req: Request, json: Json, setBytes: (n: number) => void): Promise<unknown | Response> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/json"))
    return json(415, { error: "send application/json" });
  const raw = await req.text();
  const bytes = Buffer.byteLength(raw);
  setBytes(bytes);
  if (bytes > MAX_SHARED_REQUEST_BYTES) return json(413, { error: `request exceeds ${MAX_SHARED_REQUEST_BYTES} bytes` });
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return json(400, { error: "bad JSON body" });
  }
}

/** The actor, verified fresh. Two verdicts must agree: the one before the
 * body was read (so a stranger's upload is never read at all) and the one
 * after (so a revocation that lands DURING a slow upload refuses it). */
function sameActor(a: SharedActor, b: SharedActor): boolean {
  return a.credential_id === b.credential_id && a.member_id === b.member_id && a.permissions.join() === b.permissions.join();
}

const decodedSegment = (raw: string, json: Json): string | Response => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return json(400, { error: "bad id" });
  }
};

// ── handlers ──────────────────────────────────────────────────────────────

const whoami = ({ actor, json }: RouteCtx): Response =>
  json(200, {
    handle: actor.handle,
    display: actor.display,
    member_id: actor.member_id,
    role: actor.role,
    kind: actor.kind,
    permissions: actor.permissions,
    credential: { id: actor.credential_id, name: actor.credential_name },
  });

function postEvidence({ body, vault, actor, json }: RouteCtx): Response {
  const r = vault.dropEvidence(actor, body);
  return json(r.deduped ? 200 : 201, {
    id: r.insertion.id,
    source_id: r.insertion.source_id,
    deduped: r.deduped,
    seq: r.seq,
    submitted_by: actor.handle,
    origin: r.insertion.envelope["origin"],
  });
}

function listEvidence({ url, vault, json }: RouteCtx): Response {
  const limit = intParam(url, "limit", 50, LIST_PAGE_CAP, json);
  if (limit instanceof Response) return limit;
  const page = vault.listEvidence({ limit, cursor: url.searchParams.get("cursor") });
  return json(200, {
    items: page.items.map((e) => ({ id: e.id, source_id: e.source_id, title: e.title, author: e.author, envelope: e.envelope })),
    next_cursor: page.next_cursor,
  });
}

function getEvidence({ params, vault, json }: RouteCtx): Response {
  const id = decodedSegment(params["id"]!, json);
  if (id instanceof Response) return id;
  const e = vault.evidence(id);
  return e ? json(200, e) : json(404, { error: "not found" });
}

function postAssertion({ body, vault, actor, json }: RouteCtx): Response {
  const r = vault.assert(actor, body);
  return json(r.deduped ? 200 : 201, { id: r.assertion.id, deduped: r.deduped, seq: r.seq, author: r.assertion.author });
}

function listAssertions({ url, vault, json }: RouteCtx): Response {
  const limit = intParam(url, "limit", 50, LIST_PAGE_CAP, json);
  if (limit instanceof Response) return limit;
  const includeRevoked = ["1", "true"].includes((url.searchParams.get("include_revoked") ?? "").toLowerCase());
  const page = vault.listAssertions({ limit, cursor: url.searchParams.get("cursor"), includeRevoked });
  return json(200, { items: page.items, next_cursor: page.next_cursor });
}

function getAssertion({ params, vault, json }: RouteCtx): Response {
  const id = decodedSegment(params["id"]!, json);
  if (id instanceof Response) return id;
  const view = vault.assertion(id);
  return view ? json(200, view) : json(404, { error: "not found" });
}

function correctAssertion({ body, params, vault, actor, json }: RouteCtx): Response {
  const id = decodedSegment(params["id"]!, json);
  if (id instanceof Response) return id;
  const r = vault.correct(actor, id, body);
  return json(r.deduped ? 200 : 201, {
    id: r.assertion.id,
    supersedes: id,
    revocation: r.revocation.id,
    deduped: r.deduped,
    seq: r.seq,
    author: r.assertion.author,
  });
}

function retractAssertion({ body, params, vault, actor, json }: RouteCtx): Response {
  const id = decodedSegment(params["id"]!, json);
  if (id instanceof Response) return id;
  const r = vault.retract(actor, id, body);
  return json(r.deduped ? 200 : 201, { revocation: r.revocation.id, assertion_id: id, deduped: r.deduped, seq: r.seq, author: r.revocation.author });
}

function moderate({ body, vault, actor, json }: RouteCtx): Response {
  const r = vault.moderate(actor, body);
  return json(r.deduped ? 200 : 201, {
    revocation: r.revocation.id,
    assertion_id: r.revocation.assertion_id,
    deduped: r.deduped,
    seq: r.seq,
    author: r.revocation.author,
    procedure: r.revocation.produced_by.procedure,
  });
}

function search({ url, vault, json }: RouteCtx): Response {
  const q = url.searchParams.get("q") ?? "";
  if (!q.trim()) return json(400, { error: "missing q" });
  const limit = intParam(url, "limit", 20, SEARCH_CAP, json);
  if (limit instanceof Response) return limit;
  return json(200, { hits: vault.search(q, limit) });
}

function feed({ url, vault, json }: RouteCtx): Response {
  const after = intParam(url, "after", 0, Number.MAX_SAFE_INTEGER, json);
  if (after instanceof Response) return after;
  const limit = intParam(url, "limit", 100, FEED_PAGE_CAP, json);
  if (limit instanceof Response) return limit;
  return json(200, vault.feed(after, limit));
}

// ── the route table ──────────────────────────────────────────────────────

const ROUTE_TABLE: Route[] = [
  { method: "GET", path: "/v1/whoami", handler: whoami },
  { method: "POST", path: "/v1/evidence", permission: "write", rateLimited: true, handler: postEvidence },
  { method: "GET", path: "/v1/evidence", permission: "read", handler: listEvidence },
  { method: "GET", path: "/v1/evidence/:id", permission: "read", handler: getEvidence },
  { method: "POST", path: "/v1/assertions", permission: "write", rateLimited: true, handler: postAssertion },
  { method: "GET", path: "/v1/assertions", permission: "read", handler: listAssertions },
  { method: "GET", path: "/v1/assertions/:id", permission: "read", handler: getAssertion },
  { method: "POST", path: "/v1/assertions/:id/correct", permission: "write", rateLimited: true, handler: correctAssertion },
  { method: "POST", path: "/v1/assertions/:id/retract", permission: "write", rateLimited: true, handler: retractAssertion },
  { method: "POST", path: "/v1/moderation", permission: "write", rateLimited: true, handler: moderate },
  { method: "GET", path: "/v1/search", permission: "read", handler: search },
  { method: "GET", path: "/v1/feed", permission: "read", handler: feed },
];

/** The declared surface — so a test can assert every entry answers and
 * nothing answers outside it. */
export const SHARED_ROUTES: readonly { method: string; path: string; permission?: SharedPermission }[] =
  ROUTE_TABLE.map(({ method, path, permission }) => ({ method, path, ...(permission ? { permission } : {}) }));

export function makeSharedApiHandler(deps: SharedApiDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const vault = deps.vault ?? new SharedVault(deps.root, { now });
  const buckets = new Map<string, { tokens: number; last: number }>();

  function takeToken(id: string): { ok: true } | { ok: false; retryAfter: number } {
    const t = now().getTime();
    const b = buckets.get(id) ?? { tokens: RATE_CAPACITY, last: t };
    b.tokens = Math.min(RATE_CAPACITY, b.tokens + (t - b.last) * RATE_REFILL_PER_MS);
    b.last = t;
    buckets.set(id, b);
    if (b.tokens < 1) return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / RATE_REFILL_PER_MS / 1000) };
    b.tokens -= 1;
    return { ok: true };
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    let bytes = 0;
    let credential: string | undefined;
    let handle: string | undefined;

    const respond = (r: Response): Response => {
      log(
        JSON.stringify({
          ts: now().toISOString(),
          method: req.method,
          path,
          status: r.status,
          ...(credential ? { credential, member: handle } : {}),
          ...(bytes ? { bytes } : {}),
        })
      );
      return r;
    };

    if (req.headers.get("x-forwarded-proto") === "http")
      log(JSON.stringify({ ts: now().toISOString(), warn: "plaintext-forwarded request — front the shared vault with TLS", path }));

    // Auth FIRST, before the path is even looked at: a stranger gets 401
    // for every path, real or not.
    const authHeader = req.headers.get("authorization") ?? "";
    // The scheme is case-insensitive (RFC 9110 §11.1); the credential is not.
    const presented = /^bearer /iu.test(authHeader) ? authHeader.slice(7).trim() : "";
    const verdict = verifyCredential(deps.storePath, presented);
    if (!verdict.ok) {
      const idHint = /^sv_([0-9a-f]{8})_/u.exec(presented)?.[1];
      log(JSON.stringify({ ts: now().toISOString(), warn: "auth refused", path, reason: verdict.reason, ...(idHint ? { credential: idHint } : {}) }));
      return respond(unauthorized());
    }
    const actor = verdict.actor;
    credential = actor.credential_id;
    handle = actor.handle;

    let route: Route | undefined;
    let params: Record<string, string> = {};
    for (const r of ROUTE_TABLE) {
      const p = matchPath(r.path, path);
      if (p === null) continue;
      if (r.method !== req.method) continue;
      route = r;
      params = p;
      break;
    }
    if (!route) return respond(json(404, { error: "not found" }));

    if (route.permission && !hasPermission(actor, route.permission))
      return respond(json(403, { error: `missing permission ${route.permission}`, permissions: actor.permissions }));

    if (route.rateLimited) {
      const rate = takeToken(actor.credential_id);
      if (!rate.ok) return respond(json(429, { error: "rate limited" }, { "Retry-After": String(rate.retryAfter) }));
    }

    if (route.path !== "/v1/whoami") touchCredential(deps.storePath, actor.credential_id, now());

    try {
      let body: unknown;
      if (route.method === "POST") {
        const parsed = await jsonBody(req, json, (n) => {
          bytes = n;
        });
        if (parsed instanceof Response) return respond(parsed);
        body = parsed;
        // The upload took time; the world may have moved. A credential or
        // member revoked, or a member narrowed, while the body was in
        // flight refuses the write it was carrying.
        const again = verifyCredential(deps.storePath, presented);
        if (!again.ok || !sameActor(again.actor, actor)) {
          log(JSON.stringify({ ts: now().toISOString(), warn: "auth changed during request", path, credential, reason: again.ok ? "actor changed" : again.reason }));
          return respond(unauthorized());
        }
      }
      return respond(await route.handler({ url, vault, actor, params, json, body }));
    } catch (error) {
      if (error instanceof SharedVaultError) return respond(json(error.status, { error: error.message }));
      // Anything else is the server's fault: answer in shape, log the
      // cause, never let a throw reach the serve loop.
      log(JSON.stringify({ ts: now().toISOString(), error: "unhandled", path, message: error instanceof Error ? error.message : String(error) }));
      return respond(json(500, { error: "internal error" }));
    }
  };
}
