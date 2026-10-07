// Shapes of what the server reads off disk — the queue's ledger and journal
// rows, the vault index, and the editable configuration surface.
//
// NoteMeta, RecentEntry, FilingStatus, QueueState and MessageKind are
// declared ONCE, in ../../../../lib/viewTypes.ts, and imported by both this
// client and web/server.ts (#261). QueueState is imported (not just
// re-exported) because it's also used below, by QueueMessageRow.
import { type QueueState, messageKind } from "../../../../lib/viewTypes";
export type { PilotState, PilotSecret, PilotStatus } from "../../../../lib/pilotTypes";
export type {
  FilingStatus,
  MessageKind,
  NoteMeta,
  QueueState,
  RecentEntry,
} from "../../../../lib/viewTypes";
export { messageKind };

/** Where coding desktops' commands may reach beyond this machine (lib/desktopNetwork.ts). */
export interface DesktopNetwork { defaults: string[]; hosts: string[] }

/** One grounding source of an assertion. `band`/`from`/`via`/`source` are
 * the filed-by facet (lib/assertionEntityView.ts's ProjectedEntitySource) —
 * the same fields a feed row and a graph node carry, so feed.ts's
 * filedByLabel names the same filer here. */
export interface ProjectedEntitySource {
  insertion_id: string;
  source_id: string;
  title: string;
  path: string;
  band?: "person" | "agent" | "service" | "engine";
  from?: string;
  via?: string;
  source?: string;
}

export interface ProjectedEntityAssertion {
  id: string;
  text: string;
  confidence: "direct" | "candidate";
  created_at: string;
  author: { kind: string; id: string; invocation_id?: string };
  sources: ProjectedEntitySource[];
}

export interface ProjectedEntityView {
  id: string;
  label: string;
  assertions: ProjectedEntityAssertion[];
  /** Present when the server truncated `assertions` (`assertions=N` param):
   * how many the record actually holds. */
  total?: number;
  /** This entity is the vault's own user — from the identity record (#501). */
  you?: true;
}

/** One entity an assertion links — the chip a SOURCE note's row wears, and
 * the dossier it opens (lib/assertionEntityView.ts's ProjectedSourceEntity). */
export interface ProjectedSourceEntity {
  id: string;
  label: string;
  path: string;
}

/** ProjectedEntityAssertion's twin for the source note: the meta is the
 * entities, since the grounding source is the page itself. */
/** lib/sourceOrigin.ts's SourceOrigin, verbatim. */
export type SourceOrigin =
  | { kind: "url"; url: string }
  | { kind: "file"; name: string; sha256: string; mime: string; bytes: number }
  | { kind: "note"; name: string };

export interface ProjectedSourceAssertion {
  id: string;
  text: string;
  confidence: "direct" | "candidate";
  created_at: string;
  author: { kind: string; id: string; invocation_id?: string };
  entities: ProjectedSourceEntity[];
}

/** GET /api/note — every note kind answers this shape; `projectedEntity`
 * only on projection/entities/ paths, `sourceAssertions` only on
 * log/insertions/ paths. */
export interface NoteResult {
  sourceThread?: { title: string; messages: Array<{ path: string; title: string; from?: string; at?: string }> };
  path: string;
  content: string;
  projectedEntity?: ProjectedEntityView;
  /** The assertions grounded in this source, whole and in log order —
   * present (possibly empty) on every source insertion. */
  sourceAssertions?: ProjectedSourceAssertion[];
  /** Where the source lives outside the vault (lib/sourceOrigin.ts) — the
   * page it was clipped from, the original file a drop carried. Present
   * on every source insertion, null when it has none; absent elsewhere. */
  origin?: SourceOrigin | null;
  /** An agent wrote this source (lib/sourceFeed.ts agentWritten). Present on
   * every source insertion; the viewer loads remote images unasked only
   * where it is false. */
  byAgent?: boolean;
  /** The note's own date (frontmatter ladder, else the filename's prefix,
   * else the file's mtime) — the timestamp under its title. Absent on a
   * projected entity or a source insertion, which have no file. */
  modified?: number;
}

// One row of the queue view (GET /api/queue) — a typed work message, wherever
// it currently sits in queue/{pending,running,done,failed}/ (lib/queue.ts).
// Phase 5 (2026-08-05): verbs and capabilities died — a message is refs +
// optional guidance (a mind's intent) or facts (runner-computed).
export interface QueueMessageRow {
  state: QueueState;
  path: string; // vault-relative, queue/<state>/<id>.yaml
  id: string;
  refs: string[]; // reference ids (arrivals) or vault-relative paths (dossiers)
  guidance?: string;
  facts?: Record<string, unknown>;
  from: string;
  via: string;
  from_kind?: "person" | "agent";
  enqueued: string;
  finished?: string;
  run?: string;
  outcome?: string;
  error?: string;
  attempts?: number;
}

