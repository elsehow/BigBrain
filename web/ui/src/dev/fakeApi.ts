import { contextConnections } from "../../../../lib/contextConnections";
import { findNode } from "../../../../lib/graphIdentity";
import { workAttention } from "../../../../lib/workAttention";
import { sessionMarkdown, sessionPath } from "../../../../lib/workSessionView";
import type { WorkSession } from "../../../../lib/workHistory";
import type { ModelChoice } from "../lib/modelSettings";
import { DEFAULT_PILOT_BACKEND } from "../../../../lib/pilotBackendTypes";
/**
 * fakeApi.ts — a whole vault, fabricated, so the WHOLE APP can be looked at
 * in a state no live vault will hold still in.
 *
 * The workbench's other scenes hand props to one component. This one goes a
 * level up: it swaps `fetch` and `EventSource`, and then the real App mounts
 * against them and cannot tell the difference. That is the only honest way
 * to storyboard first-run — an empty vault stops being empty the moment you
 * use it, and you cannot get back to it without deleting your notes.
 *
 * Dev/test-only. Nothing under src/dev/ is reachable from index.html, so
 * none of this enters the app bundle.
 */

import { clearSwrCache } from "../lib/api";
import { clearNoteBriefingCache } from "../lib/noteBriefing";
import { SAMPLE_GROUPS } from "./foldFixtures";
import type { Connection } from "../lib/connect";
import type { DiagnosticsReport } from "../lib/diagnostics";
import type { SkinsReport } from "../lib/skins";
import { SKINS_DEMO } from "./skinsStub";
import type { PairState } from "../lib/pair";
import type { SetupAgent, SetupState } from "../lib/setup";
import type { View } from "../lib/store.svelte";
import type {
  FoldGroup,
  GraphData,
  IntegrationInfo,
  NoteResult,
  QueueHead,
  RecentEntry,
  UsageInfo,
  VaultInfo,
} from "../lib/types";
import type { Phase } from "../lib/pilot";
import type { Line } from "../lib/pilot.svelte";

export interface VaultState {
  telemetry?: import("../lib/telemetry").TelemetrySnapshot;
  sourceReadStates?: import("../../../../lib/sourceReadState").SourceReadStateRow[];
  /** Optional scene-specific model output; no real model is called. */
  noteSummary?: (selected: string[]) => string;
  workSessions?: WorkSession[];
  label: string;
  /** What this state is, and what to look for in it. Shown above the frame. */
  note: string;
  vault: VaultInfo;
  recent: RecentEntry[];
  graph: GraphData;
  /** Merged into the /api/vault payload, where the queue head lives since
   * #639 — kept a separate scene field so a scene can say "four waiting"
   * without restating the whole vault index. */
  queue: QueueHead;
  /** `/api/tokens`. `null` ⇒ the route is absent. Otherwise every
   * credential minted for this vault: the machine's Claude Code, a paired
   * extension. From the app's side a client exists exactly when its token
   * does — there is no other way to see one (a page inside the desktop
   * webview cannot see a browser extension, and it does not try). */
  connections: Connection[] | null;
  /** `/api/pair` — the browser card's code. Absent ⇒ no code outstanding;
   * `null` ⇒ the route is absent (an older host). A pending code's expiry
   * is served relative to the real clock so the countdown runs. */
  pair?: PairState | null;
  /** `/api/setup` — the two facts first run turns on (lib/setup.ts).
   * Absent ⇒ a scene that is not about first run; the workbench mounts the
   * App as for a set-up vault. */
  setup?: SetupState;
  /** `/api/diagnostics` — the facts and the log tails (lib/diagnostics.ts). */
  diagnostics?: DiagnosticsReport;
  /** `/api/themes` — this machine's skins folder (lib/themes.ts). Absent ⇒
   * no desktop door: the themes screen shows the built-ins only. */
  skins?: SkinsReport;
  /** `/api/entity/folds` — the memory pass's fold proposals (#728). Absent
   * ⇒ an engine without the door (404: home shows nothing); `[]` ⇒ the
   * door with nothing proposed. Accept and reject move the groups. */
  folds?: FoldGroup[];
  /** `/api/config`'s pass models (gardener.model, memory.model) — what the
   * agents card's model rows show. Absent ⇒ vault.example.yaml's defaults.
   * A save in the workbench updates it, so the rows re-read what they set. */
  config?: { gardener: string; memory: string; interval?: number; curation?: { agent: "claude" | "codex"; model: string }; roles?: Partial<Record<"gardener" | "memory" | "quick", ModelChoice>> };
  /** `/api/config`'s integrations list. Absent ⇒ agent-chat alone (which
   * the integrations screen hides), so the screen shows only the browser
   * card. A toggle in the workbench updates it, so the row re-reads what
   * it set. */
  integrations?: IntegrationInfo[];
  /** Reported usage and separate account quota, using fabricated observations. */
  usage?: UsageInfo;
  /** `/api/pilot` (#770): whether a key is set — and, for the HUD scenes,
   * the phase and lines the workbench writes straight into the store,
   * since no session can exist behind fakeApi. Absent ⇒ no key: no HUD. */
  pilot?: { configured: boolean; enabled?: boolean; phase?: Phase; lines?: Line[]; live?: string; tools?: string[]; error?: string };
  /** Which screen the scene is about. The workbench writes it to the hash
   * before the App mounts; home when absent. */
  view?: View;
  /** The exact route, when a view alone does not say it — a note open in
   * the text tab is `/vault/<path>`. Wins over `view`. */
  hash?: string;
  /** `/api/note?path=…`, by path — what the text tab shows for a note the
   * scene opens. A path not here answers an empty note. */
  notes?: Record<string, NoteResult>;
  briefing?: "loading" | "error";
  streamBriefing?: boolean;
  failBriefingLinks?: boolean;
}

/** vault.example.yaml's models — what a vault runs until someone chooses. */
const DEFAULT_CONFIG: NonNullable<VaultState["config"]> = { gardener: "claude-opus-4-8", memory: "claude-opus-4-8" };

/** Fabricated account observations, independent of BigBrain token totals. */
const usageWeek = (used = .2, stale = false): UsageInfo => {
  const now = Date.now();
  const asOf = new Date(now - (stale ? 8 * 86_400_000 : 60_000)).toISOString();
  return { providers: { anthropic: {
    provider: "anthropic", since: new Date(now - 7 * 86_400_000).toISOString(), asOf,
    capabilities: { tokens: true, quota: true }, accountIdentity: "known",
    roles: ["gardener", "memory", "pilot", "quick"].map(role => ({ role, runs: 3, measuredRuns: 3, tokens: 12000, partial: false })),
    quota: { state: stale ? "stale" : "current", windows: [{ window: "seven_day", used, asOf,
      resetsAt: new Date(now + (stale ? -1 : 3) * 86_400_000).toISOString() }] },
  } } };
};
const USAGE_WEEK = usageWeek();
const serveUsage = (u: UsageInfo | undefined): Response => json(u ?? { providers: {} });

const EMPTY_QUEUE: QueueHead = { waiting: 0, running: 0, nextEtaMs: null, tickMs: null };

const EMPTY_VAULT: VaultInfo = {
  view: { references: 0, entities: 0 },
  inbox: { pending: 0, unsorted: 0 },
  requests: { open: 0, done: 0 },
};

const NOW = Date.parse("2026-08-11T17:00:00Z");
const minsAgo = (m: number) => NOW - m * 60_000;

/** The browser extension's credential — what "paired" looks like from the
 * vault's side (lib/pair.ts). A person-device, `via: pair`: the browser card
 * lists it, the agents card (which filters to `via: connect`) never does. */
const EXTENSION: Connection = {
  id: "tok_ext_1",
  name: "chrome on MacBook-Pro.local",
  kind: "person-device",
  via: "pair",
  scopes: ["inbox:write"],
  created: new Date(minsAgo(9)).toISOString(),
  last_used: new Date(minsAgo(4)).toISOString(),
  revoked: null,
};
const FIREFOX: Connection = {
  ...EXTENSION,
  id: "tok_ext_2",
  name: "firefox on MacBook-Pro.local",
  created: new Date(minsAgo(3 * 24 * 60)).toISOString(),
  last_used: null,
};
const PAIR_IDLE: PairState = { endpoint: "http://127.0.0.1:4748", pending: null };
const PAIR_CODE: PairState = {
  endpoint: "http://127.0.0.1:4748",
  // expiry is rewritten against the real clock when served — see route()
  pending: { code: "4K7Q-2MXP", created: new Date(NOW).toISOString(), expires: new Date(NOW + 9 * 60_000).toISOString() },
};

/** A connected Claude Code — the third step's finished state. */
const AGENT: Connection = {
  id: "tok_agent_1",
  name: "Claude Code — MacBook Pro",
  kind: "agent",
  via: "connect",
  scopes: ["vault:read", "inbox:write"],
  created: new Date(minsAgo(3)).toISOString(),
  last_used: new Date(minsAgo(1)).toISOString(),
  revoked: null,
};

/** Four captures and the two dossiers the editor drew out of them. */
const LANDED: RecentEntry[] = [
  {
    path: "references/2026-08-11-pkm-graph-thinking.md",
    modified: minsAgo(6),
    author: "editor",
    action: "added",
    title: "Why graph views fail at scale",
    band: "person",
    from: "send-to-bigbrain",
    id: "ref_a",
    status: "filed",
    type: "reference",
    category: "web-clip",
  },
  {
    path: "references/2026-08-11-hiring-loop-notes.md",
    modified: minsAgo(21),
    author: "editor",
    action: "added",
    title: "Hiring loop — what to fix before Q4",
    band: "person",
    from: "send-to-bigbrain",
    id: "ref_b",
    status: "filed",
    type: "reference",
    category: "note",
  },
  {
    path: "entities/rivka-tal.md",
    modified: minsAgo(20),
    author: "editor",
    action: "added",
    title: "Rivka Tal",
    band: "engine",
    type: "entity",
  },
  {
    path: "references/2026-08-11-lease-terms.md",
    modified: minsAgo(48),
    author: "editor",
    action: "added",
    title: "Lease — renewal terms and the parking clause",
    band: "person",
    from: "send-to-bigbrain",
    id: "ref_c",
    status: "filed",
    type: "reference",
    category: "web-clip",
  },
  {
    path: "entities/sunset-house.md",
    modified: minsAgo(47),
    author: "editor",
    action: "added",
    title: "Sunset House",
    band: "engine",
    type: "entity",
  },
  {
    path: "references/2026-08-11-first-capture.md",
    modified: minsAgo(74),
    author: "editor",
    action: "added",
    title: "A first capture, from the extension",
    band: "person",
    from: "send-to-bigbrain",
    id: "ref_d",
    status: "filed",
    type: "reference",
    category: "web-clip",
  },
];

