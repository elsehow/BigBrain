import { sharedWorkspace } from "../lib/sharedWorkspace";
import { allowVaultRequest, vaultIdentity } from "../lib/vaultBoundary";
import { ApplicationChanges } from "../lib/applicationChanges";
import { ApplicationActions } from "../lib/applicationActions";
import { resolveNote, readNoteFile } from "../lib/noteResolution";
import { telemetry, type Operation } from "../lib/telemetry";
/**
 * web/server.ts — a read-only window onto the vault, stolen (in spirit and CSS)
 * from pi-squad's squad-web, minus everything that made that one an agent mux.
 * Serves the record, its derived views, and the built Svelte UI in web/ui/dist.
 * Explicit POST routes handle configuration, intake, and local model work.
 * Entity briefings stream a cited synthesis and cache it under .state/;
 * they never become assertions or modify the curated record.
 *
 * Importing this module is side-effect free (#260): module scope only
 * declares, start() below binds the socket and starts the watcher, and the
 * entrypoint gate (import.meta.main) calls it. That is what lets bun test
 * reach the helpers without opening a port.
 */

import { intakeWireReceipt } from "../lib/intakeWire";
import { apiPort, isDesktop, isDev, webPort } from "../lib/env";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadManifest } from "../lib/manifest";
import { VAULT_ROOT } from "../lib/vaultRoot";
import { ENGINE_ROOT, engineIdentity } from "../lib/engine";
import { dieWithSupervisor } from "../lib/parentWatch";
import { configSave, integrationsInfo } from "../lib/configWrite";
import { allowLoopbackRequest, armor, dispatch, json, readBody, send, type Ctx, type Route } from "../lib/httpx";
import { IntakeError } from "../lib/intake";
import { landDirective, landDrop } from "../lib/landItem";
import { voiceMessagesFor } from "../lib/voice";
import { createLive } from "../lib/liveEvents";
import { recordUse } from "../lib/retrieval";
import { clampLimit, scanSurface, SEARCH_CAP } from "../lib/searchCore";
import { rankNavigationSearch } from "../lib/navigationSearch";
import { envelopeOrSniff, type Envelope } from "../lib/envelope";
import { entityMeta, envelopeWhen, parseNoteDate } from "../lib/noteMeta";
import { withinRoot } from "../lib/browsePaths";
import { serveStatic } from "../lib/staticServe";
import { walkMarkdown } from "../lib/vaultRead";
import { parseBlobRef, readBlob } from "../lib/blobs";
import { recentSourcePageAsync } from "../lib/sourceFeed";
import { primaryGraphWithLayoutAsync, primaryGraphAsync } from "../lib/graphCache";
import { frozenMessagesForRefs, sortFrozenDesc } from "../lib/frozenQueue";
import { queueHead } from "../lib/queueHead";
import { noteLog } from "../lib/noteLog";
import type { NoteMeta } from "../lib/viewTypes";
import { errText } from "../lib/errText";
import { hasAssertionEvents } from "../lib/assertionLog";
import { syncAssertionProjection } from "../lib/assertionProjection";
import { insertionFiler, sourceInsertionMarkdown } from "../lib/sourceFeed";
import { assertionsFromSource, projectedEntityMarkdown, truncatedEntityView, sourceThreadForInsertion, sourceInsertionCached } from "../lib/assertionEntityView";
import { insertionEventRel, sourceMoment } from "../lib/insertionLog";
import { foldsRoutes } from "../lib/entityFolds";
import { noteBriefingRoutes } from "../lib/noteBriefing";
import { sourceReadStateRoutes, graphWithReadState } from "../lib/sourceReadStateApi";
import { sourceOrigin } from "../lib/sourceOrigin";
import { setupRoutes, setupState } from "../lib/firstRun";
import { listTokens, revokeToken, tokenStorePath } from "../lib/auth";
import { mintPairCode, pendingPair } from "../lib/pair";
import { providerMonitoring } from "../lib/providerMonitor";
import { desktopRouteManifest } from "./desktopRouteManifest";

const ROOT = VAULT_ROOT;
const UI_DIST = join(ENGINE_ROOT, "web", "ui", "dist");
const PORT = webPort();
// Under the desktop app (bin/desktop.ts sets it) the viewer carries the
// setup door (#575): /api/setup and the two acts behind the first-run and
// settings cards. A headless host has no such door — there the CLI is the
// door (`bigbrain init`, `bigbrain connect`) and the cards say so — so the
// routes 404 and the viewer renders as it always has.
const DESKTOP = isDesktop();
/** The intake API beside this viewer — where a same-machine client (the
 * plugin, a paired browser) is told to point. The dev loop moves the port. */
const API_BASE = `http://127.0.0.1:${apiPort()}`;

// The browse-root gate: BROWSE_ROOTS and the resolver live in
// lib/browsePaths.ts; this is
// the ROOT-bound spelling every route uses.
/** Resolve a browse-root-relative path, or null if it escapes / isn't
 * allowed. Exported for test/webServer.test.ts — the path-traversal guard is
 * the pure helper the import-without-listen test exercises (#260). */
