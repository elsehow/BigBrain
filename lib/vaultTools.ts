/** Shared vault tool schemas and operations. Transports and runtime adapters select capabilities. */
import { parseNoteWindow, NoteWindowError, ENTITY_WINDOW_CAP, SLACK_CAP, type NoteWindow } from "./noteWindow";
import { landDrop } from "./landItem";
import { attachmentPayload, memoryRead, notePayload, type AttachmentPayload, type NotePayload } from "./noteRead";
import { recordUse, type RetrievalVia } from "./retrieval";
import type { ScanReader } from "./scanReader";
import { clampLimit, scanSurface, type SearchFilters } from "./searchCore";
import { fmBody, fmRaw, fmSerialize } from "./wire";
import { openStaged } from "./stage";
import { nextWork, submitWire, WORK_BATCH_LIMIT, WORK_KINDS, type WorkKind } from "./work";
import { memoryForAgents, noteForAgent, rowsForAgent } from "./agentReads";

/** A tool-level refusal the transport should mark `isError` — the message
 * is for the calling model, so it says what would work. */
export class VaultToolError extends Error {}

export interface VaultToolContext {
  /** The vault root every tool reads and writes. */
  root: string;
  /** "cli" for interactive clients; "gardener" for the tend runner. */
  via: RetrievalVia;
  /** Host-selected author name. Public MCP uses the verified credential,
   * never the initialize handshake or tool arguments. */
  clientName?: string;
  /** Host-selected provenance; never accepted from tool arguments. */
  source?: "mcp" | "pilot";
  /** Host-lent: reads a scanned PDF attachment with the host's model (lib/scanReader.ts). */
  readScan?: ScanReader;
}

/** One tool: MCP wire fields plus the handler. Schemas are hand-written
 * JSON Schema literals — one source, measurable against the budget. */
export interface VaultToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (ctx: VaultToolContext, args: Record<string, unknown>) => unknown | Promise<unknown>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function searchTool(ctx: VaultToolContext, args: Record<string, unknown>): unknown {
  let q = str(args["query"]).trim();
  if (args["queries"] !== undefined) {
    const queries = args["queries"];
    if (q || !Array.isArray(queries) || !queries.length || queries.length > 8 ||
      !queries.every(v => typeof v === "string" && v.trim()))
      throw new VaultToolError("Use query OR queries (1–8 nonempty alternative strings), not both.");
    q = queries.join(" OR ");
  }
  if (!q) throw new VaultToolError("missing query");
  const filters: SearchFilters = {};
  const source = str(args["source"]).trim().toLowerCase();
  if (source) filters.source = source;
  for (const name of ["after", "before"] as const) {
    const v = str(args[name]).trim();
    if (v && !DAY.test(v)) throw new VaultToolError(`bad ${name} "${v}" — use YYYY-MM-DD`);
    if (v) filters[name] = v;
  }
  const type = str(args["type"]).trim();
  if (type && type !== "reference" && type !== "entity")
    throw new VaultToolError(`bad type "${type}" — use reference or entity`);
  if (type) filters.type = type as "reference" | "entity";
  const n = clampLimit(args["n"] === undefined ? null : String(args["n"]), 20);
  const r = scanSurface(ctx.root, q, n, ctx.via, { now: new Date(), filters });
  if (!r.ok) throw new VaultToolError(r.reason);
  // The gardener reads the record raw; every other reader is an agent (lib/agentReads.ts).
  const hits = ctx.via === "gardener" ? r.hits : rowsForAgent(ctx.root, r.hits);
  return { hits, relaxation: r.relaxation, applied_filters: r.applied_filters, only_agent_records: r.only_agent_records };
}

const NOTE_CHARS_DEFAULT = 40_000;
const NOTE_CHARS_MAX = 80_000;

/** The pi source tool's chunk contract, restored (#514 parity run): a huge
 * note is sliced with an honest length, never silently clipped by the
 * transport — the caller pages with start/chars. */
function sliceNote<T extends { markdown: string }>(note: T, args: Record<string, unknown>): T {
  const md = note.markdown;
  const start = Math.min(Math.max(0, Math.trunc(Number(args["start"]) || 0)), md.length);
  const chars = Math.min(Math.max(1, Math.trunc(Number(args["chars"]) || NOTE_CHARS_DEFAULT)), NOTE_CHARS_MAX);
  if (start === 0 && md.length <= chars) return note;
  const end = Math.min(md.length, start + chars);
  return { ...note, markdown: md.slice(start, end), markdown_length: md.length, start, end, truncated: end < md.length };
}