const SMALL_GRAPH: GraphData = {
  nodes: [
    {
      id: "entities/rivka-tal.md",
      title: "Rivka Tal",
      group: "entity",
      degree: 2,
      x: -70,
      y: -40,
      entity: true,
    },
    {
      id: "entities/sunset-house.md",
      title: "Sunset House",
      group: "entity",
      degree: 1,
      x: 90,
      y: 40,
      entity: true,
    },
    {
      id: "references/2026-08-11-pkm-graph-thinking.md",
      title: "Why graph views fail at scale",
      group: "reference",
      degree: 1,
      x: -170,
      y: -110,
    },
    {
      id: "references/2026-08-11-hiring-loop-notes.md",
      title: "Hiring loop — what to fix before Q4",
      group: "reference",
      degree: 1,
      x: -160,
      y: 40,
    },
    {
      id: "references/2026-08-11-lease-terms.md",
      title: "Lease — renewal terms and the parking clause",
      group: "reference",
      degree: 1,
      x: 180,
      y: 100,
    },
    {
      id: "references/2026-08-11-first-capture.md",
      title: "A first capture, from the extension",
      group: "reference",
      degree: 0,
      x: 40,
      y: -140,
    },
  ],
  edges: [
    { source: "references/2026-08-11-pkm-graph-thinking.md", target: "entities/rivka-tal.md" },
    { source: "references/2026-08-11-hiring-loop-notes.md", target: "entities/rivka-tal.md" },
    { source: "references/2026-08-11-lease-terms.md", target: "entities/sunset-house.md" },
  ],
  hash: "wb-first-items",
};

const EMPTY_GRAPH: GraphData = { nodes: [], edges: [], hash: "wb-first-empty" };

// ── the first-run states, in the order a new user meets them ────────────────
//
// Rewritten for the desktop app (2026-08-27). The six hosted-era states
// ("after Google says yes", the extension marker, a second browser) are gone
// with the control plane: there is no sign-in, and a page inside a Tauri
// webview cannot see a browser extension at all. What is left is two facts —
// a vault, and a Claude Code connected to it — and the states are the ways
// of not having them yet, then the first minutes of having both.
//
// Steps 1 and 2 are FirstRun.svelte, mounted alone (no chrome: nothing to
// search, nowhere for the gear to go). From step 3 on it is the real App,
// and the storyboard is home's empty state growing into a feed.

const PLUGIN_OK = { shipped: "0.1.6", installed: "0.1.6", marketplace: "/Applications/BigBrain.app/Contents/Resources/resources/engine/clients/claude-plugin", current: true };
const CLAUDE_OK = { installed: "2.1.247", account: "alpha@example.com", plugin: PLUGIN_OK };

/** The credential `bigbrain connect` mints — from the app's side, "a Claude
 * Code is connected" is exactly this record existing. */
const AGENT_SETUP: SetupAgent = { name: "Claude Code — MacBook Pro", connected: new Date(minsAgo(3)).toISOString(), lastUsed: null, revoked: null };

const NO_VAULT_SETUP: SetupState = { vault: null, identity: null, suggested: "/Users/alpha/vault", claude: CLAUDE_OK, agent: null };
/** Step 2: the vault exists and nobody has said whose it is (#572). */
const NAMELESS_SETUP: SetupState = {
  vault: { path: "/Users/alpha/vault", created: new Date(minsAgo(1)).toISOString() },
  identity: null,
  claude: CLAUDE_OK,
  agent: null,
};
/** Step 3: named, not yet connected. */
const VAULT_SETUP: SetupState = {
  ...NAMELESS_SETUP,
  identity: { name: "Alpha Tester", entity_id: "ent_0123456789abcdef0123" },
};
const DONE_SETUP: SetupState = { ...VAULT_SETUP, agent: AGENT_SETUP };

/** The App's half of a step-1/2 scene: nothing, because the App is not
 * mounted. The fields still have to exist for the type; every one of them
 * is a zero. */
const NOTHING = { vault: EMPTY_VAULT, recent: [], graph: EMPTY_GRAPH, queue: EMPTY_QUEUE, connections: [] as Connection[] };

export const FIRST_RUN: Record<string, VaultState> = {
  noVault: {
    label: "1 · no vault — pick a folder",
    note: "The app opened and found no vault (no BIGBRAIN_VAULT, no ~/.config/bigbrain/vault pointer, no ~/vault). The supervisor's setup door (bin/desktop.ts) serves exactly this screen: the whole window is one question, with the CLI's default already in the field. Nothing else is asked yet — not a name, not a charter. Claude Code is fine on this machine, so step 2 will be short.",
    ...NOTHING,
    setup: NO_VAULT_SETUP,
  },

  folderTaken: {
    label: "1b · the folder holds something else",
    note: "They chose ~/Documents/notes. The shell looked: 212 files, no vault.yaml. That is not a vault and not empty, so the screen says what it found and the button waits — creating a vault inside somebody's existing notes folder would be a git init over their files. Pick another folder and the problem clears (it is pinned to the folder it was reported for). CREATE is the accent, OPEN the quiet one — Obsidian's split.",
    ...NOTHING,
    setup: { ...NO_VAULT_SETUP, pick: { path: "~/Documents/notes", problem: "~/Documents/notes is not a valid vault — pick an empty folder or an existing BigBrain vault." } },
  },

  needsName: {
    label: "2 · vault made — who is it about?",
    note: "The vault exists and its logs hold no identity declaration, so the gardener would be told \"No vault-owner identity labels were supplied\" on every run (#572). Asked before the agent connects, because connecting is what starts the gardener. Enter submits; the workbench has no onName, so the field is inert here.",
    ...NOTHING,
    setup: NAMELESS_SETUP,
  },

  noClaude: {
    label: "3a · vault made — Claude Code not installed",
    note: "The vault exists (the line at the foot says where). The app checked for `claude` on the PATH the jobs get and found nothing, so the connect button is off and the row says what to do: install, sign in once, and the screen re-checks on its own. The install line is the official one. This is the one prerequisite the product cannot remove — the gardener IS a Claude Code session.",
    ...NOTHING,
    setup: { ...VAULT_SETUP, claude: { installed: false, account: null } },
  },

  notSignedIn: {
    label: "3b · Claude Code installed, nobody signed in",
    note: "`claude --version` answers but ~/.claude/.credentials.json is absent (lib/preflight.ts claudeLoggedIn) — a fresh install, or a sign-out. Same screen, one different sentence, button still off. Worth its own scene because the fix is different from 2a and a person who just installed Claude Code will hit exactly this.",
    ...NOTHING,
    setup: { ...VAULT_SETUP, claude: { installed: "2.1.247", account: null } },
  },

  connect: {
    label: "3 · named, Claude Code ready — connect",
    note: "The good path. The check row is green and names the account whose subscription will do the gardening — that is the one fact a person should see before clicking. The terms are the agents card's three. CONNECT installs the plugin into their Claude Code and mints this machine's credential (what `bigbrain connect` does); the terminal line under it is the same act for people who prefer it.",
    ...NOTHING,
    setup: VAULT_SETUP,
  },

  sharing: {
    label: "4 · optional usage sharing",
    note: "The final setup step. Both buttons save a simulated installation preference and enter the app. Diagnostics can change it afterward. No data leaves the workbench.",
    ...NOTHING,
    setup: { ...DONE_SETUP, onboarding: "analytics" },
    telemetry: { enabled: false, decided: false, configured: true, samples: [], operations: {}, actions: {}, queued: 0, delivery: "idle" },
  },

  connectedEmpty: {
    label: "3 · connected, nothing landed",
    note: "The first screen that is the app. Vault and agent both exist, so the first-run screens are gone and do not come back (setup is two facts, not a dismissed banner). Nothing has landed, so home is one invitation (EmptyVault): drop anything anywhere on the window, or follow the link to Integrations. It leaves the moment a source, entity or arrival exists; the gardener's own memory notes do not count.",
    vault: EMPTY_VAULT,
    recent: [],
    graph: EMPTY_GRAPH,
    queue: EMPTY_QUEUE,
    connections: [AGENT],
    setup: DONE_SETUP,
  },

  firstItems: {
    label: "4 · first items landed",
    note: "Four captures in and the gardener has drawn two dossiers out of them — the feed is six rows and the graph is real but tiny. Compare with 3: the doors are gone the moment there is a row, and the screen is just home. The extension is now one of the filers (it holds a token for this vault, minted when it was paired — that record, not a page marker, is how the app knows it exists).",
    vault: { ...EMPTY_VAULT, view: { references: 4, entities: 2 } },
    recent: LANDED,
    graph: SMALL_GRAPH,
    queue: EMPTY_QUEUE,
    connections: [EXTENSION, AGENT],
    setup: { ...DONE_SETUP, agent: { ...AGENT_SETUP, lastUsed: new Date(minsAgo(1)).toISOString() } },
  },

  steady: {
    label: "5 · steady state",
    note: "What every other screen should be compared against. Nothing about first run is visible or recoverable from here — revoking the agent months from now summons no wizard at someone who is plainly set up; the agents card shows the state and a connect button, and that is all.",
    vault: { ...EMPTY_VAULT, view: { references: 4, entities: 2 } },
    recent: LANDED,
    graph: SMALL_GRAPH,
    queue: EMPTY_QUEUE,
    connections: [EXTENSION, AGENT],
    setup: { ...DONE_SETUP, agent: { ...AGENT_SETUP, lastUsed: new Date(minsAgo(1)).toISOString() } },
  },
};

/** The established vault the scenes below stand on — both credentials live,
 * so the setup band is retired and nothing has a claim to the space above
 * the feed. */
const SETTLED: Pick<VaultState, "vault" | "graph" | "connections"> = {
  vault: { ...EMPTY_VAULT, view: { references: 4, entities: 2 } },
  graph: SMALL_GRAPH,
  connections: [EXTENSION, AGENT],
};

// ── the FILED BY filter (Nick, 2026-08-20) ──────────────────────────────────
// A feed with every kind of filer at once — agent sessions (stamped AND
// legacy), an integration, the extension, the web drop — which no live vault
// holds still in, plus one absurdly long connection name for the chip's
// ellipsis. The graph carries the same provenance on its source nodes, so
// toggling a chip must move BOTH surfaces.