export function within(rel: string): string | null {
  return withinRoot(ROOT, rel);
}

// The frontmatter keys the listing reads: the date ladder below, then the
// entity facets. ONE list because it is ONE read — noteWhen and noteEntity
// each opened the file and parsed its head separately, so a 932-note
// directory paid 1,864 reads to answer one listing (#639). The keys only
// steer the line-wise FALLBACK (envelopeOrSniff sniffs them when the block
// parse yields nothing), so asking for both sets costs a well-formed note
// nothing and gives a malformed one both answers.
const HEAD_KEYS = ["date", "created", "filed", "updated", "kind", "entity_type"];

/** A note's frontmatter head, parsed once. `undefined` when the file could
 * not be read — the caller falls back to what the filename and the stat
 * already told it. */
function noteHead(abs: string): Envelope | undefined {
  try {
    // envelopeOrSniff, not parseEnvelope: one malformed frontmatter line
    // must not blind the well-formed keys around it.
    return envelopeOrSniff(readFileSync(abs, "utf8").slice(0, 4096), HEAD_KEYS);
  } catch {
    return undefined;
  }
}

// A note's "when" is its own source date, never the file's mtime alone —
// this vault syncs by git, and every checkout/clone resets every mtime to
// the same moment. Sources, most trusted first: the `date` key (drop.ts
// contract; dreams), then `created`/`filed`/`updated` — but those can be an
// IMPORT time months after the event (bulk backfills), so the filename's
// YYYY-MM-DD prefix (the vault's own naming contract) arbitrates: a key
// timestamp on the same day keeps its time-of-day; a different day means
// the prefix wins at date precision.
function whenOf(envelope: Envelope | undefined, base: string, mtimeMs: number): number {
  const fn = /^(\d{4}-\d{2}-\d{2})\b/.exec(base);
  const fnMs = fn ? parseNoteDate(fn[1]!) : NaN;
  const t = envelope === undefined ? undefined : envelopeWhen(envelope, fnMs);
  if (t !== undefined) return t;
  return Number.isNaN(fnMs) ? mtimeMs : fnMs;
}

/** `whenOf` for a caller that holds only the path — the note routes, which
 * read one file and not a directory. */
function noteWhen(abs: string, base: string, mtimeMs: number): number {
  return whenOf(noteHead(abs), base, mtimeMs);
}

// Recursive: the editor nests notes (e.g. entities/orgs/acme.md), and those notes
// must show. `name` keeps the dir-relative path so nesting is visible in lists.
// The walk itself is lib/vaultRead.ts's (#259) — this door's options: three
// directory levels deep, dot-entries skipped.
function listNotes(dirRel: string, depth = 3): NoteMeta[] {
  const real = within(dirRel);
  if (!real || !existsSync(real) || !statSync(real).isDirectory()) return [];
  return walkMarkdown(ROOT, [dirRel], { maxDepth: depth, skipDotted: true })
    .flatMap((path) => {
      const abs = join(ROOT, path);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        return []; // vanished between walk and stat
      }
      const head = noteHead(abs);
      return [
        {
          name: path.slice(dirRel.length + 1),
          path,
          modified: whenOf(head, path.split("/").at(-1)!, st.mtimeMs),
          size: st.size,
          ...(head ? entityMeta(head) : {}),
        },
      ];
    })
    .sort((a, b) => b.modified - a.modified);
}

function countMd(abs: string, depth = 3): number {
  return walkMarkdown(abs, [""], { maxDepth: depth, skipDotted: true }).length;
}

// ── live: one watcher over the vault, fanned out to SSE clients ───────────────
// The watcher/debounce/heartbeat fan-out lives in lib/liveEvents.ts (#291);
// createLive only declares — live.start() (called by start() below) is what
// opens the watcher and the heartbeat, so importing this module stays
// side-effect free (#260).
const applicationActions = new ApplicationActions(ROOT);
const applicationChanges = new ApplicationChanges();
const live = createLive({ root: ROOT, applicationChanges });