// The link graph (GET /api/graph): nodes are notes under the view tree,
// edges are resolved wikilinks. `id` is the vault-relative path (click →
// open). `group` is the substrate type; `degree` is the undirected link
// count (node size).
export interface GraphNode {
  /** Experimental selection-relative importance, normalized for display. */
  relevance?: number;
  selectionPath?: string[];
  agentState?: import("./agentAppearance").AgentVisualState;
  /** Current provider state, independent of filing and agent activity. */
  readState?: import("../../../../lib/sourceReadStateTypes").SourceReadState;
  /** Transient overlays are placed relative to settled base nodes. */
  layoutAnchors?: string[];
  layoutOffset?: { x: number; y: number };
  pilotNeedsYou?: boolean;
  /** In the active Pilot roster, even between turns or after a failure. */
  pilotActive?: boolean;
  pilotPhase?: import("./pilotAppearance").PilotVisualPhase;
  pilotDraft?: string;
  pilotContext?: boolean;
  memorySupport?: number;
  memberPaths?: string[];
  id: string;
  title: string;
  group: string;
  degree: number;
  /** Additive: an arrival still waiting for the gardener — landed, cited
   * by nothing yet (lib/graph.ts). Edgeless, and drawn as a point that
   * turns (LinkGraph's spinner) until the round that files it. */
  pending?: true;
  x?: number; // settled position from the server's layout (lib/graphLayout.ts)
  y?: number;
  // Additive (phase 3): present only on `kind: entity` notes.
  entity?: true;
  /** An entity's other names: the aliases folded into it. */
  aliases?: string[];
  entityType?: string;
  /** Entity nodes only: the graph ids of the sources this entity IS — a
   * document extracted as its own subject (lib/entitySourceLog.ts) — newest
   * arrival first. The viewer draws the pair as one node; a click opens the
   * first. Absent when it is no source. */
  opens?: string[];
  /** Source nodes only: the entity id this source is drawn as (the reverse
   * of an entity's `opens`). */
  drawnAs?: string;
  path?: string | null;
  // Filed-by facet (additive): the arrival's provenance, the same fields the
  // feed's rows carry — one filedByLabel maps a node and its row to the same
  // filer. Absent on view-tree notes and entities (nobody's filing).
  band?: "person" | "agent" | "service" | "engine";
  via?: string;
  from?: string;
  sourceDetail?: string;
  source?: string; // the arrival CHANNEL, not an edge endpoint
  /** Transient activity of a Pilot conversation. */
  live?: "working" | "waiting";
  sessionId?: string;
  sourcePaths?: string[];
}
export interface GraphEdge {
  pilotContext?: boolean;
  source: string;
  target: string;
  /** how many assertions put these two together; absent means once */
  weight?: number;
}
export interface GraphData {
  /** Precomputed, bounded selection-relative layout. */
  selectionRelative?: boolean;
  selectionStyle?: 'radial' | 'cloud';
  /** Browser-only base graph: session overlays do not invalidate its layout. */
  layoutBase?: GraphData;
  nodes: GraphNode[];
  edges: GraphEdge[];
  hash: string; // structure hash; the server's layout cache is keyed by it
  projection?: "assertions";
  userNote?: { ids: string[]; names: string[] };
}

export interface VaultInfo {
  /** the two trees, counted flat: the raw record + the maintained dossiers */
  view?: { references: number; entities: number };
  inbox: { pending: number; unsorted: number };
  requests: { open: number; done: number };
  /** How deep the intake queue is and when it next runs — the home feed's
   * column head. It rides here rather than on a door of its own (#639):
   * four numbers, and this payload is already re-fetched on every live
   * ping, where GET /api/queue built the whole due-set feed to answer them.
   * Optional so a viewer bundle can outlive the engine that serves it. */
  queue?: QueueHead;
}

export interface QueueHead {
  /** Due and not yet picked up. */
  waiting: number;
  /** Held by the round in flight — what the spinner reads. */
  running: number;
  /** ms until the gardener's next run. Under the desktop app this is the
   * supervisor's own published clock — a schedule, not an estimate — and 0
   * means the next beat fires it. Elsewhere it degrades to 0 whenever work
   * is due, with `tickMs` naming the bound. null = nothing due (no chip). */
  nextEtaMs: number | null;
  /** The tick interval, non-null ONLY when `nextEtaMs` is inexact: it is
   * the bound to name in place of a time ("within ~5m"). Null means the eta
   * above is exact and needs no hedge. */
  tickMs: number | null;
}

// The editable configuration surface (GET/POST /api/config): the
// integrations map and the two pass models in vault.yaml. Saves are
// validated and committed (author `config`).
export interface ConfigInfo {
  integrations: IntegrationInfo[];
  /** The gardener — the model every intake round runs. */
  curation?: { agent: "claude" | "codex" | "pi"; model: string } | null;
  gardener: import("../../../../lib/modelChoice").ModelChoice;
  /** The memory pass — its own model, and how often it sweeps (ms; the
   * manifest's number, default one day). `interval` is absent from an
   * engine older than 0.1.29. */
  memory: import("../../../../lib/modelChoice").ModelChoice & { interval?: number };
  quick: import("../../../../lib/modelChoice").ModelChoice;
  /** What the app may load from the web; absent from an older engine (on).
   * `firewall` is the intake firewall as it stands (on only with a Jev key),
   * `jev_key` whether one is set; both absent from an older engine. */
  security?: { remote_content: boolean; firewall?: boolean; jev_key?: boolean };
}