const FILER_ROWS: RecentEntry[] = [
  {
    // agent-band yet DEFAULT ON: the product's feedback door delivers
    // through an agent-kind token (the hosted feedback door), and feed.ts's
    // DEFAULT_ON pin keeps it selected — the chip must render lit on a
    // fresh load while the claude-code chips sit dimmed beside it.
    path: "references/2026-08-11-feedback-graph-zoom.md",
    modified: minsAgo(5),
    author: "editor",
    action: "added",
    title: "Feedback: graph zoom sticks on trackpads",
    band: "agent",
    from: "bigbrain-feedback",
    via: "bigbrain-feedback",
    source: "api",
    id: "ref_feedback_1",
    status: "filed",
    type: "reference",
    category: "feedback",
  },
  {
    path: "log/insertions/2026-08/ins_aaaaaaaaaaaaaaaaaaaaaaaa.json",
    modified: minsAgo(3),
    author: "intake",
    action: "added",
    title: "Claude Code — BigBrain (2026-08-11)",
    band: "agent",
    from: "claude-code",
    via: "claude code on Mac-mini.local",
    source: "agent-chat",
    id: "src-chat-1",
    insertionId: "ins_aaaaaaaaaaaaaaaaaaaaaaaa",
    status: "record",
    type: "source",
    category: "transcript",
  },
  {
    path: "references/2026-08-11-agent-chat-legacy.md",
    modified: minsAgo(45),
    author: "editor",
    action: "added",
    title: "Claude Code — Projects (2026-08-10)",
    band: "agent",
    from: "claude-code",
    source: "agent-chat",
    id: "ref_chat_legacy",
    status: "filed",
    type: "reference",
    category: "transcript",
  },
  {
    path: "log/insertions/2026-08/ins_bbbbbbbbbbbbbbbbbbbbbbbb.json",
    modified: minsAgo(8),
    author: "intake",
    action: "added",
    title: "Weekly sync — planning and red lines",
    band: "service",
    from: "granola",
    source: "granola",
    id: "src-granola-1",
    insertionId: "ins_bbbbbbbbbbbbbbbbbbbbbbbb",
    status: "record",
    type: "source",
    category: "transcript",
  },
  {
    path: "references/2026-08-11-clipped-page.md",
    modified: minsAgo(14),
    author: "editor",
    action: "added",
    title: "The case against roadmaps",
    band: "person",
    via: "web-extension",
    source: "api",
    id: "ref_clip_1",
    status: "filed",
    type: "reference",
    category: "web-clip",
  },
  {
    path: "log/insertions/2026-08/ins_cccccccccccccccccccccccc.json",
    modified: minsAgo(26),
    author: "intake",
    action: "added",
    title: "A session from the long-named machine",
    band: "agent",
    via: "claude code on Nicks-Extremely-Long-Hostname-MacBook-Pro-Of-Theseus.local",
    source: "agent-chat",
    id: "src-chat-2",
    insertionId: "ins_cccccccccccccccccccccccc",
    status: "record",
    type: "source",
    category: "transcript",
  },
  ...LANDED,
];

/** SMALL_GRAPH with the arrivals wearing their provenance, plus two
 * agent-filed source nodes grounding Rivka — the ones a default (agents
 * OFF) filter must remove while the entity stays. */
const FILER_GRAPH: GraphData = {
  nodes: [
    ...SMALL_GRAPH.nodes.map((n) =>
      n.group === "reference"
        ? { ...n, band: "person" as const, from: "send-to-bigbrain", source: "web" }
        : n,
    ),
    {
      id: "source:ins_aaaaaaaaaaaaaaaaaaaaaaaa",
      title: "Claude Code — BigBrain (2026-08-11)",
      group: "source",
      degree: 1,
      x: -40,
      y: 120,
      path: "log/insertions/2026-08/ins_aaaaaaaaaaaaaaaaaaaaaaaa.json",
      band: "agent",
      from: "claude-code",
      via: "claude code on Mac-mini.local",
      source: "agent-chat",
    },
    {
      id: "source:ins_bbbbbbbbbbbbbbbbbbbbbbbb",
      title: "Weekly sync — planning and red lines",
      group: "source",
      degree: 1,
      x: -120,
      y: 100,
      path: "log/insertions/2026-08/ins_bbbbbbbbbbbbbbbbbbbbbbbb.json",
      band: "service",
      from: "granola",
      source: "granola",
    },
  ],
  edges: [
    ...SMALL_GRAPH.edges,
    { source: "source:ins_aaaaaaaaaaaaaaaaaaaaaaaa", target: "entities/rivka-tal.md" },
    { source: "source:ins_bbbbbbbbbbbbbbbbbbbbbbbb", target: "entities/rivka-tal.md" },
  ],
  hash: "wb-filed-by",
};

export const FILED_BY: Record<string, VaultState> = {
  folds: {
    label: "0 · fold proposals at the top",
    note: "Home with the memory pass's proposals above the feed (#728): the labels it thinks name one thing, one pill row per group, for triage before anything else. The filled pill stays; × on a pill is 'not the same thing'; ACCEPT aliases the rest into it. Here the fake engine moves the groups as the real one would — an accepted or emptied group leaves — and the feed below is the mixed scene's.",
    recent: FILER_ROWS,
    queue: EMPTY_QUEUE,
    ...SETTLED,
    graph: FILER_GRAPH,
    folds: SAMPLE_GROUPS,
  },
  mixed: {
    label: "1 · every filer at once — agents OFF by default",
    note: "Five filers: two agent connections (one absurdly long — the chip must ellipsize), the legacy bare 'claude code', granola, the extension, and the web drop. FRESH LOAD default: both agent chips sit dimmed, their rows are out of the feed and their source nodes out of the graph (Rivka keeps her granola grounding). Toggle a chip: its rows AND nodes return together. NOTE: choices persist in localStorage (bb-filed-by) — clear it to see the default again.",
    recent: FILER_ROWS,
    queue: EMPTY_QUEUE,
    ...SETTLED,
    graph: FILER_GRAPH,
  },
};

// ── a drop, landing and being filed (2026-09-06) ────────────────────────────
// Nick: "when we add a new item, it should appear in the graph as an
// isolated node. the camera should center on it (under the hood: it's
// selected. we see the node name). the node itself should be a spinner,
// showing it's being processed. (esc deselects at any point). when
// processed, we follow it, see where it links through."
//
// Three states of one vault, in the order a live one passes through them
// — before, the landing (a pending point, the queue holding one, the text
// tab open on an item the record has made nothing of yet), the filing
// (the point has its threads, the row its check, the tab its assertions).
// Each is a scene of its own to stand still in; the workbench's PLAY
// control walks them under one mounted App, which is the only way to
// watch what the camera does between them.

export const DROP_PATH = "log/insertions/2026-08/ins_d0d0d0d0d0d0d0d0d0d0d0d0.json";
const DROP_ID = "source:ins_d0d0d0d0d0d0d0d0d0d0d0d0";
const DROP_TITLE = "Sparse probes for Atlas — draft proposal";
const DROP_ROW: RecentEntry = {
  path: DROP_PATH,
  modified: minsAgo(0),
  author: "intake",
  action: "added",
  title: DROP_TITLE,
  band: "person",
  from: "web",
  via: "web",
  source: "web-drop",
  id: "src-drop-1",
  insertionId: "ins_d0d0d0d0d0d0d0d0d0d0d0d0",
  status: "pending",
  type: "source",
  category: "pdf-import",
};
const DROP_NOTE: NoteResult = {
  path: DROP_PATH,
  content: `---\ntitle: "${DROP_TITLE}"\nkind: source\n---\n`,
  sourceAssertions: [],
  origin: null,
};
const dropNode = (over: Partial<GraphData["nodes"][number]>): GraphData["nodes"][number] => ({
  id: DROP_ID, title: DROP_TITLE, group: "source", degree: 0, path: DROP_PATH,
  band: "person", from: "web", via: "web", source: "web-drop", ...over,
});
/** the landing: a point off on its own, edgeless, turning */
const DROP_LANDED_GRAPH: GraphData = {
  nodes: [...SMALL_GRAPH.nodes, dropNode({ x: 260, y: -190, pending: true })],
  edges: SMALL_GRAPH.edges,
  hash: "wb-drop-landed",
};
/** the filing: the round cited it against two entities, and the layout
 * pulled it in between them — the threads the camera flies out to */
const DROP_FILED_GRAPH: GraphData = {
  nodes: [
    ...SMALL_GRAPH.nodes.map((n) => (n.id === "entities/rivka-tal.md" || n.id === "entities/sunset-house.md" ? { ...n, degree: n.degree + 1 } : n)),
    dropNode({ x: 40, y: -60, degree: 2 }),
  ],
  edges: [
    ...SMALL_GRAPH.edges,
    { source: DROP_ID, target: "entities/rivka-tal.md" },
    { source: DROP_ID, target: "entities/sunset-house.md" },
  ],
  hash: "wb-drop-filed",
};
const DROP_FILED_NOTE: NoteResult = {
  ...DROP_NOTE,
  sourceAssertions: [
    {
      id: "ast_drop_1", confidence: "direct", created_at: new Date(minsAgo(0)).toISOString(),
      author: { kind: "model", id: "gardener", invocation_id: "run-9" },
      text: "[[entities/rivka-tal.md|Rivka Tal]] drafted a proposal to test sparse probes on the Atlas run, due before the Q4 review.",
      entities: [{ id: "entities/rivka-tal.md", label: "Rivka Tal", path: "entities/rivka-tal.md" }],
    },
    {
      id: "ast_drop_2", confidence: "candidate", created_at: new Date(minsAgo(0)).toISOString(),
      author: { kind: "model", id: "gardener", invocation_id: "run-9" },
      text: "The proposal's compute would run out of [[entities/sunset-house.md|Sunset House]]'s lab budget.",
      entities: [{ id: "entities/sunset-house.md", label: "Sunset House", path: "entities/sunset-house.md" }],
    },
  ],
};
export const DROP: Record<string, VaultState> = {
  before: {
    label: "0 · before the drop",
    note: "The small vault at rest: six items, two entities, nothing waiting. PLAY (in the sidebar) runs the whole story from here under this one mounted app — a file lands, its point appears turning with the camera on it and the tab open on it, and three seconds later the round files it and the camera flies out to its threads. Esc at any point closes the note and brings the camera home.",
    recent: LANDED,
    queue: EMPTY_QUEUE,
    ...SETTLED,
  },
  landed: {
    label: "1 · landed — a point, turning",
    note: "The moment after a drop lands (DropZone's gotoNote): the arrival is a degree-0 node off on its own, drawn as a spinner; the camera has centred on it and its name shows; the text tab is open on it and says the record has made nothing of it yet; the feed's top row wears the same spinner and the column head says when the round comes.",
    recent: [DROP_ROW, ...LANDED],
    queue: { waiting: 1, running: 0, nextEtaMs: 0, tickMs: 300_000 },
    ...SETTLED,
    graph: DROP_LANDED_GRAPH,
    notes: { [DROP_PATH]: DROP_NOTE },
    hash: `/vault/${DROP_PATH}`,
  },
  filed: {
    label: "2 · filed — the threads",
    note: "The round has filed it: two assertions cite it, so the point has two threads and the layout pulled it in between its entities. The rebuild keeps the camera where it was and flies it to the node's new region — its neighbours framed — instead of cutting to the whole picture; the spinner is a disc now, the row a check, the tab two rows whose links j/k walk.",
    recent: [{ ...DROP_ROW, status: "filed" }, ...LANDED],
    queue: EMPTY_QUEUE,
    ...SETTLED,
    graph: DROP_FILED_GRAPH,
    notes: { [DROP_PATH]: DROP_FILED_NOTE },
    hash: `/vault/${DROP_PATH}`,
  },
};