// ── config: the one write route ───────────────────────────────────────────────
// vault.yaml's role models and the prompt templates are human-edited by
// contract; this UI is the human's pen. The apply itself lives in
// lib/configWrite.ts (#291). This handler is the HTTP plumbing: collect the
// body, send the answer.
async function handleConfigSave(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const r = await configSave(ROOT, await readBody(req));
    return send(res, r.status, r.body);
  } catch (e) {
    // readBody's refusals (an over-cap body) answer the same way configSave's do
    return send(res, 400, JSON.stringify({ error: errText(e) }));
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

/** A note this door will read: under a browse root, `.md`, and a file that
 * is there. Three routes asked this question in one four-clause condition
 * each, and a fourth asked half of it. */
function noteFile(rel: string): string | null {
  const real = within(rel);
  return real && rel.endsWith(".md") && existsSync(real) && statSync(real).isFile() ? real : null;
}

/** The POST-with-a-JSON-body shape every write route here has: collect the
 * body under a cap, parse it, run the handler — and answer 400 with the
 * reason when any of that fails, the handler's own throws included. Two
 * routes answer a failure differently and pass `onError`. */
function jsonPost<T>(
  { req, res }: Ctx,
  handler: (body: T) => void | Promise<void>,
  opts: { cap?: number; onError?: (error: unknown) => void } = {}
): void {
  void (async () => {
    try {
      await handler(JSON.parse(await readBody(req, opts.cap ?? 1024 * 1024)) as T);
    } catch (error) {
      if (opts.onError) opts.onError(error);
      else send(res, 400, JSON.stringify({ error: errText(error) }));
    }
  })();
}// ── routes ──────────────────────────────────────────────────────────────────────
// One table, in the shape lib/api.ts's has always been (#639). This was a
// 500-line `if` chain over `req.url` — the most-churned file in the repo,
// where every feature paid the chain tax and no reader could see the
// surface without reading all of it.
//
// The METHOD is now stated rather than implied. Most of these were reached
// by an `if (p === "…")` with no method test at all, so `POST /api/vault`
// used to answer with the vault counts; it 404s now. Nothing asks that —
// the viewer's reads are all GET — and a read route that answers a write
// is the kind of thing an if-chain hides.

function serveIndex({ res }: Ctx): void {
  if (serveStatic(res, join(UI_DIST, "index.html"))) return;
  send(
    res,
    200,
    "<h1>BigBrain web</h1><p>No UI build yet — run <code>bun run web:build</code>.</p>",
    "text/html"
  );
}

function serveAsset({ res, url }: Ctx): void {
  const rel = url.pathname.slice(1).replace(/\.\.+/g, "");
  if (serveStatic(res, join(UI_DIST, rel))) return;
  send(res, 404, "not found", "text/plain");
}

/** The vault index: the record's counts and the queue head.
 *
 * The queue rides HERE, not on a door of its own (#639). Its only reader
 * is the home feed's column-head tooltip — four numbers — and it used to
 * ask for them with GET /api/queue, which built the whole due-set payload:
 * the due scan, then two journal walks, the memory stamp, the memory work
 * scan, a third journal walk and the observation mapping, every one of
 * them discarded. This route is already re-fetched on every live ping, so
 * the numbers arrive with the counts beside them and the second round trip
 * is gone. */
function vaultIndex({ res }: Ctx): void {
  json(res, 200, {
    queue: queueHead(ROOT),
    // the two trees that exist: the raw record + the maintained dossiers
    view: {
      references: countMd(join(ROOT, "references")),
      entities: countMd(join(ROOT, "entities")),
    },
    // depth 0 where a subdir is its own bucket: inbox/unsorted, requests/done
    inbox: {
      pending: countMd(join(ROOT, "inbox"), 0),
      unsorted: countMd(join(ROOT, "inbox", "unsorted")),
    },
    requests: {
      open: countMd(join(ROOT, "requests"), 0),
      done: countMd(join(ROOT, "requests", "done")),
    },
  });
}

/** Note listing, path-safe and scoped to the browse roots. */
function noteList({ res, url }: Ctx): void {
  const dir = url.searchParams.get("dir") ?? "";
  if (!within(dir)) return send(res, 404, "no such collection", "text/plain");
  json(res, 200, { dir, notes: listNotes(dir) });
}

function noteRead({ res, url }: Ctx): void {
  const rel = url.searchParams.get("path") ?? "";
  const resolved = resolveNote(ROOT, rel, { markdown: path => {
    const file = noteFile(path);
    return file ? readNoteFile(ROOT, file) : undefined;
  } });
  if (resolved?.kind === "thread") {
    const { thread } = resolved;
    recordUse(ROOT, rel, "web");
    return json(res, 200, { path: rel, content: `---\ntype: source\ncategory: thread\n---\n# ${thread.title}\n`,
      sourceAssertions: thread.assertions,
      sourceThread: { title: thread.title, messages: thread.members.map(s => ({
        path: insertionEventRel(s), title: s.title, from: insertionFiler(s).from,
        at: sourceMoment(s),
      })) },
      origin: sourceOrigin(thread.members[0]!.envelope, thread.members[0]!),
    });
  }
  if (resolved?.kind === "entity") {
    const projectedEntity = resolved.entity;
    recordUse(ROOT, rel, "web");
    // `assertions=N` — the viewer's progressive read: the LATEST N
    // assertions plus the true total, and a header-only markdown stub
    // (the client renders the structured view; the full markdown twin
    // was half of a 1.2MB payload on a 1,444-assertion entity). Absent
    // the param, the full both-forms response, unchanged — curl, older
    // bundles, and the markdown compatibility path keep their contract.
    const n = Number(url.searchParams.get("assertions") ?? "");
    if (Number.isInteger(n) && n > 0)
      return json(res, 200, {
        path: rel,
        content: projectedEntityMarkdown({ ...projectedEntity, assertions: [] }),
        projectedEntity: truncatedEntityView(projectedEntity, n),
      });
    return json(res, 200, {
      path: rel,
      content: projectedEntityMarkdown(projectedEntity),
      projectedEntity,
    });
  }
  if (resolved?.kind === "source") {
    const { source } = resolved;
    recordUse(ROOT, rel, "web");
    // The rail above the body: what the record made of this source
    // (lib/assertionEntityView.ts's assertionsFromSource). The markdown
    // stays the body alone — curl, the reader doors and older bundles keep
    // their contract; only the viewer reads the structured rows.
    // `origin` is the OPEN target: an external original, or a Markdown
    // copy of the stored body for text-only drops (lib/sourceOrigin.ts).
    return json(res, 200, {
      path: rel,
      content: sourceInsertionMarkdown(source),
      sourceAssertions: assertionsFromSource(ROOT, source.id),
      origin: sourceOrigin(source.envelope, source),
    });
  }
  if (resolved?.kind !== "markdown") return send(res, 404, "no such note", "text/plain");
  const real = resolved.markdown.file!;
  // Record the normalized spelling, not the client's (#333): `./x.md` and
  // `x.md` must be one ledger row — heat keys on these strings. Same idiom
  // as the api door's call site.
  recordUse(ROOT, relative(ROOT, real).split(sep).join("/"), "web");
  // The note's own date, for the one timestamp under its title. The viewer
  // used to get it by listing the whole CONTAINING DIRECTORY (#639) — a
  // three-level walk plus a frontmatter read per note, 932 of them in
  // references/, to find one row and read one field off it. The route that
  // already has the file open answers it. Only this arm: a projected
  // entity and a source insertion have no file, and the viewer never
  // showed a timestamp for either.
  json(res, 200, {
    path: rel,
    content: resolved.markdown.raw,
    modified: noteWhen(real, rel.split("/").at(-1)!, statSync(real).mtimeMs),
  });
}

// Binary companions — either a legacy vault-relative attachment (same
// browse-root guard as notes) or, since phase 1, a reference's
// `blob:<sha256>` ref (lib/envelope.ts's AttachmentRef contract) served
// straight from the CAS (lib/blobs.ts). The note renderer rewrites both
// link forms through here; a blob ref never touches within()'s
// path-traversal guard because it never carries a path at all — the sha256
// is validated by parseBlobRef, and an absent blob is a plain 404.
function fileRead({ res, url }: Ctx): void {
  const rel = url.searchParams.get("path") ?? "";
  const blobHash = parseBlobRef(rel);
  if (blobHash) {
    const bytes = readBlob(ROOT, blobHash);
    if (!bytes) return send(res, 404, "no such blob", "text/plain");
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "x-content-type-options": "nosniff",
      "content-disposition": "attachment",
      "cache-control": "no-store",
    });
    res.end(bytes);
    return;
  }
  const real = within(rel);
  if (!real || rel.endsWith(".md") || !existsSync(real) || !statSync(real).isFile())
    return send(res, 404, "no such file", "text/plain");
  if (serveStatic(res, real, { download: true })) return;
  send(res, 404, "unreadable", "text/plain");
}