// vault.yaml entries first (manifest order), then integrations/ dirs not yet
// listed.
export interface IntegrationInfo {
  activation?: { accounts: string[]; callers: {id:string;label:string}[]; grants: {caller:string;accounts:string[]}[]; checkedAt?: string };
  name: string;
  enabled: boolean;
  hasCode: boolean; // integrations/<name>/ exists
  status?: { state: "off" | "unset" | "waiting" | "checking" | "importing" | "ok" | "error"; label: string; checkedAt?: string; lastArrivalAt?: string };
  hasTrigger: boolean; // it runs on a clock of its own (lib/desktopSchedule.ts's CADENCE)
  /** Credential fields (host .env): `set` always; `value` only when the
   * field is non-secret. Secrets are write-only through the save path. */
  env: { env: string; label: string; secret: boolean; set: boolean; value?: string }[];
  /** What it reads, when it reads more than one thing and each carries
   * its own credential: an inbox (address, IMAP host, app password), a
   * calendar feed (an ICS url). `status` is the last poll's word per
   * source; `detail` the reason when it is not ok. Absent ⇒ one source,
   * the integration itself (granola). */
  sources?: IntegrationSource[];
  /** How to add a source: the button's word and the fields the form asks
   * for. Absent ⇒ sources are not added here. */
  add?: {
    label: string;
    noun: string;
    /** `default` prefills the field; `placeholder` only hints. */
    fields: { key: string; label: string; secret: boolean; placeholder?: string; default?: string }[];
  };
}

export interface IntegrationSource {
  id: string;
  label: string;
  status: "ok" | "unset" | "failed";
  detail?: string;
  /** Its non-secret fields (an inbox's address and host), so FIX can open
   * the add form with them filled and only the secret to retype. */
  fields?: Record<string, string>;
}

// One integration edit, mirroring lib/config.ts: toggling only sets/clears
// `enabled: false` (config keys survive off-and-on). Takes effect on the
// integration's next poll.
export interface IntegrationOp {
  activate?: boolean;
  checkAccess?: boolean;
  readers?: {caller:string;accounts:string[]}[];
  name: string;
  enabled?: boolean;
  /** Credential writes (env var → value) — write-only; never echoed back. */
  env?: Record<string, string>;
  /** A new source, as the add form's fields (secrets included — write-only). */
  add?: Record<string, string>;
  /** A source to drop, by id. */
  remove?: string;
}

export interface ConfigPatch {
  curation?: { agent: "claude" | "codex" | "pi"; model: string };
  /** The two passes, in the shape the read answers and the shape
   * vault.yaml holds — one name per pass, everywhere (#643). */
  gardener?: { agent: "claude" | "codex" | "pi"; model: string; reasoning?: string | null };
  memory?: { agent: "claude" | "codex" | "pi"; model: string; reasoning?: string | null };
  quick?: { agent: "claude" | "codex" | "pi"; model: string; reasoning?: string | null };
  integrations?: IntegrationOp[];
  security?: { remote_content?: boolean; firewall?: boolean };
}

export interface ConfigResult {
  changed: string[]; // vault-relative paths actually modified (empty = no-op)
  committed: boolean;
}

// A note's "touched by" record (GET /api/note-log, lib/noteLog.ts): one row
// per landing/edit/run the merge turned up, newest-first.
export interface NoteLogRow {
  at: number; // epoch ms
  actor: string;
  action: string;
}

// an existing wikilink connection and/or a suggest.ts candidate edge.

/** Provider-neutral reported usage (GET /api/usage). */
export interface UsageInfo {
  providers: Record<string, import("../../../../lib/run/monitorTypes").ProviderMonitor>;
}

/** One entity in a proposed fold (#728): what the memory pass thinks are
 * several labels for one thing. The accept is the operator's alias. */
export interface FoldMember {
  id: string;
  label: string;
  assertions: number;
}

export interface FoldGroup {
  /** most-cited first */
  members: FoldMember[];
  /** a member's id — the label the pass suggests keeping */
  canonical: string;
  why: string;
}

/** `.state/entity-folds.json` as the engine serves it. */
export interface EntityFolds {
  proposedAt: string;
  model: string;
  census: number;
  groups: FoldGroup[];
  dropped: string[];
}

/** `/api/entity/folds` — the standing proposals against today's record.
 * `proposedAt` null: no pass has proposed yet. */
export interface FoldsView {
  proposedAt: string | null;
  model?: string;
  groups: FoldGroup[];
  /** Pairs you said are not one thing. Absent from an older engine. */
  rejected?: Array<[string, string]>;
}