const BRIEFING_PATH = "projection/entities/ent_00000000000000000001.md";
const BRIEFING_SOURCE = "log/insertions/2026-09/ins_000000000000000000000001.json";
const BRIEFING_STATE: VaultState = {
  ...SETTLED, label: "Summary and relationships", note: "One Quick response, ordered relationship links, and j/k navigation across every note kind.",
  recent: [], queue: EMPTY_QUEUE, hash: `/vault/${BRIEFING_PATH}`,
  graph: { hash: "briefing-demo", nodes: [
    { id: BRIEFING_PATH, path: BRIEFING_PATH, title: "Atlas", group: "entity", degree: 1, x: 0, y: 0 },
    { id: BRIEFING_SOURCE, path: BRIEFING_SOURCE, title: "Atlas — September update", group: "source", degree: 1, x: 120, y: 60, band: "person", from: "web" },
    { id: "maya", path: "projection/entities/ent_00000000000000000002.md", title: "Maya Chen", group: "entity", degree: 1, x: -70, y: 80 },
    { id: "memory/project.md", path: "memory/project.md", title: "Project notebook", group: "memory", degree: 1, x: 70, y: -70 },
  ], edges: [{ source: BRIEFING_PATH, target: BRIEFING_SOURCE }, { source: BRIEFING_PATH, target: "memory/project.md" }, { source: BRIEFING_PATH, target: "maya" }] },
  notes: {
    [BRIEFING_PATH]: { path: BRIEFING_PATH, content: "# Atlas\n", modified: Date.parse("2026-08-26T16:46:00Z"), projectedEntity: { id: "ent_00000000000000000001", label: "Atlas", assertions: [], total: 186 } },
    [BRIEFING_SOURCE]: { path: BRIEFING_SOURCE, content: "# Atlas — September update\n", sourceAssertions: [], origin: { kind: "url", url: "https://example.com/atlas-update" } },
    "projection/entities/ent_00000000000000000002.md": { path: "projection/entities/ent_00000000000000000002.md", content: "# Maya Chen\n", projectedEntity: { id: "ent_00000000000000000002", label: "Maya Chen", assertions: [] } },
    "memory/project.md": { path: "memory/project.md", content: "# Project notebook\n\n[[projection/entities/ent_00000000000000000001|Atlas]] is planning a second location." },
  },
};
const EXTRA_BRIEFING_NODES = Array.from({ length: 11 }, (_, i) => ({
  id: `extra-${i}`, path: `memory/extra-${i}.md`, title: `Additional project note ${i + 1}`,
  group: "memory", degree: 1, x: 80 + i * 35, y: -20 + i * 40,
}));
export const BRIEFINGS: Record<string, VaultState> = {
  ready: BRIEFING_STATE,
  streaming: { ...BRIEFING_STATE, label: "Summary before descriptions", streamBriefing: true },
  linkError: { ...BRIEFING_STATE, label: "Summary survives a relationship failure", streamBriefing: true, failBriefingLinks: true },
  many: { ...BRIEFING_STATE, label: "Ten descriptions and remaining links", graph: { ...BRIEFING_STATE.graph!,
    nodes: [...BRIEFING_STATE.graph!.nodes, ...EXTRA_BRIEFING_NODES],
    edges: [...BRIEFING_STATE.graph!.edges, ...EXTRA_BRIEFING_NODES.map(n => ({ source: BRIEFING_PATH, target: n.id }))],
  } },
  joint: { ...BRIEFING_STATE, label: "Compose a relationship briefing", note: "Shift-click Maya to introduce Atlas and Maya together; Ctrl-click either anchor or a neighbor to exclude it.", graph: {
    ...BRIEFING_STATE.graph!, hash: "briefing-joint",
    nodes: [...BRIEFING_STATE.graph!.nodes, ...EXTRA_BRIEFING_NODES.slice(0, 5)],
    edges: [...BRIEFING_STATE.graph!.edges,
      { source: "maya", target: BRIEFING_SOURCE }, { source: "maya", target: "memory/project.md" },
      ...EXTRA_BRIEFING_NODES.slice(0, 5).map((n, i) => ({ source: i % 2 ? "maya" : BRIEFING_PATH, target: n.id })),
    ],
  } },
  memory: { ...BRIEFING_STATE, label: "Markdown note", hash: "/vault/memory/project.md" },
  source: { ...BRIEFING_STATE, label: "Source note", hash: `/vault/${BRIEFING_SOURCE}` },
  loading: { ...BRIEFING_STATE, label: "Generating", briefing: "loading" },
  error: { ...BRIEFING_STATE, label: "Connection failure", briefing: "error" },
};

// ── settings (2026-08-27) ───────────────────────────────────────────────────
// The two first-run controls in their second home. VaultPicker is the vault
// card, prefilled with the folder in use; ClaudeConnect is the agents card's
// body, and shows CONNECT again only when the credential is gone. A revoked
// record is what keeps first run away from someone who set up long ago —
// setup is "a vault and an agent that has existed", not "an agent now".

const WEEKS_AGO = minsAgo(14 * 24 * 60);
const SETUP_LIVE: SetupState = {
  vault: { path: "/Users/alpha/vault", created: new Date(WEEKS_AGO).toISOString() },
  claude: CLAUDE_OK,
  agent: { ...AGENT_SETUP, connected: new Date(WEEKS_AGO).toISOString(), lastUsed: new Date(minsAgo(1)).toISOString() },
};
const REVOKED: SetupAgent = { ...SETUP_LIVE.agent!, lastUsed: new Date(minsAgo(40 * 24 * 60)).toISOString(), revoked: new Date(minsAgo(40 * 24 * 60)).toISOString() };
const AGENT_REVOKED: Connection = { ...AGENT, last_used: REVOKED.lastUsed, revoked: REVOKED.revoked };

/** A machine where the gardener cannot run: `claude` is not on the jobs
 * PATH (an nvm install), the tend log says so on every tick, and the shell
 * log shows the launch. The scene the screen exists for. */
const DIAG_AT = new Date(minsAgo(0)).toISOString();
export const DIAGNOSTICS_STUCK: DiagnosticsReport = {
  facts: {
    at: DIAG_AT,
    engine: "/Applications/BigBrain.app/Contents/Resources/resources/engine",
    bundle: "engine 10c91dd\nbuilt 2026-09-02T19:45:10Z",
    supervisor: 17360,
    supervisorAlive: true,
    vault: "/Users/dana/vault",
    platform: "darwin arm64",
    bun: "1.3.9",
    jobsPath: "/Users/dana/.local/bin:/Applications/BigBrain.app/Contents/MacOS:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    claude: { path: null, loggedIn: true, account: "dana@example.com" },
    auth: { mode: "max", keyPresent: false },
    // the pass's last attempt died on the same missing `claude`; the clock
    // moved a day, and this is the one place that says so
    memory: {
      lastRunAt: new Date(minsAgo(26 * 60)).toISOString(),
      nextRunAt: new Date(minsAgo(-(22 * 60 + 40))).toISOString(),
      failed: {
        run: "2026-09-02T18-20-04-112Z-k3p9",
        at: new Date(minsAgo(80)).toISOString(),
        error: "memory: claude -p failed (null): spawn claude ENOENT",
      },
    },
    nextFires: { tend: minsAgo(-3), publish: minsAgo(-11), granola: minsAgo(-4), "agent-chat": minsAgo(-1) },
    intake: { running: false, lockPid: null },
  },
  logs: [
    {
      name: "tend", path: "/Users/dana/vault/.state/logs/tend.log", total: 412, bytes: 38_120, modified: new Date(minsAgo(2)).toISOString(), missing: false,
      lines: [
        "tend: nothing due",
        "tend: nothing due",
        "tend: round 1: spawn claude ENOENT — is `claude` on the jobs PATH? (/Users/dana/.local/bin:/Applications/BigBrain.app/Contents/MacOS:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin)",
        "tend: 0 settled, 3 remaining",
        "tend: round 1: spawn claude ENOENT — is `claude` on the jobs PATH? (/Users/dana/.local/bin:/Applications/BigBrain.app/Contents/MacOS:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin)",
        "tend: 0 settled, 3 remaining",
      ],
    },
    { name: "api", path: "/Users/dana/vault/.state/logs/api.log", total: 9, bytes: 812, modified: new Date(minsAgo(14)).toISOString(), missing: false,
      lines: ["api: listening on :4748", "api: drop landed ins_4c1f… (web, 18KB)", "api: drop landed ins_9a02… (web, 6KB)", "api: drop landed ins_b7e3… (agent-chat, 41KB)"] },
    { name: "web", path: "/Users/dana/vault/.state/logs/web.log", total: 3, bytes: 240, modified: new Date(minsAgo(14)).toISOString(), missing: false,
      lines: ["assertion projection warm in 212ms", "viewer: serving web/ui/dist on :4747", "viewer: 1 live stream"] },
    { name: "publish", path: "/Users/dana/vault/.state/logs/publish.log", total: null, bytes: 0, modified: null, missing: true, lines: [] },
    {
      name: "shell", path: "/Users/dana/Library/Logs/cool.bigbrain.desktop/BigBrain.log", total: null, bytes: 1_402_113, modified: new Date(minsAgo(1)).toISOString(), missing: false,
      lines: [
        "[2026-09-02][19:40:21][bigbrain_desktop_lib][INFO] vault /Users/dana/vault",
        "[2026-09-02][19:40:21][bigbrain_desktop_lib][INFO] engine /Applications/BigBrain.app/Contents/Resources/resources/engine (Bundle)",
        "[2026-09-02][19:40:21][bigbrain_desktop_lib][INFO] engine supervisor pid 17360 (its own process group)",
        "[2026-09-02][19:40:21][bigbrain_desktop_lib][INFO] engine: desktop 19:40:21: vault /Users/dana/vault; 6 jobs (api, web, tend, publish, granola, agent-chat)",
        "[2026-09-02][19:40:21][bigbrain_desktop_lib][INFO] no update: this is the newest version",
      ],
    },
  ],
};