// The home feed: the source insertion log, newest first — the one arm
// since #495 (the references/ + git-log reconstruction served vaults that
// predate the assertion-native substrate; none remain).
async function recentFeed({ res, url }: Ctx): Promise<void> {
  const limit = clampLimit(url.searchParams.get("limit"), 40, 200);
  const offset = Math.trunc(Math.min(Math.max(Number(url.searchParams.get("offset")) || 0, 0), 1_000_000));
  try { json(res, 200, await recentSourcePageAsync(ROOT, offset, limit)); }
  catch (error) { json(res, 500, { error: errText(error) }); }
}

// One product search (lib/searchCore.ts): the SAME record and memory search,
// ranking, cap and ledger write as GET /v1/search. Returns the {dir, note} shape
// the note lists use, plus the matched title and a body snippet, so the
// search view renders like any note row. The omnibox fires per keystroke,
// so most of what the ledger gets here is typeahead — collapsed at READ
// time, not suppressed at write.
function search({ req, res, url }: Ctx): void {
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.trunc(clampLimit(url.searchParams.get("limit"), 100));
  const paged = url.searchParams.has("offset");
  const offset = Math.trunc(Math.min(Math.max(Number(url.searchParams.get("offset")) || 0, 0), SEARCH_CAP));
  const end = Math.min(offset + limit, SEARCH_CAP);
  // THIS DOOR's empty-query policy (the per-door half of #259's
  // decision): an emptied omnibox is a search with nothing to show, not
  // a client bug — 200, no hits.
  if (!q) return json(res, 200, { query: "", hits: [] });
  // One tick before scanning. The scan is synchronous, so keystrokes that
  // arrive while one runs queue behind it — and by the time they run the
  // omnibox has usually ABORTED them (a newer query superseded each), but
  // the abort is only observable once the loop has drained that socket.
  // Deferred one tick, `req.destroyed` is true for them here and they cost
  // nothing; inline it was false for every one of them, so "trail map"
  // waited for the scans of "r" and "re" that nobody would read.
  setImmediate(async () => {
    if (req.destroyed) return;
    try {
      const graph = await primaryGraphAsync(ROOT);
      if (req.destroyed) return;
      const r = scanSurface(ROOT, q, SEARCH_CAP, "web");
      if (!r.ok) {
        // Same failure posture as the API door: the projection is a rebuildable
        // cache, its loss is the server's fault — answer 500 instead of
        // letting the throw take down the request (or the process).
        console.error(`search index unavailable: ${r.reason}`);
        return json(res, 500, { error: "search unavailable" });
      }
      const hits = r.hits.map((h) => {
        const base = h.path.split("/").at(-1)!;
        const abs = join(ROOT, h.path);
        let modified = 0;
        let size = 0;
        try {
          const st = statSync(abs);
          // an insertion event's file time is when it landed; the hit knows when it is from
          modified = (h.at && Date.parse(h.at)) || noteWhen(abs, base, st.mtimeMs);
          size = st.size;
        } catch {
          // No file behind the path: vanished since indexing, or a virtual hit
          // (a projected entity) that never had one. Its search-date still
          // gives the row a timestamp — for an entity, its newest evidence.
          modified = h.date ? Date.parse(h.date) || 0 : 0;
        }
        // The FILED BY facet, on hits that ARE one source's insertion — the
        // same fields the recent feed stamps (insertionFiler), so a surface
        // governed by the settings → vault Filter (the recent palette) can
        // hold search results to the same choices. Entity hits carry none:
        // an entity has many filers and always shows.
        const source = sourceInsertionCached(ROOT, h.path);
        const thread = source ? sourceThreadForInsertion(ROOT, source.id) : undefined;
        const filer = source ? insertionFiler(source, ROOT) : undefined;
        return {
          dir: h.evidence === "memory" ? "memory" : h.path.split("/").slice(0, 2).join("/"),
          note: { name: h.path.split("/").slice(2).join("/") || base, path: thread?.path ?? h.path, modified, size },
          title: thread?.title ?? h.title,
          ...(filer?.from === "pilot" && typeof source?.envelope.key === "string" ? { sessionId: source.envelope.key } : {}),
          ...(thread ? { threadCount: thread.members.length } : {}),
          snippet: h.snippet,
          ...(h.evidence ? { evidence: h.evidence } : {}),
          // an entity found through one of its aliases says so (#728)
          ...(h.alias ? { alias: h.alias } : {}),
          ...(filer
            ? {
                band: filer.band,
                from: filer.from,
                ...(filer.via ? { via: filer.via } : {}),
                ...(filer.channel ? { source: filer.channel } : {}),
                ...(filer.sourceDetail ? { sourceDetail: filer.sourceDetail } : {}),
                ...(filer.agentModel ? { agentModel: filer.agentModel } : {}),
              }
            : {}),
        };
      });
      const seen = new Set<string>();
      const ranked = rankNavigationSearch(hits, q, graph, url.searchParams.get("purpose") === "mention").filter(h => {
        if (seen.has(h.note.path)) return false;
        seen.add(h.note.path); return true;
      });
      json(res, 200, { query: q, ...(paged ? { nextOffset: ranked.length > end ? end : null } : {}), hits: ranked.slice(paged ? offset : 0, paged ? end : limit) });
    } catch (error) {
      if (!req.destroyed) json(res, 500, { error: errText(error) });
    }
  });
}

