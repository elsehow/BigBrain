import { jobProfile } from "./jobProfiles";
/** Capabilities for background model jobs. File access is mediated here, never
 * delegated to a general shell. The same curation validators back every provider. */
import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../fsx";
import { VAULT_TOOLS, handleVaultTool } from "../vaultTools";
import { listAssertions, syncAssertionProjection, tallyAssertionEntities } from "../assertionProjection";
import { isSourceInsertionPath, readSourceInsertionPath } from "../sourceFeed";
import { readIntake } from "../work";
import { MEMORY_ROLE } from "../memory";
import { readSharedMemory, sharedCite, sharedSourcePath } from "../sharedMemory";
import { readConnections, connectionStorePath, sharedRequest } from "../sharedConnections";
import { norm } from "../ids";

export interface RunTool { name: string; description: string; inputSchema: Record<string, unknown>; call(args: Record<string, any>): unknown | Promise<unknown> }
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = { type: "string" };
/** Reject traversal and every symlink component, including a symlinked memory directory. */
export function machinePath(root: string, path: unknown, write = false): string {
  if (typeof path !== "string" || !/^(memory|log|projection|entities|references)(\/[A-Za-z0-9_./-]+)?$/.test(path)) throw new Error("path must name vault content");
  const parts = path.split("/");
  if (parts.some(p => !p || p === "." || p === "..")) throw new Error("invalid path");
  if (write && (parts[0] !== "memory" || !path.endsWith(".md"))) throw new Error("only memory Markdown can be written");
  let full = root;
  for (const part of parts) { full = join(full, part); try { const stat = lstatSync(full); if (stat.isSymbolicLink()) throw new Error("symlink paths are forbidden"); if (stat.isFile() && stat.nlink > 1) throw new Error("hard-linked paths are forbidden"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
  return full;
}
export function machineTools(root: string, role: string, noTools = false, clientName = "pi", edits?: import("../memoryEdits").MemoryEdits): RunTool[] {
  jobProfile(role, noTools ? "none" : role === "tend" || role === "gardener" ? "gardener" : "memory");
  if (noTools) return [];
  if (role === "gardener") role = "tend";
  const names = role === "tend" ? ["next", "open", "submit", "search_vault", "read_note"] : ["search_vault", "read_note", "load_memory"];
  const tools: RunTool[] = VAULT_TOOLS.filter(t => names.includes(t.name)).map(t => ({ ...t, call: args => {
    if (role === "tend" && t.name === "next" && args.kinds === undefined) args = { ...args, kinds: ["intake", "staged"] };
    if (role === "tend" && t.name === "next" && (!Array.isArray(args.kinds) || args.kinds.some((k: string) => !["intake", "staged"].includes(k)))) throw new Error("gardener may request intake and staged work only");
    if (t.name === "read_note") {
      machinePath(root, args.path);
      if (role === "tend" && args.path.startsWith("memory/")) throw new Error("gardener cannot read memory");
      if (role === "tend" && isSourceInsertionPath(args.path)) {
        const insertion = readSourceInsertionPath(root, args.path);
        throw new Error(`Use read_intake with insertion_id ${insertion?.id ?? "from next"} for arrival bodies; its offsets preserve the intake view.`);
      }
    }
    return handleVaultTool({ root, via: "gardener", clientName }, t.name, args);
  } }));
  if (role === "tend") tools.push({
    name: "read_intake",
    description: "Read a landed arrival by insertion_id. Body offsets match next, including user-only conversations. Page prior assertions with neighborhood_start = neighborhood_next until neighborhood_truncated is false. Works after submission too.",
    inputSchema: schema({ insertion_id: str,
      start: { type: "integer", minimum: 0 }, chars: { type: "integer", minimum: 1, maximum: 80_000 },
      neighborhood_start: { type: "integer", minimum: 0 }, neighborhood_limit: { type: "integer", minimum: 1, maximum: 100 },
    }, ["insertion_id"]),
    call: a => readIntake(root, a.insertion_id, a),
  });
  if (role !== MEMORY_ROLE) return tools;
  return [...tools, ...sharedMemoryTools(root),
    { name: "memory_files", description: "List memory Markdown paths and their word counts. Equivalent to measuring memory/**/*.md.", inputSchema: schema({}), call: () => {
      const out: { path: string; words: number }[] = [];
      const walk = (rel: string) => {
        const dir = machinePath(root, rel);
        if (!existsSync(dir)) return;
        for (const f of readdirSync(dir)) {
          const p = `${rel}/${f}`; const full = machinePath(root, p);
          if (lstatSync(full).isDirectory()) walk(p);
          else if (f.endsWith(".md")) out.push({ path: p, words: readFileSync(full, "utf8").split(/\s+/).filter(Boolean).length });
        }
      };
      walk("memory");
      return out;
    } },
    { name: "read_file", description: "Read vault content by relative path. Returns a bounded character window.", inputSchema: schema({ path: str, start: { type: "integer" }, chars: { type: "integer" } }, ["path"]), call: a => {
      const text = readFileSync(machinePath(root, a.path), "utf8"); const start = Math.max(0, Number(a.start) || 0); const chars = Math.max(1, Math.min(80_000, Number(a.chars) || 40_000));
      return { text: text.slice(start, start + chars), length: text.length, start, truncated: start + chars < text.length };
    } },
    { name: "write_memory", description: "Replace one memory Markdown file with its complete content.", inputSchema: schema({ path: str, content: str }, ["path", "content"]), call: a => {
      const path = machinePath(root, a.path, true);
      if (typeof a.content !== "string" || a.content.length > 100_000) throw new Error("content must be text under 100,000 characters");
      if (edits) edits.capture([a.path], () => writeAtomic(path, a.content)); else writeAtomic(path, a.content); return { written: a.path };
    } },
    { name: "delete_memory", description: "Remove a memory Markdown file after merging or pruning it.", inputSchema: schema({ path: str }, ["path"]), call: a => { const p = machinePath(root, a.path, true); const remove = () => { if (existsSync(p)) unlinkSync(p); }; if (edits) edits.capture([a.path], remove); else remove(); return { deleted: a.path }; } },
    { name: "assertions", description: "The bigbrain assertions command: survey the live record by content date, entity, or entity tally.", inputSchema: schema({ since: str, until: str, entity: str, entities: { type: "boolean" }, limit: { type: "integer" } }), call: a => {
      syncAssertionProjection(root);
      if (a.entities) return tallyAssertionEntities(root);
      for (const key of ["since", "until"]) if (a[key] !== undefined && (typeof a[key] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(a[key]))) throw new Error(`${key} must be YYYY-MM-DD`);
      const limit = Math.max(1, Math.min(500, Number(a.limit) || 200));
      const rows = listAssertions(root, { since: a.since, until: a.until, entity: a.entity, limit: limit + 1 });
      return { assertions: rows.slice(0, limit), truncated: rows.length > limit, limit };
    } },
  ];
}

/** Memory folds every vault the user can read (lib/sharedMemory.ts). These
 * two reach the joined shared vaults: their claims from the run's cache,
 * and a cited source's text over the connection. Offered only once a vault
 * is joined, so a personal-only run sees exactly the tools it always had. */
function sharedMemoryTools(root: string): RunTool[] {
  if (!readSharedMemory(root).vaults.length) return [];
  return [
    { name: "shared_assertions", description: "Search the live claims of the shared vaults this user joined. Each row's cite is the citation to use: [[shared:<vault>:ast_…]]. Terms must all appear in the text; entity matches a label.",
      inputSchema: schema({ query: str, entity: str, vault: str, limit: { type: "integer" } }), call: a => {
        const terms = typeof a.query === "string" ? norm(a.query).split(" ").filter(Boolean) : [];
        const entity = typeof a.entity === "string" && a.entity.trim() ? norm(a.entity) : null;
        const limit = Math.max(1, Math.min(200, Number(a.limit) || 50));
        const rows = readSharedMemory(root).vaults.filter(v => !a.vault || v.id === a.vault || v.name === a.vault).flatMap(v => v.assertions
          .filter(x => !x.revoked && terms.every(t => norm(x.text).includes(t)) && (!entity || x.entities.some(e => norm(e.label) === entity)))
          .map(x => ({ cite: sharedCite(v.id, x.id), vault: v.name, text: x.text, confidence: x.confidence, created_at: x.created_at,
            author: `${x.author.kind} ${x.author.id}`, sources: x.sources.map(id => ({ path: sharedSourcePath(v.id, id), title: v.titles[id] ?? id })) })))
          .sort((x, y) => y.created_at.localeCompare(x.created_at));
        return { assertions: rows.slice(0, limit), truncated: rows.length > limit, limit };
      } },
    { name: "read_shared_source", description: "Read a joined shared vault's source by the path shared_assertions gives (shared/<vault>/ins_….md). Returns a bounded character window.",
      inputSchema: schema({ path: str, start: { type: "integer" }, chars: { type: "integer" } }, ["path"]), call: async a => {
        const m = typeof a.path === "string" ? /^shared\/([A-Za-z0-9-]+)\/(ins_[a-f0-9]{24})\.md$/.exec(a.path) : null;
        if (!m) throw new Error("path must be shared/<vault>/ins_<id>.md");
        const connection = readConnections(connectionStorePath()).find(c => c.id === m[1]);
        if (!connection) throw new Error("that shared vault is no longer joined");
        const source = await sharedRequest<{ title: string; body: string; envelope?: Record<string, unknown> }>(connection, `/v1/evidence/${m[2]}`);
        const start = Math.max(0, Number(a.start) || 0), chars = Math.max(1, Math.min(80_000, Number(a.chars) || 40_000));
        return { title: source.title, from: source.envelope?.["from"] ?? null, text: source.body.slice(start, start + chars), length: source.body.length, start, truncated: start + chars < source.body.length };
      } },
  ];
}