export const SETTINGS: Record<string, VaultState> = {
  codexVault: {
    label: "Vault — shared Codex model", note: "One selection for gardener and memory, with models from both agent sessions.",
    ...SETTLED, recent: LANDED, queue: EMPTY_QUEUE,
    setup: { ...SETUP_LIVE, codex: { installed: "0.153.4", supported: true, account: "", connected: true, plugin: "0.1.18" } },
    config: { gardener: "gpt-example", memory: "gpt-example", curation: { agent: "codex", model: "gpt-example" } }, view: "vaultSettings",
  },
  codexAgents: {
    label: "Agents — Claude and Codex", note: "Independent connections; hook approval stays in Codex.",
    ...SETTLED, recent: LANDED, queue: EMPTY_QUEUE,
    setup: { ...SETUP_LIVE, codex: { installed: "0.153.4", supported: true, account: "", connected: true, plugin: "0.1.18" } }, view: "agents",
  },
  vault: {
    label: "1 · vault — the folder in use",
    note: "Settings → vault, first on the rail since everything hangs off it. The card is the eyebrow line (VAULT, the path in use), a Switch vault heading with first run's picker — Create new / Open — and, since 2026-08-27, the Filter: the FILED BY chips that sat under the home graph and under a note's neighbourhood. Off chips are dimmed; the count says what's showing. `web` reads as `dropped`; the grouped legacy family `other` is no chip at all — its items always show. The choices are the ones the feed and every graph obey.",
    ...SETTLED,
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: SETUP_LIVE,
    view: "vaultSettings",
  },

  themes: {
    label: "1b · themes — the palette this machine wears",
    note: "Settings → themes: the nine palettes the comp carries, each swatch PAINTED IN THE THEME IT OFFERS (data-theme on the box, the same mechanism the app uses), plus FOLLOW THE SYSTEM — the default, and what the app did before this screen existed — and after them this machine's own SKINS: YAML files in ~/.config/bigbrain/themes/, served by the engine as CSS (lib/themes.ts) and injected before the first paint (lib/theme.ts). Here the folder holds Solarized Light (the shipped example) and a minimal Gruvbox, plus half-done.yaml, which the card below the grid names with its reason. The three dots are the background, foreground, and activity colors. Click one and the whole workbench repaints, because the choice lands on the real document root (localStorage) — set it back to Follow the system when you are done looking. WRITE EXAMPLE SKIN and OPEN FOLDER answer here without a folder to write or open.",
    ...SETTLED,
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: SETUP_LIVE,
    skins: SKINS_DEMO,
    view: "themes",
  },

  shortcuts: {
    label: "1c · keyboard hints",
    note: "Toggle keyboard hints without changing control positions.",
    ...SETTLED,
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: SETUP_LIVE,
    view: "vaultSettings",
  },

  diagnostics: {
    label: "1d · diagnostics — a machine that cannot garden",
    note: "Settings → diagnostics (#710): the facts up top — engine, vault, supervisor, whether `claude` is on the jobs PATH and signed in, each job's next fire, the intake lock — then the tail of every log the app writes, tend first, the shell's own last. Here `claude` is NOT on the jobs PATH (an nvm install) and tend.log says so on every tick: the screen exists for this state. COPY DEBUG BUNDLE puts the same thing on the clipboard as text; RUN CHECK makes the `claude -p` call the scheduled tick makes (the workbench answers it at once); REVEAL LOGS opens the folder (no OS here — the path is shown instead).",
    ...SETTLED,
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: SETUP_LIVE,
    diagnostics: DIAGNOSTICS_STUCK,
    view: "diagnostics",
  },

  agentsConnected: {
    label: "2 · agents — connected",
    note: "The steady state of the agents card: 'connected' in green at the top right, then reported BigBrain tokens and a separate account quota reading — the capture switch, and the LIVE credentials with REVOKE — revoked ones are not listed. The top bar's dot is green here: under the app it means a Claude Code is connected, not that the stream is up.",
    ...SETTLED,
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: SETUP_LIVE,
    usage: USAGE_WEEK,
    view: "agents",
  },

  agentsSixHourly: {
    label: "2e · agents — a vault sweeping every six hours",
    note: "The note under the memory model reads the vault's own memory.interval off /api/config (ms; 0.1.29) — 'Runs every 6 hours.' here, 'Runs once per day.' on the default and on an older engine that does not send the number. Nothing in the UI sets the interval yet; vault.yaml does.",
    ...SETTLED,
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: SETUP_LIVE,
    usage: USAGE_WEEK,
    config: { gardener: "claude-opus-5", memory: "claude-fable-5", interval: 6 * 3_600_000 },
    view: "agents",
  },
  agentsSignedOut: {
    label: "2f · agents — connected, but Claude Code is signed out",
    note: "A tester's 2026-09-02: the credential is live, so this card said 'connected' in green while every intake round failed on a signed-out Claude Code. Now the headline is the blocker — NOT SIGNED IN in the warn colour, the plan meter withheld — and the check row below says what to run. Claude Code's own `claude auth status` is the source (lib/firstRun.ts claudeStatus), not the account name its config keeps after a logout. The top bar's dot goes grey for the same reason, with the word in its tooltip.",
    ...SETTLED,
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: { ...SETUP_LIVE, claude: { ...CLAUDE_OK, account: null } },
    usage: USAGE_WEEK,
    view: "agents",
  },

  agentsPluginStale: {
    label: "2e · agents — the plugin is behind the engine",
    note: "Connected, but Claude Code's installed bigbrain plugin is 0.1.5 and this engine ships 0.1.6 — the check row says both, and UPDATE closes the gap without quitting the app (the next launch would do it too). Click it: the row comes forward to 0.1.6 and the button goes, because the drift is gone. Claude Code caches a plugin by version, so this is the one drift the person could otherwise never see (lib/pluginState.ts).",
    ...SETTLED,
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: { ...SETUP_LIVE, claude: { ...CLAUDE_OK, plugin: { ...PLUGIN_OK, installed: "0.1.5", current: false } } },
    usage: USAGE_WEEK,
    view: "agents",
  },

  agentsUsageHeavy: {
    label: "2b · agents — high account usage",
    note: "The account has used 62% of its weekly quota. BigBrain token counts remain separate; no quota attribution is inferred.",
    ...SETTLED,
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: SETUP_LIVE,
    usage: usageWeek(.62),
    view: "agents",
  },

  agentsUsageStale: {
    label: "2c · agents — a reading the week rolled past",
    note: "The last run was before Wednesday's reset, so the meter it read is last week's. The bar keeps the true last number but dims it, the sub-line says 'reset Wed' instead of 'resets', and the caption says the next run refreshes it — never a fabricated 0%.",
    ...SETTLED,
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: SETUP_LIVE,
    usage: usageWeek(.2, true),
    view: "agents",
  },

  agentsUsageNone: {
    label: "2d · agents — connected, no reading yet",
    note: "Connected a minute ago; nothing has run. The bar's row says 'this week', an empty track, and the caption says the first gardener run fills it in. On api auth the whole block is absent instead — an API key has rate limits, not a usage window.",
    ...SETTLED,
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: SETUP_LIVE,
    view: "agents",
  },

  agentsModels: {
    label: "3 · agents — models: an alias and a pinned id",
    note: "The two model rows under the capture switch: the gardener on `opus` (an alias Claude Code resolves to the latest each run) and the memory pass pinned to `claude-opus-4-8` — which the menu shows as custom… with the id in the field, because the menu is the aliases only (a pinned list went stale within a week; lib/models.ts). Change one and the toast says which pass runs what from its next run; the save is vault.yaml's gardener.model / memory.model, posted to /api/config.",
    ...SETTLED,
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: SETUP_LIVE,
    config: { gardener: "opus", memory: "claude-opus-4-8" },
    view: "agents",
  },

  agentsModelCustom: {
    label: "4 · agents — a model the menu cannot name",
    note: "vault.yaml names `claude-opus-6`, which shipped after this menu did. The select says custom… and the field carries the id as typed — never coerced to the nearest thing the menu knows. Enter or blur saves; the same field is how anyone types an id ahead of the menu. The memory pass is on `sonnet`.",
    ...SETTLED,
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: SETUP_LIVE,
    config: { gardener: "claude-opus-6", memory: "sonnet" },
    view: "agents",
  },

  agentsRevoked: {
    label: "5 · agents — revoked, reconnect",
    note: "They revoked weeks ago. The card says so where 'connected' was, and its body is EXACTLY first run's step 2 — check row, terms, CONNECT — because reconnecting is the same act. What it is not is first run: the record of the old credential is what keeps the wizard away from someone who is plainly set up.",
    ...SETTLED,
    connections: [EXTENSION, AGENT_REVOKED],
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: { ...SETUP_LIVE, agent: REVOKED },
    view: "agents",
  },

  agentsNoClaude: {
    label: "6 · agents — Claude Code gone",
    note: "Revoked, and `claude` is no longer on the PATH (uninstalled, or a PATH that lost ~/.local/bin). Same card, and the check row says the true thing first — the button waits on Claude Code, not on the person. The fix line is the official installer.",
    ...SETTLED,
    connections: [EXTENSION, AGENT_REVOKED],
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: { ...SETUP_LIVE, claude: { installed: false, account: null }, agent: REVOKED },
    view: "agents",
  },

  headless: {
    label: "7 · agents — no desktop shell, no setup door",
    note: "The engine run from a checkout (`bun bin/desktop.ts`) with no app around it: /api/setup is 404 and /api/tokens absent. The card must not pretend — it names the CLI (`bigbrain connect` on that machine, `bigbrain auth create` for any other agent) and offers no button it cannot back. The vault section says the same about BIGBRAIN_VAULT.",
    ...SETTLED,
    connections: null,
    recent: LANDED,
    queue: EMPTY_QUEUE,
    view: "agents",
  },
};

/** Integrations as /api/config lists them once email and calendar are
 * pollers of the granola shape (#744): a credential BigBrain holds per
 * source — an inbox's app password, a calendar's ICS url — and the last
 * poll's word per source. */
const ADD_INBOX = {
  label: "ADD AN INBOX",
  noun: "inbox",
  fields: [
    { key: "address", label: "address", secret: false, placeholder: "you@example.com" },
    { key: "host", label: "imap host", secret: false, default: "imap.gmail.com" },
    { key: "password", label: "app password", secret: true },
  ],
};
const GRANOLA_ON: IntegrationInfo = {
  status: { state: "ok", label: "Up to date", checkedAt: "2026-09-12T17:00:00Z" },
  name: "granola", enabled: true, hasCode: true, hasTrigger: true,
  env: [{ env: "GRANOLA_API_KEY", label: "api key", secret: true, set: true }],
};
const EMAIL_ON: IntegrationInfo = {
  name: "email", enabled: true, hasCode: true, hasTrigger: true, env: [],
  sources: [
    { id: "alpha@example.com", label: "alpha@example.com", status: "ok", fields: { address: "alpha@example.com", host: "imap.gmail.com" } },
    { id: "alpha@fri.example.org", label: "alpha@fri.example.org", status: "ok", fields: { address: "alpha@fri.example.org", host: "imap.fri.example.org" } },
  ],
  add: ADD_INBOX,
};