// Serve the graph as a FINISHED PICTURE: structure plus settled positions,
// computed once per structure by lib/graphLayout.ts and cached in .state.
// The client used to receive only the structure and simulate it itself on
// every load — see lib/graphLayout.ts for why that was the wrong side.
//
// There is one main graph, never a viewer switch. Once a vault contains an
// assertion, the graph is the ontology-free projection over assertions and
// cited source insertions. An assertion-empty legacy vault tolerantly keeps
// its link graph until that additive substrate exists.
async function graph({ res }: Ctx): Promise<void> {
  try {
    json(res, 200, graphWithReadState(ROOT, await primaryGraphWithLayoutAsync(ROOT)));
  } catch (error) {
    json(res, 500, { error: errText(error) });
  }
}

// A note's "touched by" record (phase 4 item 3): frontmatter provenance +
// bounded git history + a bounded queue-journal scan, merged newest-first
// (lib/noteLog.ts — the pure merge is tested there; this route is just the
// path-safety guard, same as /api/note).
function noteLogRoute({ res, url }: Ctx): void {
  const rel = url.searchParams.get("path") ?? "";
  if (!noteFile(rel)) return send(res, 404, "no such note", "text/plain");
  json(res, 200, { path: rel, log: noteLog(ROOT, rel) });
}