function readNoteTool(ctx: VaultToolContext, args: Record<string, unknown>): unknown {
  let window: NoteWindow;
  try { window = parseNoteWindow(args); }
  catch (error) {
    if (error instanceof NoteWindowError) throw new VaultToolError(error.message);
    throw error;
  }
  const path = str(args["path"]), attachment = str(args["attachment"]).trim();
  // A promise for an attachment: its PDF's text is extracted as it is read.
  if (attachment) return attachmentPayload(ctx.root, path, attachment, window, ctx.readScan).then(p => served(ctx, p, args));
  return served(ctx, notePayload(ctx.root, path, window), args);
}

/** A read as its caller receives it: recorded, sliced, and for agents fenced by provenance. */
function served(ctx: VaultToolContext, p: NotePayload | AttachmentPayload, args: Record<string, unknown>): unknown {
  if (p.status !== 200) throw new VaultToolError(p.error);
  recordUse(ctx.root, p.rel, ctx.via);
  if (ctx.via === "gardener") return sliceNote(p.note, args);
  return noteForAgent(ctx.root, p.rel, p.note, note => sliceNote(note, args));
}

function loadMemoryTool(ctx: VaultToolContext): unknown {
  const r = memoryRead(ctx.root);
  if (r.status !== 200)
    throw new VaultToolError(r.status === 404 ? "no such memory file" : "forbidden path");
  return ctx.via === "gardener" ? r.text : memoryForAgents(r.text);
}

function dropTool(ctx: VaultToolContext, args: Record<string, unknown>): unknown {
  const title = str(args["title"]).trim();
  const body = str(args["body"]);
  if (!title) throw new VaultToolError("missing title");
  if (!body.trim()) throw new VaultToolError("missing body");
  const kind = str(args["kind"]).trim() || "note";
  // Frontmatter is composed HERE — the caller never declares `type:` or any
  // other curated field (the #87 contract, same as `bigbrain drop`).
  const fm = fmSerialize([
    ["source", fmRaw(ctx.source ?? "mcp")],
    ["from", ctx.clientName?.trim() || "mcp-client"],
    ["from_kind", fmRaw("agent")],
    ["kind", kind],
    ["title", title],
    ["date", fmRaw(new Date().toISOString())],
  ]);
  const content = fmBody(fm, body);
  // A promise: the landing may extract a PDF's text layer (lib/pdfText.ts).
  // Validation above still throws in place.
  return landDrop({ root: ctx.root, content }).then((receipt) => ({
    id: receipt.id,
    path: receipt.path,
    ref_path: receipt.path,
  }));
}

const KINDS = new Set<string>(WORK_KINDS);