export const INTEGRATIONS: Record<string, VaultState> = {
  browserNone: {
    label: "1 · integrations — no browser yet",
    note: "The browser extension is the first card on integrations, above whatever vault.yaml declares (here: nothing). It is a client, not an integration — no switch, no runner. GET CHROME EXTENSION and GET FIREFOX EXTENSION open their store listings in the system browser; PAIR A BROWSER is the one act. The agents credential is present but is not a browser, so the list is empty.",
    ...SETTLED,
    connections: [AGENT],
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: SETUP_LIVE,
    pair: PAIR_IDLE,
    view: "integrations",
  },

  browserCode: {
    label: "2 · integrations — code showing",
    note: "They clicked PAIR. The code is big and mono, a click copies it (the endpoint too); the countdown runs off the real clock; the endpoint to type is beside it. The card polls while the code is out, so when the extension redeems it the code disappears and the browser appears below without a reload. NEW CODE replaces it (there is only ever one outstanding).",
    ...SETTLED,
    connections: [AGENT],
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: SETUP_LIVE,
    pair: PAIR_CODE,
    view: "integrations",
  },

  browserPaired: {
    label: "3 · integrations — two browsers",
    note: "Two browsers paired on this machine, one of which has never captured. Each row is one token: name minted by the engine (`<browser> on <machine>`), paired-when, last capture from the token's last_used, and REVOKE. Revoking is the whole of 'disconnect' — the extension finds out on its next capture.",
    ...SETTLED,
    connections: [EXTENSION, FIREFOX, AGENT],
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: SETUP_LIVE,
    pair: PAIR_IDLE,
    view: "integrations",
  },

  tracking: {
    label: "integrations — That Tracks importing, Granola connected",
    note: "Import status and quiet successful polls remain visible beside the integration switch.",
    ...SETTLED, connections: [AGENT], recent: LANDED, queue: EMPTY_QUEUE,
    setup: SETUP_LIVE, pair: PAIR_IDLE, view: "integrations",
    integrations: [GRANOLA_ON, {
      name: "that-tracks", enabled: true, hasCode: true, hasTrigger: true,
      env: [{ env: "THAT_TRACKS_API_KEY", label: "api key", secret: true, set: true }],
      status: { state: "importing", label: "Importing history…" },
    }],
  },
  trackingFailed: {
    label: "integrations — revoked That Tracks key",
    note: "A failed poll remains enabled so replacing its key can recover automatically.",
    ...SETTLED, connections: [AGENT], recent: LANDED, queue: EMPTY_QUEUE,
    setup: SETUP_LIVE, pair: PAIR_IDLE, view: "integrations",
    integrations: [GRANOLA_ON, {
      name: "that-tracks", enabled: true, hasCode: true, hasTrigger: true,
      env: [{ env: "THAT_TRACKS_API_KEY", label: "api key", secret: true, set: true }],
      status: { state: "error", label: "That Tracks rejected the key. Replace it with a valid read key.", checkedAt: "2026-09-12T17:00:00Z" },
    }],
  },
  inboxes: {
    label: "5 · integrations — two inboxes",
    note: "Email is a poller of the granola shape: a credential BigBrain holds per inbox, read by the engine itself, so the triage runs inside tend's containment on a manifest the engine built (#744). A message is an event — it arrived once and never changes — so the poller keeps a cursor like granola's and each inbox is one line: the last poll's word as a dot, the address, and × to remove it. ADD AN INBOX asks for the three things IMAP needs.",
    ...SETTLED,
    connections: [AGENT],
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: SETUP_LIVE,
    pair: PAIR_IDLE,
    integrations: [GRANOLA_ON, EMAIL_ON],
    view: "integrations",
  },

  inboxFailed: {
    label: "6 · integrations — a password stopped working",
    note: "The work inbox's app password was revoked (a Workspace admin, a rotated password). The last poll said so, and the line says it in the warn colour with nothing else changed: the other inbox keeps polling, the switch stays on. FIX opens the form with the address and host filled and only the password to retype.",
    ...SETTLED,
    connections: [AGENT],
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: SETUP_LIVE,
    pair: PAIR_IDLE,
    integrations: [GRANOLA_ON, { ...EMAIL_ON, sources: [EMAIL_ON.sources![0]!, { ...EMAIL_ON.sources![1]!, status: "failed", detail: "password rejected · 2h ago" }] }],
    view: "integrations",
  },

  browserOldHost: {
    label: "4 · integrations — host without the route",
    note: "A viewer served by an engine older than the pairing route: /api/pair is 404. The card says the engine isn't answering rather than offering a button it cannot back.",
    ...SETTLED,
    connections: [EXTENSION, AGENT],
    recent: LANDED,
    queue: EMPTY_QUEUE,
    setup: SETUP_LIVE,
    pair: null,
    view: "integrations",
  },
};

// ── the stub ────────────────────────────────────────────────────────────────

let current: VaultState = FIRST_RUN.noVault!;
let pilotBackend = { ...DEFAULT_PILOT_BACKEND };
let agentPermissions: import("../../../../lib/workPermissions").WorkPermissions = { version: 2, folders: [{ path: "~/Projects", access: "write" }] };

/** Swap the vault out from under a running app. The SWR cache has to go with
 * it, or the first paint of the new state is the old one's data. */