// What has been ASKED about one note (#50's note-side half): every queue
// message naming it, by reference id or by path — refs carry both vocabularies,
// so both are offered. Deliberately unfiltered by kind: the route reports
// what the ledger holds and the view decides what to show, so a later
// panel wanting arrivals or repairs needs no server change. The note need
// not still exist on disk, since a retired reference's directives are still
// the record of why the dossiers citing it say what they say — so this one
// asks for a browse-root `.md` PATH, not a file, which is the half of
// noteFile's question it can answer.
function noteMessages({ res, url }: Ctx): void {
  const rel = url.searchParams.get("path") ?? "";
  const real = within(rel);
  if (!real || !rel.endsWith(".md")) return send(res, 404, "no such note", "text/plain");
  let id: string | undefined;
  try {
    const env = envelopeOrSniff(readFileSync(real, "utf8").slice(0, 4096), ["id"]);
    id = typeof env.id === "string" ? env.id.trim() : undefined;
  } catch {
    /* unreadable/gone — the path alone still finds path-keyed refs */
  }
  const entries = sortFrozenDesc(frozenMessagesForRefs(ROOT, [rel, ...(id ? [id] : [])]));
  const legacy = entries.map((e) => ({ state: e.state, path: e.path, ...e.message }));
  // Voice arrivals about this note (#521) ride beside the legacy queue
  // rows in the same wire shape — `guidance` makes messageKind say
  // "directive", `state`/`outcome` are the work-view's settledness.
  const voice = id ? voiceMessagesFor(ROOT, [id]) : [];
  const messages = [...legacy, ...voice].sort((a, b) =>
    ((b as { enqueued?: string }).enqueued ?? "").localeCompare(
      (a as { enqueued?: string }).enqueued ?? ""
    )
  );
  json(res, 200, { path: rel, id, messages });
}

// ── credentials: what is connected, and the browser pairing code (#486) ──
// Served on every host, not just under the app: a headless viewer over
// `ssh -L` pairs a browser the same way. The list is the token store with
// its hashes left out — each card picks its own rows by `via`.
function tokens({ res }: Ctx): void {
  json(res, 200, { tokens: listTokens(tokenStorePath(ROOT)).map(({ sha256: _sha, ...t }) => t) });
}

function revoke(ctx: Ctx): void {
  jsonPost<{ id?: unknown }>(
    ctx,
    (body) => {
      if (typeof body.id !== "string" || !body.id) return json(ctx.res, 400, { error: "id is required" });
      if (!revokeToken(tokenStorePath(ROOT), body.id)) return json(ctx.res, 404, { error: "no such credential" });
      json(ctx.res, 200, { ok: true });
    },
    { cap: 4096 }
  );
}

// GET: the code outstanding (the card re-shows it after a trip to the
// browser); POST: a fresh one. Where the browser should point is the
// API this engine binds — the same base the plugin's credential is
// saved under.
function pair({ req, res }: Ctx): void {
  json(res, 200, {
    endpoint: API_BASE,
    pending: req.method === "POST" ? mintPairCode(ROOT) : pendingPair(ROOT),
  });
}

// (the /api/neighbours route died 2026-08-05 with the candidate machinery
// — the note view's neighbourhood panel reads the real /api/graph instead)

// Drag-and-dropped items ride the same intake waist as every other
// integration: the UI composes a complete markdown item (frontmatter
// included — the drop.ts contract; PDFs arrive as text extracted in the
// browser, the client-side capture philosophy of the extension) and this
// route lands it. Every caller here is the host operator: the server binds
// 127.0.0.1, so a request is either this machine's browser or an `ssh -L`
// tunnel, and possession of the host account is the root of trust.
function drop(ctx: Ctx): void {
  jsonPost<{ name?: string; content?: string; attachments?: { name: string; b64: string }[] }>(
    ctx,
    async ({ name, content: raw, attachments }) => {
      if (!raw?.trim()) return json(ctx.res, 400, { error: "empty item" });
      // The one stamp → land → read-back path (lib/landItem.ts), the SAME
      // sequence lib/api.ts's drop door runs: `content` is the pre-stamp
      // payload (the landing dedup identity — an edge-stamped `received`
      // must not make byte-identical redeliveries hash apart), and the
      // receipt's id is the landed reference's own — on a dedup hit, the
      // id of the item already there, which is what a follow-up
      // directive should name (#50).
      const receipt = await landDrop({ root: ROOT, content: raw, attachments });
      json(ctx.res, 200, {
        ...intakeWireReceipt(receipt, name),
        via: "local",
      });
    },
    {
      // Unbounded body (2026-08-06): attachments ride here as base64 and
      // are uncapped by design — the CAS is add-only disk, not git
      // history. The item TEXT stays capped inside lib/intake.ts (413).
      cap: Infinity,
      onError: (e) =>
        json(ctx.res, e instanceof IntakeError && e.code === "too-large" ? 413 : 400, { error: errText(e) }),
    }
  );
}

