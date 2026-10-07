/** agentReads.ts — vault and live content as an agent receives it.
 *
 * The one helper every door that hands an agent vault or integration content
 * goes through: MCP clients (lib/mcp.ts), Pilot and the coding desktops'
 * host tools (lib/pilot.ts), and project workers (bin/workMcp.ts), by way of
 * lib/vaultTools.ts and lib/integrationTools.ts. The gardener and the memory
 * pass read the record raw. Each item gains a `provenance`
 * (lib/provenance.ts); untrusted text has sign-in material withheld
 * (lib/credentialScreen.ts) and is fenced as data; memory's outside claims
 * are fenced one by one (lib/memoryProvenance.ts); sign-in mail received in
 * the last ten minutes is headers only. Fields are only ever added, so a
 * client that read a result before reads it the same way now. */
import { normalize } from "node:path";
import { projectedSourceMetadata } from "./assertionProjection";
import { screenCredentials, signInMail } from "./credentialScreen";
import { memoryForAgents, memoryHasOutside } from "./memoryProvenance";
import { jailMemoryNotePath, jailPath } from "./noteRead";
import { readNoteFile, resolveNote } from "./noteResolution";
import { fenceAbout, fenceUntrusted, sender, sourceProvenance, sourceTrusted, originOf, type OriginKind, type Provenance } from "./provenance";
import { isSourceInsertionPath } from "./sourceFeed";

export { memoryForAgents } from "./memoryProvenance";

/** Sign-in mail younger than this reaches agents as headers only: it is when
 * a code or link in it is live. Other mail, and the person's own viewer, are
 * unaffected. */
export const FRESH_MAIL_MS = 10 * 60_000;

const where = (kind: OriginKind): string => kind === "email" ? "open in Mail" : kind === "granola" ? "open in Granola" : "open the original";