export function setVaultState(s: VaultState): void {
  current = s;
  pilotBackend = { ...DEFAULT_PILOT_BACKEND };
  agentPermissions = { version: 2, folders: [{ path: "~/Projects", access: "write" }] };
  clearSwrCache();
  clearNoteBriefingCache();
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Answer the routes the app actually calls. Anything unrouted 404s loudly
 * rather than hanging — an endpoint this harness has not thought about
 * should look like a hole, not like a slow server. */
/** A pending code as the engine would serve it: ten minutes from NOW, the
 * real now, so the card's countdown is a countdown. */
const servePair = (p: PairState | null | undefined): Response => {
  if (p === null) return json({ error: "no such route" }, 404);
  const s = p ?? PAIR_IDLE;
  if (!s.pending) return json(s);
  const t = Date.now();
  return json({ ...s, pending: { ...s.pending, created: new Date(t - 60_000).toISOString(), expires: new Date(t + 9 * 60_000).toISOString() } });
};

function route(path: string, method: string, body?: string, search?: URLSearchParams): Response {
  // Sample-vault previews never transmit feedback. The workbench can simulate
  // success/failure explicitly; otherwise match an unconfigured build.
  if (path === "/api/feedback" && method === "POST") {
    const mode = new URLSearchParams(location.search).get('feedback');
    if (mode === 'success') return json({ ok: true });
    if (mode === 'failure') return json({ error: 'Simulated connection failure. Your draft is still here. Switch the preview to success, then try again.' }, 502);
    return json({ error: "Feedback delivery is not set up yet. Keep this draft and try after updating BigBrain." }, 503);
  }
  if (path === "/api/telemetry") {
    if (!current.telemetry) return json({ error: "no telemetry here" }, 404);
    const update = JSON.parse(body ?? "{}");
    if (method === "POST" && typeof update.enabled === "boolean")
      current.telemetry = { ...current.telemetry, enabled: update.enabled, decided: true };
    return json(current.telemetry);
  }
  if (path === "/api/note/briefing") {
    if (current.briefing === "error") return json({ error: "The briefing could not be written. Try again." }, 400);
    if (current.briefing === "loading") return new Response(new ReadableStream({ start() {} }));
    const request = JSON.parse(body ?? "{}");
    const graph = current.graph;
    const selected: string[] = request.selected ?? [request.path];
    const node = graph?.nodes[findNode(graph.nodes, selected[0] ?? "")];
    const asked = node?.path;
    const neighbors = graph ? contextConnections(graph, selected, request.excluded ?? []).map(({ node }) => node.id) : [];
    const descriptions: Record<string, string> = {
      "Maya Chen": "coordinates the expansion",
      "Atlas — September update": "records the lease setback",
      "Project notebook": "collects expansion plans",
    };
    const ordered = neighbors;
    const response = { briefing: { key: `fixture:${asked}`, model: "haiku", generatedAt: "2026-09-13T12:00:00Z",
      summary: current.noteSummary ? current.noteSummary(selected) : selected.length > 1 ? "Atlas is a neighborhood tool library; Maya Chen coordinates its proposed expansion. Their shared planning notebook and September update document the postponed second location after its lease fell through." : node?.group === "entity" ? "Atlas is a volunteer-run neighborhood tool library planning a second location with its local community."
        : node?.group === "memory" ? "Planning notes connect Atlas’s proposed expansion with its coordinator and the September lease update."
        : "A September project update describing Atlas’s postponed expansion and the people coordinating its next steps.",
      links: ordered.flatMap((id, i) => { const n = graph?.nodes.find(n => n.id === id); return n?.path ? [{ id: n.id, path: n.path, title: n.title,
        ...(i < 10 ? { description: current.noteSummary ? "connects the selected messages" : descriptions[n.title] ?? "is the library described" } : {}),
        evidence: [{ path: asked, text: current.noteSummary ? "Sample messages grouped by their shared conversation topic." : "Atlas is a neighborhood tool library. Maya coordinates its expansion; the September update records the failed lease." }],
      }] : []; }),
    } };
    if (current.streamBriefing && request.stream) {
      let first: ReturnType<typeof setTimeout>, last: ReturnType<typeof setTimeout>;
      return new Response(new ReadableStream({ start(controller) {
        const emit = (value: unknown) => controller.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n"));
        first = setTimeout(() => emit({ type: "preview", text: response.briefing.summary }), 50);
        last = setTimeout(() => {
          emit(current.failBriefingLinks ? { type: "error", error: "A relationship was missing its supporting evidence. Try again." }
            : { type: "complete", briefing: response.briefing });
          controller.close();
        }, 1200);
      }, cancel() { clearTimeout(first); clearTimeout(last); } }), { headers: { "content-type": "application/x-ndjson" } });
    }
    return json(response);
  }
  if (path === "/api/pilot/handoffs") return json({ jobs: [] });
  if (path === "/api/pilot/work") {
    const id = search?.get("id");
    if (id) return json(current.workSessions?.find(s => s.id === id) ?? { error: "Session not found" });
    return json({ sessions: (current.workSessions ?? []).map(({ messages: _m, receipts: _r, pending, ...rest }) => ({ ...rest, pending: !!pending, attention: workAttention({ ...rest, pending, messages: _m, receipts: _r }) })) });
  }
  if (path.startsWith("/api/pilot/work/") && method === "POST") {
    const args = JSON.parse(body ?? "{}");
    const session = current.workSessions?.find(s => s.id === args.id);
    if (!session) return json({ error: "Select a fixture session" }, 400);
    if (path.endsWith("/send")) session.messages.push({ id: crypto.randomUUID(), role: "user", text: args.text, at: new Date().toISOString() });
    if (path.endsWith("/stop")) session.status = "interrupted";
    if (path.endsWith("/announce")) {
      const attention = workAttention(session);
      if (!attention || attention.key !== args.requestKey || attention.announced) return json({ claimed: false });
      if (session.pending) session.pending.announced = true;
      else if (session.completion) session.completion.announced = true;
      return json({ claimed: true });
    }
    if (path.endsWith("/respond")) {
      if (workAttention(session)?.key !== args.requestKey) return json({ error: "This request is no longer pending" }, 400);
      session.messages.push({ id: crypto.randomUUID(), role: "user", text: Object.values(args.answer.answers ?? {}).map((a: any) => a.answers.join(", ")).join("\n") || args.answer.decision, at: new Date().toISOString() });
      delete session.pending; session.status = "working"; session.updated = new Date().toISOString();
      // Offline demonstration: the worker consumes the answer, reports, and rests.
      setTimeout(() => {
        session.messages.push({ id: crypto.randomUUID(), role: "agent", text: "Applied your answer and finished the update. Checks pass.", at: new Date().toISOString() });
        session.status = "idle"; session.updated = new Date().toISOString();
      }, 1600);
    }
    if (path.endsWith("/open")) {
      if (["starting", "working", "needs-input"].includes(session.status)) return json(session);
      session.status = "terminal"; delete session.pending;
      setTimeout(() => { session.status = "idle"; session.updated = new Date().toISOString(); }, 1600);
    }
    if (path.endsWith("/terminal")) session.status = args.release ? "terminal" : "idle";
    return json(session);
  }

  if (path === "/api/entity/folds/accept" && method === "POST") {
    // the aliased members leave the census, so the group leaves the view
    const { canonical, members } = JSON.parse(body ?? "{}") as { canonical: string; members: string[] };
    const gone = new Set(members);
    current = { ...current, folds: (current.folds ?? []).map((g) => ({ ...g, members: g.members.filter((m) => !gone.has(m.id)) })).filter((g) => g.members.length > 1) };
    return json({ canonical: { id: canonical, label: canonical }, aliased: members.map((id) => ({ id, label: id })) });
  }
  if (path === "/api/entity/folds/reject" && method === "POST") {
    const { member } = JSON.parse(body ?? "{}") as { member: string; others: string[] };
    current = { ...current, folds: (current.folds ?? []).map((g) => ({ ...g, members: g.members.filter((m) => m.id !== member), canonical: g.canonical === member ? (g.members.find((m) => m.id !== member)?.id ?? g.canonical) : g.canonical })).filter((g) => g.members.length > 1) };
    return json({ member: { id: member, label: member }, against: [] });
  }
  if (path === "/api/entity/folds")
    return current.folds ? json({ proposedAt: current.folds.length ? "2026-09-03T18:05:43.066Z" : null, model: "claude-x", groups: current.folds }) : json({ error: "no folds door here" }, 404);
  if (path === "/api/pair" && method === "POST") {
    // PAIR A BROWSER: the scene gains a code; it stays until the scene changes
    current = { ...current, pair: PAIR_CODE };
    return servePair(current.pair);
  }
  if (path === "/api/setup/plugin" && method === "POST") {
    // UPDATE on the check row. The scene's plugin comes forward to the
    // shipped version, so the row a click changes is the row you were
    // looking at — a stub that answered without moving the state would make
    // a working button look broken.
    const setup = current.setup;
    const plugin = setup?.claude.plugin;
    if (!setup || !plugin) return json({ error: "no setup door here" }, 404);
    const next = { ...plugin, installed: plugin.shipped, current: true };
    current = { ...current, setup: { ...setup, claude: { ...setup.claude, plugin: next } } };
    clearSwrCache();
    clearNoteBriefingCache();
    return json({ ...current.setup, pluginRefresh: { outcome: "refreshed" } });
  }
  // the pilot (#770): the key saves (and the state re-reads it); a session
  // cannot be minted here; the demo says voice is unavailable.
  // The rest answer as the engine would with nothing to do.
  if (path === "/api/pilot/permissions" && method === "POST") {
    agentPermissions = JSON.parse(body ?? "{}");
    return json({ ...pilotWireState(false, false), permissions: agentPermissions });
  }
  if (path === "/api/pilot/enabled" && method === "POST") {
    const { enabled } = JSON.parse(body ?? "{}") as { enabled: boolean };
    current = { ...current, pilot: { ...(current.pilot ?? { configured: false }), enabled } };
    return json(pilotWireState(current.pilot!.configured, enabled));
  }
  if (path === "/api/source/read-state") {
    if (method === "POST") {
      const request = JSON.parse(body ?? "{}");
      current.sourceReadStates = (current.sourceReadStates ?? []).map(row => request.paths?.includes(row.path)
        ? { ...row, readState: { ...row.readState, unread: !!request.unread } } : row);
      return json({ ok: true, results: current.sourceReadStates.filter(row => request.paths?.includes(row.path)).map(row => ({ ...row, ok: true })) });
    }
    return json({ sources: current.sourceReadStates ?? [], scope: "stored_sources" });
  }
  if (path === "/api/pilot/chat/notifications") return json({ notifications: [] });
  if (path === "/api/pilot/chat/backend") {
    if (method === "POST") pilotBackend = JSON.parse(body ?? "{}").backend;
    return json(pilotBackend);
  }
  if (path === "/api/pilot/key" && method === "POST") {
    const { key } = JSON.parse(body ?? "{}") as { key?: string };
    current = { ...current, pilot: { ...(current.pilot ?? { configured: false }), configured: !!(key ?? "").trim() } };
    return json(pilotWireState(current.pilot!.configured, current.pilot!.enabled ?? current.pilot!.configured));
  }
  if (path === "/api/pilot/secret" && method === "POST")
    return json({ error: "Voice is unavailable in this demo" }, 503);
  if (path === "/api/pilot/tool" && method === "POST") return json({ result: {} });
  if (path === "/api/pilot/turn" && method === "POST") return json({ turns: 1 });
  if (path === "/api/pilot/end" && method === "POST") return json({ landed: null });
  if (path === "/api/config" && method === "POST") {
    // The model rows (and the capture switch) save here. Keep what the
    // rows set, so the card's re-read shows the choice — a save that
    // vanished on reload would look like a bug in the card, not the harness.
    let patch: {
      curation?: { agent: "claude" | "codex"; model: string };
      gardener?: ModelChoice;
      memory?: ModelChoice;
      quick?: ModelChoice;
      integrations?: { name: string; enabled?: boolean; add?: Record<string, string>; remove?: string }[];
    } = {};
    try {
      patch = JSON.parse(body ?? "{}") as typeof patch;
    } catch {
      return json({ error: "bad json" }, 400);
    }
    const cfg = current.config ?? DEFAULT_CONFIG;
    // an integration's switch, or one of its options: applied to the
    // scene's list, so the row re-reads what it set
    const integrations = current.integrations?.map((i) => {
      const op = patch.integrations?.find((o) => o.name === i.name);
      if (!op) return i;
      let sources = i.sources;
      if (sources && op.remove) sources = sources.filter((src) => src.id !== op.remove);
      if (sources && op.add) {
        // the add form's first field names the source; a re-add replaces
        const id = Object.values(op.add)[0] ?? "";
        const fields = Object.fromEntries(Object.entries(op.add).filter(([k]) => !i.add?.fields.find((f) => f.key === k)?.secret));
        sources = sources.some((src) => src.id === id)
          ? sources.map((src) => (src.id === id ? { ...src, status: "ok" as const, detail: undefined, fields } : src))
          : [...sources, { id, label: id, status: "ok" as const, fields }];
      }
      return { ...i, enabled: op.enabled ?? i.enabled, ...(sources ? { sources } : {}) };
    });
    current = {
      ...current,
      config: { ...cfg, curation: patch.curation ?? cfg.curation, gardener: patch.gardener?.model ?? cfg.gardener, memory: patch.memory?.model ?? cfg.memory,
        roles: { ...cfg.roles, ...(patch.gardener ? { gardener: patch.gardener } : {}), ...(patch.memory ? { memory: patch.memory } : {}), ...(patch.quick ? { quick: patch.quick } : {}) } },
      ...(integrations ? { integrations } : {}),
    };
    return json({ changed: ["vault.yaml"], committed: true });
  }
  // settings › diagnostics (#710), the two acts: the probe answers at once
  // here (no claude to ask); reveal says it could not (no OS to open a
  // folder in) so the screen shows the path instead
  if (path === "/api/diagnostics/probe" && method === "POST")
    return json({ name: "claude-probe", ok: false, level: "fail", detail: "headless claude failed: spawn claude ENOENT", fix: "run `claude`, log in, and retry — this is the same call the scheduled editor makes" });
  if (path === "/api/diagnostics/reveal" && method === "POST") return json({ ok: false, path: current.diagnostics?.facts.vault ? `${current.diagnostics.facts.vault}/.state/logs` : "" });
  // settings › themes, the two acts on the skins folder: no OS to open it
  // in, and the example is "already there" — the report does not change
  if (path === "/api/themes/reveal" && method === "POST") return json({ ok: false, path: current.skins?.dir ?? "" });
  if (path === "/api/themes/example" && method === "POST") return json({ ok: true, path: `${current.skins?.dir ?? ""}/solarized-light.yaml`, existed: true });
  if (method !== "GET" && method !== "HEAD") return json({ ok: true });
  if (path === "/api/pair") return servePair(current.pair);
  if (path === "/api/vault") return json({ ...current.vault, queue: current.queue });
  if (path === "/api/recent") return json({ recent: current.recent, nextOffset: null, total: current.recent.length });
  if (path === "/api/graph") return json(current.graph);
  if (path === "/api/agents/models" || path === "/api/pilot/chat/models") return json({ agents: [
    { id: "claude", label: "Claude Code", ready: !!current.setup?.claude.account, models: ["opus", "sonnet", "haiku", "fable"].map(id => ({ id, label: id, reasoning: id === "haiku" ? [] : ["low", "medium", "high", "xhigh", "max"] })) },
    { id: "codex", label: "Codex", ready: !!current.setup?.codex?.connected, models: current.setup?.codex?.connected ? [
      { id: "gpt-example", label: "Example Codex model", reasoning: ["low", "medium", "high"] },
      { id: "gpt-5.6-terra", label: "Terra", reasoning: ["low", "medium", "high", "xhigh"] },
    ] : [] },
  ] });
  if (path === "/api/setup") return current.setup ? json(current.setup) : json({ error: "no setup door here" }, 404);
  // settings › diagnostics (#710): the report, its text twin, and the two
  // acts — the probe answers at once here (no claude to ask), reveal says
  // it could not (no OS to open a folder in) so the path shows
  if (path === "/api/diagnostics") return current.diagnostics ? json(current.diagnostics) : json({ error: "no diagnostics here" }, 404);
  if (path === "/api/themes") return current.skins ? json(current.skins) : json({ error: "no themes door here" }, 404);
  if (path === "/api/diagnostics.txt") {
    const d = current.diagnostics;
    if (!d) return json({ error: "no diagnostics here" }, 404);
    const text = [`BigBrain diagnostics — ${d.facts.at} (workbench)`, `vault       ${d.facts.vault}`, `claude      ${d.facts.claude.path ?? "NOT FOUND on the jobs PATH"}`, "",
      ...d.logs.map((l) => [`── ${l.name}: ${l.path} ──`, ...l.lines].join("\n"))].join("\n");
    return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (path === "/api/usage") return serveUsage(current.usage);
  // the agents card reads the capture flag and the two pass models off this
  if (path === "/api/pilot") return json({ ...pilotWireState(current.pilot?.configured ?? false, current.pilot?.enabled ?? current.pilot?.configured ?? false), permissions: agentPermissions });
  if (path === "/api/config") {
    const cfg = current.config ?? DEFAULT_CONFIG;
    return json({
      integrations: current.integrations ?? [{ name: "agent-chat", enabled: true, env: [] }],
      curation: cfg.curation ?? null,
      gardener: cfg.roles?.gardener ?? { adapter: cfg.curation?.agent === "codex" ? "pi" : "claude", ...(cfg.curation?.agent === "codex" ? { provider: "openai-codex" } : {}), model: cfg.gardener },
      memory: { ...(cfg.roles?.memory ?? { adapter: cfg.curation?.agent === "codex" ? "pi" : "claude", ...(cfg.curation?.agent === "codex" ? { provider: "openai-codex" } : {}), model: cfg.memory }), interval: cfg.interval ?? 86_400_000 },
      quick: cfg.roles?.quick ?? { adapter: "claude", model: "haiku" },
    });
  }
  if (path.startsWith("/api/notes")) return json({ dir: "", notes: [] });
  if (path.startsWith("/api/search")) return json({ query: "", hits: [] });
  if (path.startsWith("/api/note")) {
    const notePath = search?.get("path") ?? "";
    const session = current.workSessions?.find(s => sessionPath(s.id) === notePath);
    if (session) return json({ path: notePath, content: sessionMarkdown(session), modified: Date.parse(session.updated) });
    return json(current.notes?.[notePath] ?? { path: notePath, content: "" });
  }
  if (path === "/api/tokens")
    return current.connections === null
      ? json({ error: "no such route" }, 404)
      : json({ tokens: current.connections });
  return json({ error: `fakeApi has no route for ${path}` }, 404);
}

/** Install once. Later scene switches go through setVaultState, so the app
 * keeps its identity (and its hash route) across a change of world. */
export function installFakeApi(): void {
  const w = window as unknown as { fetch: unknown; EventSource: unknown };
  w.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    const u = new URL(url, location.origin);
    return route(u.pathname, method, body, u.searchParams);
  };
  // The live dot reads this. A fabricated vault is a CONNECTED vault — the
  // disconnected state is its own scene to write, not an accident of the
  // harness having no server.
  class FakeEventSource {
    onopen: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    constructor() {
      setTimeout(() => this.onopen?.(new Event("open")), 0);
    }
    private listeners = new Map<string, Set<(event: MessageEvent) => void>>();
    private receive = (event: Event) => { for (const fn of this.listeners.get("application") ?? []) fn(new MessageEvent("application", { data: JSON.stringify((event as CustomEvent).detail) })); };
    close(): void { window.removeEventListener("workbench-application", this.receive); }
    addEventListener(name: string, fn: (event: MessageEvent) => void): void {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name)!.add(fn);
      window.addEventListener("workbench-application", this.receive);
    }
    removeEventListener(name: string, fn: (event: MessageEvent) => void): void { this.listeners.get(name)?.delete(fn); }
  }
  w.EventSource = FakeEventSource;
}