// The DIRECTIVE door (issue #50). A note typed beside a captured page is
// not record — it is a work order naming what it concerns, so it belongs
// in the queue, not references/. Same identity handling as /api/drop: the
// caller is the host operator, a `person`, which is what makes the
// guidance render verbatim rather than data-framed (the gardener's voice
// grading, #521) — and it is stamped by the SERVER, never claimed by the
// body.
function enqueue(ctx: Ctx): void {
  jsonPost<{ refs?: string[]; guidance?: string }>(ctx, ({ refs, guidance }) => {
    const principal = { from: "web", via: "web", from_kind: "person" as const };
    // Emit → commit → read back the id, one path (lib/landItem.ts) —
    // the same sequence /v1/enqueue runs. The commit is fail-soft
    // (queue.ts's commitDirective): the message is safe on disk and
    // the next queue commit sweeps it. The id is new in this door's
    // answer — additive, the #50 contract the API door always kept.
    const r = landDirective(ROOT, { refs: refs ?? [], ...(guidance ? { guidance } : {}) }, principal, {
      idPrefix: "web",
    });
    json(ctx.res, 200, { path: r.path, id: r.id, via: "local" });
  });
}

// Reported model usage and separate account quota observations.
function usage({ res }: Ctx): void {
  json(res, 200, { providers: providerMonitoring(ROOT) });
}

// The editable configuration surface: integrations + the two pass models.
function configRead({ res }: Ctx): void {
  const manifest = loadManifest(ROOT);
  json(res, 200, {
    integrations: integrationsInfo(ROOT, manifest),
    // one shape for both passes, and the same shape a patch sends back
    curation: manifest.curation ?? null,
    gardener: manifest.gardener,
    // `interval` is the manifest's number (memory.interval parsed, the 1d
    // default applied) — the agents card says when the pass runs from it,
    // instead of a constant that was wrong for any vault off the default
    memory: { ...manifest.memory, interval: manifest.memory.intervalMs },
    quick: manifest.quick,
  });
}

// The live stream: held open per tab; the vault watcher writes the pings.
function events({ req, res }: Ctx): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write(`event: vault\ndata: ${JSON.stringify(vaultIdentity(ROOT))}\n\n`);
  res.write(": connected\n\n");
  live.addClient(res);
  req.on("close", () => live.removeClient(res));
}

export const ROUTES: readonly Route[] = [
  { method: "GET", path: "/", handler: serveIndex },
  { method: "GET", path: "/assets/*", handler: serveAsset },
  { method: "GET", path: "/api/vault", handler: vaultIndex },
  { method: "GET", path: "/api/notes", handler: noteList },
  { method: "GET", path: "/api/note", handler: noteRead },
  ...noteBriefingRoutes(ROOT),
  ...sourceReadStateRoutes(ROOT, undefined, applicationActions),
  { method: "GET", path: "/api/file", handler: fileRead },
  { method: "GET", path: "/api/recent", handler: recentFeed },
  { method: "GET", path: "/api/search", handler: search },
  { method: "GET", path: "/api/graph", handler: graph },
  { method: "GET", path: "/api/note-log", handler: noteLogRoute },
  { method: "GET", path: "/api/note-messages", handler: noteMessages },
  // Under the desktop app (bin/desktop.ts sets BIGBRAIN_DESKTOP) the
  // viewer carries the setup door (#575): the first-run and settings
  // cards' two acts. A headless host has no such door — there the CLI is
  // the door (`bigbrain init`, `bigbrain connect`) and the cards say so —
  // so these are simply not in the table and 404 like any other path.
  // The same four routes bin/desktop.ts mounts before a vault exists;
  // lib/firstRun.ts owns what they do (#639).
  ...(DESKTOP
    ? setupRoutes({
        root: ROOT,
        state: () => setupState(ROOT),
        apiBase: API_BASE,
        // The pointer has moved and this process has answered; now ask the
        // supervisor to bring the engine up on the new vault — every job,
        // this server included. The reply above is the last thing it says.
        onVault: () => setTimeout(() => process.kill(process.ppid, "SIGUSR2"), 300),
      })
    : setupRoutes({ root: ROOT, state: () => setupState(ROOT), onVault: () => {} }).filter(r => r.path === "/api/agents/models")),
  // settings › diagnostics (#710): the logs and the facts, desktop-only for
  // the same reason — a headless host's operator has the files and a shell.
  ...(DESKTOP
    ? desktopRouteManifest(ROOT, { changes: applicationChanges, actions: applicationActions })
    : isDev() || process.env.NODE_ENV === "test" ? desktopRouteManifest(ROOT, { includeSupport: false, changes: applicationChanges, actions: applicationActions }) : []),
  // settings › themes: this machine's own skins (~/.config/bigbrain/themes),
  // desktop-only for the same reason again — the folder is on the machine
  // the app runs on, and the acts open it there.
  // the note view's OPEN (⌘O) on a source whose origin is a file: the
  // original, out of the CAS and into the OS's reader — on this machine,
  // so desktop-only once more (lib/sourceOpen.ts)
  // Pilot and persistent work sessions are desktop-only controls over this
  // user's local vault.
  // Keep the complete desktop control surface available to the browser
  // harness as well. Production/headless servers still omit machine-local
  // controls; tests opt in so the route manifest cannot silently lose them.
  { method: "GET", path: "/api/tokens", handler: tokens },
  { method: "POST", path: "/api/tokens/revoke", handler: revoke },
  { method: "GET", path: "/api/pair", handler: pair },
  { method: "POST", path: "/api/pair", handler: pair },
  { method: "POST", path: "/api/drop", handler: drop },
  { method: "POST", path: "/api/enqueue", handler: enqueue },
  { method: "GET", path: "/api/usage", handler: usage },
  // Who am I: the desktop shell asks before attaching to an engine that
  // already answers on its ports (desktop/src-tauri/src/lib.rs).
  { method: "GET", path: "/api/engine", handler: ({ res }) => json(res, 200, engineIdentity()) },
  // entity folds (#728): the memory pass's proposals against today's
  // record, and the operator's accept (an alias) and reject (remembered)
  ...foldsRoutes(ROOT),
  { method: "GET", path: "/api/config", handler: configRead },
  { method: "POST", path: "/api/config", handler: ({ req, res }) => void handleConfigSave(req, res) },
  { method: "GET", path: "/api/events", handler: events },
];

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  if (dispatch(ROUTES, req, res)) return;
  send(res, 404, "not found", "text/plain");
}