/** A path's provenance, decided from the record (the trust rule is lib/provenance.ts's). */
export function provenanceOf(root: string, path: string): Provenance {
  const p = normalize(path);
  const r = resolveNote(root, p, { sessions: true, markdown: rel => {
    const abs = rel.endsWith(".md") && (jailMemoryNotePath(root, rel) ?? jailPath(root, rel));
    return abs ? readNoteFile(root, abs) : undefined;
  } });
  if (!r) return { kind: p.startsWith("memory/") ? "memory" : /^(?:projection\/)?entities\//u.test(p) ? "entity" : isSourceInsertionPath(p) ? "source" : "note", trusted: false, path: p };
  if (r.kind === "source") return sourceProvenance(r.source, r.path);
  if (r.kind === "thread") {
    const latest = sourceProvenance(r.thread.members[0]!, r.path);
    return { ...latest, trusted: r.thread.members.every(m => sourceTrusted(m.envelope)) };
  }
  if (r.kind === "session") return { kind: "agent", trusted: false, path: p, ...(r.session.updated ? { updated: r.session.updated } : {}) };
  if (r.kind === "entity") {
    const claims = r.entity.assertions;
    const metas = projectedSourceMetadata(root, claims.flatMap(a => a.sources.map(s => s.insertion_id)));
    const trusted = claims.length > 0 && claims.every(a => !a.vault && a.sources.length > 0 && a.sources.every(s => {
      const m = metas.get(s.insertion_id);
      return !!m && sourceTrusted(m.envelope);
    }));
    const updated = claims.map(a => a.created_at).sort().at(-1);
    return { kind: "entity", trusted, path: r.path, ...(updated ? { updated } : {}) };
  }
  const { envelope, body, mtime } = r.markdown;
  const at = mtime ? { updated: mtime } : {};
  if (p.startsWith("memory/")) return { kind: "memory", trusted: !memoryHasOutside(body), path: p, ...at };
  if (p.startsWith("entities/")) return { kind: "entity", trusted: false, path: p, ...at };
  if (p.startsWith("journal/")) return { kind: "note", trusted: false, path: p, ...at };
  const env = envelope as Record<string, unknown>;
  const kind = originOf(env), from = sender(env["from"]);
  return { kind: p.startsWith("inbox/unsorted/") ? "drop" : kind === "source" ? "note" : kind, trusted: sourceTrusted(env),
    ...(from ? { from } : {}), ...(typeof env["received"] === "string" ? { received: env["received"] } : {}), path: p, ...at };
}

const insertionOf = (path: string): string | undefined => isSourceInsertionPath(path) ? /(ins_[a-f0-9]{24})\.json$/u.exec(path)?.[1] : undefined;

/** Provenance for many paths at once: sources from the projection's headers, the rest one by one. */
export function provenanceOfPaths(root: string, paths: string[]): Map<string, Provenance> {
  const metas = projectedSourceMetadata(root, paths.map(insertionOf).filter((id): id is string => !!id));
  return new Map(paths.map(p => {
    const m = metas.get(insertionOf(p) ?? "");
    return [p, m ? sourceProvenance(m, p) : provenanceOf(root, p)];
  }));
}

/** A note as an agent reads it. Untrusted text has sign-in material withheld
 * and is fenced after `slice` windows it, so offsets count the text inside
 * the fence; memory has its outside claims fenced before. */
export function noteForAgent<T extends { markdown: string; title?: unknown }>(root: string, rel: string, note: T, slice: (note: T) => T): T & { provenance: Provenance } {
  const provenance = provenanceOf(root, rel);
  if (provenance.kind === "memory") return { ...slice({ ...note, markdown: memoryForAgents(note.markdown) }), provenance };
  if (provenance.trusted) return { ...slice(note), provenance };
  const at = { where: where(provenance.kind) }, raw = typeof note.title === "string" ? note.title : undefined;
  const sliced = slice({ ...note, markdown: screenCredentials(note.markdown, { ...at, context: raw ?? "" }).text });
  const title = raw === undefined ? undefined : screenCredentials(raw, at).text;
  return { ...sliced, ...(title !== undefined ? { title } : {}), markdown: fenceUntrusted(fenceAbout(provenance, title), sliced.markdown), provenance };
}

/** Listing rows (search hits, recent arrivals) as an agent reads them:
 * provenance on each, and an untrusted row's title and snippet screened, its
 * snippet fenced. */
export function rowsForAgent<T extends { path: string; title?: string; snippet?: string }>(root: string, rows: T[]): (T & { provenance: Provenance })[] {
  const known = provenanceOfPaths(root, rows.map(r => r.path));
  return rows.map(r => {
    const provenance = known.get(r.path)!;
    if (provenance.trusted) return { ...r, provenance };
    const at = { where: where(provenance.kind), context: r.title ?? "" };
    return { ...r, provenance,
      ...(r.title !== undefined ? { title: screenCredentials(r.title, at).text } : {}),
      ...(r.snippet !== undefined ? { snippet: fenceUntrusted({}, screenCredentials(r.snippet, at).text, true) } : {}) };
  });
}

// ── live integrations ──────────────────────────────────────────────────────

type Address = { name?: string; address?: string };
type Mail = Record<string, unknown> & { subject?: unknown; from?: unknown; date?: unknown; received?: unknown; body?: unknown; uid?: unknown; ref?: unknown };

const addresses = (v: unknown): string | undefined => Array.isArray(v)
  ? sender((v as Address[]).map(a => a?.name && a?.address ? `${a.name} <${a.address}>` : a?.address ?? a?.name ?? "").filter(Boolean).join(", "))
  : sender(v);
const mailboxes = (v: unknown): string[] => Array.isArray(v) ? (v as Address[]).flatMap(a => typeof a?.address === "string" ? [a.address] : [])
  : typeof v === "string" ? [...v.matchAll(/[\w.+-]+@[\w.-]+/gu)].map(x => x[0]) : [];

/** One message as an agent reads it: headers only while it is fresh sign-in
 * mail, else its body screened and fenced. Its subject is screened either way. */
function mailForAgent(m: Mail, now: number, ref?: string): Mail {
  const at = typeof m.received === "string" ? m.received : typeof m.date === "string" ? m.date : undefined;
  const from = addresses(m.from), mailed = { where: where("email") };
  const provenance: Provenance = { kind: "email", trusted: false, ...(from ? { from } : {}),
    ...(at ? { received: at } : {}), ...(typeof m.ref === "string" ? { ref: m.ref } : ref ? { ref } : {}) };
  const said = typeof m.subject === "string" ? m.subject : undefined, text = typeof m.body === "string" ? m.body : undefined;
  const subject = said === undefined ? m.subject : screenCredentials(said, mailed).text;
  const time = at ? Date.parse(at) : NaN;
  // an unknown receipt time counts as fresh
  const fresh = !(time <= now - FRESH_MAIL_MS);
  if (fresh && signInMail({ from: mailboxes(m.from), subject: said, preheader: text })) {
    const until = Number.isFinite(time) ? ` Read it again after ${new Date(time + FRESH_MAIL_MS).toISOString()}, or ask your person to open it in Mail.` : " Your person can open it in Mail.";
    return { uid: m.uid, ...(m.ref !== undefined ? { ref: m.ref } : {}), from: m.from, subject, date: m.date ?? null, provenance,
      held: `Sign-in mail received under ${FRESH_MAIL_MS / 60_000} minutes ago, while any code or link in it is live: shown by sender, subject and date only.${until}` };
  }
  if (text === undefined) return { ...m, subject, provenance };
  const body = screenCredentials(text, { ...mailed, context: said ?? "" });
  return { ...m, subject, provenance, body: fenceUntrusted(fenceAbout(provenance), body.text) };
}

/** Screen every string in a structured value. */
function screenDeep(v: unknown, at: { where: string }): unknown {
  if (typeof v === "string") return screenCredentials(v, at).text;
  if (Array.isArray(v)) return v.map(x => screenDeep(x, at));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, screenDeep(x, at)]));
  return v;
}

/** The origin a live read tool's results come from, or undefined for one that returns no content. */
export const liveOrigin = (name: string): OriginKind | undefined =>
  ["inbox_list", "inbox_read", "email_search", "email_read"].includes(name) ? "email" : name === "granola_read" ? "granola" : undefined;

/** A live integration read's result as an agent receives it. */
export function liveForAgent(name: string, result: unknown, now = Date.now()): unknown {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return result;
  if (name === "inbox_read" || name === "email_read") {
    const ref = typeof r.ref === "string" ? r.ref : undefined;
    return { ...r,
      ...(r.selected && typeof r.selected === "object" ? { selected: mailForAgent(r.selected as Mail, now, ref) } : {}),
      ...(Array.isArray(r.thread) ? { thread: (r.thread as Mail[]).map(m => mailForAgent(m, now)) } : {}) };
  }
  if ((name === "inbox_list" || name === "email_search") && Array.isArray(r.messages))
    return { ...r, messages: (r.messages as Mail[]).map(m => mailForAgent(m, now)) };
  if (name === "granola_read") {
    const at = { where: where("granola") };
    return { ...r,
      ...(Array.isArray(r.content) ? { content: (r.content as Array<Record<string, unknown>>).map(c => c?.type === "text" && typeof c.text === "string"
        ? { ...c, text: fenceUntrusted({ kind: "granola" }, screenCredentials(c.text, at).text) } : c) } : {}),
      ...(r.structuredContent !== undefined ? { structuredContent: screenDeep(r.structuredContent, at) } : {}) };
  }
  return result;
}