// ── the pilot (#770) ────────────────────────────────────────────────────────
const PILOT_MODEL = "gpt-realtime-2.1-mini";
function pilotWireState(configured: boolean, enabled: boolean) {
  return { configured, enabled, status: !configured ? "unconfigured" : enabled ? "ready" : "disabled", model: PILOT_MODEL, voice: "marin" };
}
const PILOT_ASKED: Line = { speaker: "user", text: "anything new in my inbox today?" };
const PILOT_ANSWERED: Line = {
  speaker: "pilot",
  text: "Two things landed this morning: a Semafor piece on the ridgeways, and Ada's note about the Tuesday review. Want me to open either?",
  tools: ["recent", "status"],
};
const PILOT_HOME: Omit<VaultState, "label" | "note"> = { ...SETTLED, recent: LANDED, queue: EMPTY_QUEUE, setup: SETUP_LIVE, view: "home" };

/** The pilot's screens: settings › pilot with and without a key, then the
 * HUD in every phase. The phases are written into the store by the
 * workbench (there is no session here); a real hold mints against the
 * fake's 401, which is the error scene happening live. */
export const PILOT: Record<string, VaultState> = {
  off: {
    label: "1 \u00b7 settings \u203a pilot \u2014 no key",
    note: "Vault settings with Pilot off. Enable the switch to reveal microphone and key options; switching off keeps the saved key.",
    ...PILOT_HOME,
    view: "vaultSettings",
  },
  on: {
    label: "2 \u00b7 settings \u203a pilot \u2014 key set",
    note: "Vault settings with Pilot enabled. Disabling hides the options and preserves the saved key. TEST uses the fake connection refusal.",
    ...PILOT_HOME,
    pilot: { configured: true },
    view: "vaultSettings",
  },
  idle: {
    label: "3 · idle — browsing",
    note: "Home with a key set: the pilot stays hidden until Space is held. Hold SPACE (outside the omnibox) and the demo's unavailable message appears \u2014 a real hold against a real engine connects instead.",
    ...PILOT_HOME,
    pilot: { configured: true, phase: "idle" },
  },
  listening: {
    label: "4 \u00b7 listening \u2014 the key is held",
    note: "Holding Space opens the conversation in the text tab; recognized words arrive after release.",
    ...PILOT_HOME,
    pilot: { configured: true, phase: "listening" },
  },
  thinking: {
    label: "5 \u00b7 thinking \u2014 tools in flight",
    note: "The text tab holds the recognized question while Pilot works. The graph retains the selected context.",
    ...PILOT_HOME,
    pilot: { configured: true, phase: "thinking", lines: [PILOT_ASKED], tools: ["recent", "status"] },
  },
  speaking: {
    label: "6 \u00b7 speaking \u2014 the reply streams",
    note: "The reply streams into the text tab. SPACE interrupts speech and starts the next hold.",
    ...PILOT_HOME,
    pilot: { configured: true, phase: "speaking", lines: [PILOT_ASKED], live: "Two things landed this morning: a Semafor piece on the", tools: ["recent", "status"] },
  },
  settled: {
    label: "7 \u00b7 settled \u2014 a turn each",
    note: "The reply settled: your line and its line, ready for the next hold. Both turns were posted to the engine, which lands the conversation as one arrival when it goes quiet.",
    ...PILOT_HOME,
    pilot: { configured: true, phase: "ready", lines: [PILOT_ASKED, PILOT_ANSWERED] },
  },
  error: {
    label: "8 \u00b7 error \u2014 the key was refused",
    note: "A short key rejection appears in the text tab. Settings \u203a pilot is where to fix it; the next hold tries again.",
    ...PILOT_HOME,
    pilot: { configured: true, phase: "error", error: "OpenAI key rejected" },
  },

};


PILOT.work = {
  ...PILOT_HOME,
  label: "Live sources",
  note: "Sessions share Recents and the graph with every source. Live rings rise above the graph; idle sessions settle back into history.",
  workSessions: [
    { id: "work-11111111111111111111111111111111", title: "Dashboard · change over time", cwd: "/projects/dashboard", provider: "codex", thread: "dashboard-thread", turn: "dashboard-turn", status: "working", context: { node: PILOT_HOME.graph.nodes[0]?.id }, created: "2026-09-08T15:00:00Z", updated: "2026-09-08T15:05:00Z", receipts: [], messages: [
      { id: "u1", role: "user", text: "Focus the frontend on the change-over-time graph and remove the separate HTML page.", at: "2026-09-08T15:00:00Z" },
      { id: "a1", role: "agent", text: "I found the separate chart page. I’m moving its graph into the dashboard and preserving the date controls.", at: "2026-09-08T15:01:00Z" }
    ] },
    { id: "work-22222222222222222222222222222222", title: "Paper · Methods section", cwd: "/projects/paper", provider: "codex", thread: "paper-thread", status: "needs-input", context: { node: PILOT_HOME.graph.nodes[1]?.id }, created: "2026-09-08T15:00:00Z", updated: "2026-09-08T15:04:00Z", receipts: [], messages: [
      { id: "u2", role: "user", text: "Look through the paper and highlight my sections.", at: "2026-09-08T15:00:00Z" }
    ], pending: { id: 7, method: "item/tool/requestUserInput", params: { questions: [{ id: "format", question: "Should I add comments in the source or produce a separate annotated copy?" }] } } }
  ],
};

PILOT.quiet = {
  ...PILOT.work,
  label: "Sessions at rest",
  note: "The same sources and context links, with no live markers or elevated depth.",
  workSessions: PILOT.work.workSessions?.map(s => ({ ...s, status: "idle", pending: undefined })),
};

PILOT.selected = {
  ...PILOT.work,
  label: "Selected note tab",
  note: "The selected session has its own tab after Pilot. O returns to the note; × closes it from any tab, and Escape closes it while selected. Long titles truncate within the strip.",
  pilot: { configured: true, phase: "idle" },
  hash: "/vault/sessions/work-11111111111111111111111111111111.md",
  workSessions: PILOT.work.workSessions?.map(s => ({ ...s, status: "working", pending: undefined })),
};

PILOT.attention = {
  ...PILOT.work,
  label: "Workers ask back",
  pilot: { configured: true, phase: "idle" },
  note: "Select any source to discuss it with Pilot. Sessions offer Open in terminal (Cmd-O); the offline demo simulates the handoff and return without opening a terminal, model, or microphone.",
  workSessions: PILOT.work.workSessions?.map((s, i) => ({ ...s, messages: [...s.messages], provider: i ? "claude-code" : "codex", status: "needs-input",
    pending: { id: i + 50, key: `offline-request-${i}`, method: "item/tool/requestUserInput", params: { questions: [{ id: "choice", question: i ? "Should I annotate the source or make a separate copy?" : "Should I preserve the standalone chart export?", options: [{ label: i ? "Annotate source" : "Preserve export" }, { label: i ? "Separate copy" : "Remove export" }] }] } },
  })),
};


PILOT.completed = {
  ...PILOT.work,
  label: "Finished agent",
  note: "A completed turn reports its result through the same notification queue, without a live marker or ingestion column.",
  workSessions: PILOT.work.workSessions!.slice(0, 1).map(s => ({ ...s, status: "idle", turn: undefined,
    completion: { key: "dashboard-completed", kind: "completed", text: "Dashboard updated. The change-over-time chart is now in the main view; checks pass." } })),
};


PILOT.visibility = {
  ...PILOT.work,
  label: "All arrivals, except Pilot in Recents",
  note: "Saved hiding preferences are ignored. Declined mail and both agent providers remain visible; Pilot is omitted only from Recents.",
  recent: [
    { path: "references/declined-mail.md", title: "Declined mail stays visible", modified: Date.now(), source: "email", from: "email", band: "person", status: "declined", type: "source", author: "email", action: "added" },
    { path: "references/pilot-chat.md", title: "Pilot conversation stays in the graph", modified: Date.now(), source: "pilot", from: "pilot", band: "agent", status: "record", type: "source", author: "pilot", action: "added" },
    ...PILOT_HOME.recent,
  ],
  graph: { ...PILOT_HOME.graph, nodes: [...PILOT_HOME.graph.nodes,
    { id: "references/declined-mail.md", path: "references/declined-mail.md", title: "Declined mail stays visible", group: "source", degree: 0 },
    { id: "references/pilot-chat.md", path: "references/pilot-chat.md", title: "Pilot conversation stays in the graph", group: "source", degree: 0 },
  ] },
};

PILOT.connecting = {
  ...PILOT.listening,
  label: "Getting ready to listen",
  note: "Hold Space through the spinner. Green appears only once the channel and microphone are ready.",
  pilot: { configured: true, phase: "connecting" },
};