/** Bind and serve. Everything above is declaration; this is the one place a
 * socket opens, so `import web/server.ts` in a test costs nothing (#260). */
export function start(): void {
  live.start();
  // Cold projection recovery happens HERE, off the request path (#456): a
  // fresh process against a native vault syncs once at boot, so the first
  // interactive search never carries the catch-up. Sync is incremental —
  // current projection, ~milliseconds — and best-effort: a damaged event
  // file must not keep the whole viewer down, and search's own freshen
  // will surface the error in its bounded failure posture instead.
  if (hasAssertionEvents(ROOT)) {
    try {
      const t0 = performance.now();
      syncAssertionProjection(ROOT);
      console.error(`assertion projection warm in ${Math.round(performance.now() - t0)}ms`);
    } catch (error) {
      console.error(`assertion projection warm-up failed: ${errText(error)}`);
    }
  }
  // The last line of defense, not a route posture: a throw that escapes
  // handleRequest reaches node:http as an uncaughtException and takes the
  // whole PROCESS down — under the supervisor's restart that is a crash
  // loop, one bad request repeated by every page load. It is reachable:
  // the assertion gates read their logs tolerantly, but the surfaces behind
  // them read strictly (recentFromSourceLog strict-reads insertions), so a
  // HALF-ported vault — one valid assertion plus one damaged event file —
  // answers the gate and then throws in the route. Routes with a specific
  // failure posture (graph, search, config) keep their own catches; this
  // backstop turns everything else into the request's 500, never the
  // server's death.
  const metrics = isDesktop() ? telemetry(ROOT) : undefined;
  metrics?.start();
  const server = createServer(async (req, res) => {
    armor(res);
    if (!allowLoopbackRequest(req, res)) return;
    if (await sharedWorkspace(req, res)) return;
    if (!allowVaultRequest(req, res, vaultIdentity(ROOT))) return;
    const path = (req.url ?? "").split("?")[0] ?? "";
    const reads: Partial<Record<string, Operation>> = { "/api/search": "search", "/api/graph": "graph", "/api/note": "note" };
    const operation = req.method === "GET" ? reads[path] : req.method === "POST" && path === "/api/pilot/chat/send" ? "pilot_submit" : undefined;
    if (operation && metrics) { const finish = metrics.begin(operation); res.once("finish", () => finish(res.statusCode < 400)); }
    try {
      handleRequest(req, res);
    } catch (error) {
      console.error(`route ${req.url}: ${errText(error)}`);
      if (res.headersSent) return res.destroy();
      send(res, 500, JSON.stringify({ error: errText(error) }));
    }
  });
  server.requestTimeout = 0; // never reap the held-open SSE connections
  // Under the desktop app: go when the supervisor goes (#597), rather than
  // hold the port and show a vault nothing is tending. Run by hand there
  // is no supervisor pid and this watches nothing.
  dieWithSupervisor("web");
  // localhost only: this server carries a write route now (POST /api/config),
  // so it must not be reachable from the network.
  server.listen(PORT, "127.0.0.1", () => {
    console.error(`BigBrain web on http://localhost:${PORT} (vault: ${ROOT})`);
  });
}

// `bun web/server.ts` (package.json web, bin/cli.ts, the supervisor
// units) runs this file as the entrypoint; an import never trips it.
if (import.meta.main) start();