function nextTool(ctx: VaultToolContext, args: Record<string, unknown>): unknown {
  const kindsRaw = Array.isArray(args["kinds"]) ? args["kinds"].map(String) : undefined;
  if (kindsRaw)
    for (const k of kindsRaw)
      if (!KINDS.has(k)) throw new VaultToolError(`bad kind "${k}" — use ${WORK_KINDS.join(", ")}`);
  const limit = args["limit"] === undefined ? undefined : Number(args["limit"]);
  try {
    return nextWork(ctx.root, {
      ...(kindsRaw ? { kinds: kindsRaw as WorkKind[] } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  } catch (error) {
    throw new VaultToolError(error instanceof Error ? error.message : String(error));
  }
}

/** A staged arrival's body (#744) — the head came with `next`; this is the
 * follow-up, asked for only when the head does not settle it. */
function openTool(ctx: VaultToolContext, args: Record<string, unknown>): unknown {
  const ids = Array.isArray(args["ids"]) ? args["ids"].map(String).filter(Boolean) : [];
  if (!ids.length) throw new VaultToolError("missing ids");
  if (ids.length > 20) throw new VaultToolError("open at most 20 at a time");
  return openStaged(ctx.root, ids);
}

function submitTool(ctx: VaultToolContext, args: Record<string, unknown>): unknown {
  const raw = args["items"];
  try {
    // The one wire→log pipeline (lib/work.ts submitWire — the HTTP door
    // runs the same function, so a rejection is word-for-word the same):
    // canonicalize each assertion's [[links]] host-side, validate and
    // append per item, dedupe retries by content-hash identity.
    return submitWire(ctx.root, raw, {
      // A STABLE invocation id, not a per-call one: the event's identity
      // hash covers author and produced_by, and a retried submission must
      // converge on the prior event (#520's idempotency story). The log
      // requires model authors to carry one, so it names the door; run
      // attribution is the journal's job (#514), not the event's.
      author: { kind: "model", id: ctx.clientName || "mcp-client", invocation_id: "mcp" },
      produced_by: { procedure: "bigbrain-mcp", version: "v1" },
    });
  } catch (error) {
    throw new VaultToolError(error instanceof Error ? error.message : String(error));
  }
}

/** The table. Order is the listing order; keep it stable. */
export const VAULT_TOOLS: VaultToolDef[] = [
  {
    name: "load_memory",
    description:
      "The vault's curated working set: memory/MEMORY.md. Call this first.",
    inputSchema: { type: "object", properties: {} },
    handler: loadMemoryTool,
  },
  {
    name: "search_vault",
    description:
      "Search records and memory. Matches words literally (prefix matching, no synonyms). " +
      "For topical searches, pass `queries` with 3-5 alternative phrasings: synonyms, related terms, " +
      "likely exact titles or names, and shorter keyword forms. Alternatives are ORed. For a lookup " +
      "of a specific named person, project or thing, the name alone is fine. Verify citations in agent records.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        queries: { type: "array", items: { type: "string" }, description: "1–8 alternatives instead of query" },
        source: { type: "string", description: "Connector filter; omit for whole vault." },
        n: { type: "integer", description: "max hits; default 20" },
        after: { type: "string", description: "YYYY-MM-DD" },
        before: { type: "string", description: "YYYY-MM-DD" },
        type: { type: "string", enum: ["reference", "entity"] },
      },
    },
    handler: searchTool,
  },
  {
    name: "read_note",
    description:
      "One note by vault-relative path: frontmatter parsed, wikilinks resolved. " +
      "Big note? Window it with q instead of reading it whole — matching assertions of an " +
      "entity dossier (projection/entities/…), matching paragraphs/turns of anything else. " +
      "toc maps a dossier by date.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        start: { type: "integer", description: "char offset — big notes are sliced" },
        chars: { type: "integer" },
        q: { type: "string", description: "keep what contains every term" },
        slack: { type: "integer", minimum: 0, maximum: SLACK_CAP, description: "non-entity: context blocks each side (default 2)" },
        after: { type: "string", description: "entity only: YYYY-MM-DD, inclusive" },
        before: { type: "string", description: "entity only: YYYY-MM-DD, inclusive" },
        n: { type: "integer", minimum: 1, maximum: ENTITY_WINDOW_CAP, description: "entity only: keep the newest n" },
        order: { type: "string", enum: ["asc", "desc"], description: "entity only: desc = newest first" },
        toc: { type: "boolean", description: "entity only: date-bucketed contents, not the assertions" },
        attachment: { type: "string", description: "a PDF the note links: its name or blob:<sha256>; reads its text instead" },
      },
      required: ["path"],
    },
    handler: readNoteTool,
  },
  {
    name: "drop",
    description: "Save an item into the vault. The host composes the envelope.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string", description: "markdown body" },
        kind: { type: "string", description: "e.g. note, idea, web-clip (default note)" },
      },
      required: ["title", "body"],
    },
    handler: dropTool,
  },
  {
    name: "next",
    description:
      "Due work: intake (arrivals in the record, with context), staged (heads of what pollers found, not yet in the record), memory. Pure read.",
    inputSchema: {
      type: "object",
      properties: {
        kinds: { type: "array", items: { type: "string", enum: [...WORK_KINDS] } },
        limit: { type: "integer", description: `intake: 1-${WORK_BATCH_LIMIT}` },
      },
    },
    handler: nextTool,
  },
  {
    name: "open",
    description: "Bodies of staged arrivals, by id (≤20).",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"],
    },
    handler: openTool,
  },
  {
    name: "submit",
    description:
      "Settle work, per item, idempotent. assertion: a claim with [[label]] or [[ent_id|display]] links, citing insertion ids (ids minted host-side; a label an entity carries or resembles is refused with candidates: link one, or [[new:label]]). decline: settles insertions. admit: lands staged arrivals, answering insertion_ids. pass: lets staged arrivals go.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              submit: { type: "string", enum: ["assertion", "decline", "admit", "pass"] },
              text: { type: "string", description: "assertion: claim with [[links]]" },
              sources: { type: "array", items: { type: "string" }, description: "assertion: insertion ids" },
              confidence: { type: "string", enum: ["direct", "candidate"] },
              insertion_ids: { type: "array", items: { type: "string" }, description: "decline" },
              reason: { type: "string", description: "decline, pass" },
              staged_ids: { type: "array", items: { type: "string" }, description: "admit, pass" },
            },
            required: ["submit"],
          },
        },
      },
      required: ["items"],
    },
    handler: submitTool,
  },
];


/** Internal callers select role capabilities before dispatching. */
export function handleVaultTool(ctx: VaultToolContext, name: string, args: Record<string, unknown> = {}): unknown | Promise<unknown> {
  const tool = VAULT_TOOLS.find(t => t.name === name);
  if (!tool) throw new VaultToolError(`no such tool: ${name}`);
  return tool.handler(ctx, args);
}
