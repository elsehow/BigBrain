import { observeVault } from "./vaultScope";
import { receiveApplicationChange, applicationDisconnected } from "./applicationUpdates";
import { pushRoute, replaceRoute, initRouteHistory } from "./routeHistory.svelte";
import type { GardenerProgress } from "../../../../lib/gardenerProgressTypes";
import { openConversationAlias } from "./noteNavigation";
import { usageAction } from "./telemetry";
import { swr } from "./api";
import { RETRY_MIN_MS, nextRetryMs, retryDelayMs } from "./live";
import type { VaultInfo } from "./types";
import { isPilotChatId } from "../../../../lib/pilotChatTypes";
import { isNotePath } from "./noteRoute";
import { titleOf } from "./utils";
import type { GraphViewState } from "../../../../lib/graphView";

export type View =
  | "home"
  | "top"
  | "vault"
  | "graph"
  | "connectedClients"
  | "agentOrchestration"
  | "pilotSettings"
  | "integrations"
  | "agents"
  | "vaultSettings"
  | "themes"
  | "diagnostics"
  | "search";

export const app = $state({
  view: "home" as View,
  vault: null as VaultInfo | null,
  // live wiring: rev bumps on every server change ping (views re-fetch on it);
  // live reflects whether the SSE stream is currently connected.
  rev: 0,
  usageRev: 0,
  live: false,
  gardener: null as GardenerProgress | null,
  // routing state, all URL-derived (see applyHash): the open note and the
  // everywhere-search query.
  activeNote: null as string | null,
  routePilot: null as string | null,
  pilotAutofocus: true,
  // One portable membership state drives both graph and relationship text.
  graphView: { selected: [], excluded: [] } as GraphViewState,
  // One open note tab survives visits to Recent, Top, and Pilot until closed.
  noteTab: null as { path: string; title: string } | null,
  query: "",
  textTab: "recent" as "recent" | "top",
  searchSource: "",
});

export async function refreshVault(): Promise<void> {
  const { cached, fresh } = swr.vault(); // cache-first: the shell paints before the fetch lands
  if (cached && !app.vault) app.vault = cached;
  try {
    app.vault = await fresh;
  } catch {
    /* server down — views show their own empty states */
  }
}

// ── routing: the hash IS the state — #/ (home), #/queue, #/agents,
// #/vault/<dir>, #/vault/<note>, #/search/<query>. A note is either legacy
// Markdown or one immutable source-insertion event from the assertion-native
// feed. Every navigation writes
// the hash and state is derived back from it, so back/forward and deep links
// just work.
const enc = (p: string) => encodeURIComponent(p).replace(/%2F/gi, "/");

function parseHash(): { view: View; note: string | null; q: string; pilot?: string; source?: string } {
  const raw = location.hash.replace(/^#\/?/, "");
  const slash = raw.indexOf("/");
  const head = slash === -1 ? raw : raw.slice(0, slash);
  const rest = slash === -1 ? "" : raw.slice(slash + 1);
  if (head === "session" && isPilotChatId(rest)) return { view: "home", note: null, pilot: rest, q: "" };
  if (head === "session" && /^work-[a-f0-9]{32}$/.test(rest)) return { view: "vault", note: `sessions/${rest}.md`, q: "" };
  if (head === "search") {
    const [query, params] = rest.split("?");
    return { view: "search", note: null, q: decodeURIComponent(query), source: new URLSearchParams(params).get("source") ?? "" };
  }
  if (head === "vault") {
    let path = "";
    try {
      path = decodeURIComponent(rest);
    } catch {
      path = rest;
    }
    // Only single notes route here — there is no directory-listing view. The
    // native assertion architecture exposes source insertions as virtual
    // notes; their exact path is safe to route because both note endpoints
    // validate the same narrow log/insertions/<month>/ins_<id>.json shape.
    if (isNotePath(path)) return { view: "vault", note: path, q: "" };
    return { view: "home", note: null, q: "" };
  }
  if (head === "top") return { view: "top", note: null, q: "" };
  if (head === "graph") return { view: "graph", note: null, q: "" };
  if (head === "connectedClients" || (head === "settings" && rest === "connected-clients")) return { view: "connectedClients", note: null, q: "" };
  if (head === "connectedAgents" || head === "agentOrchestration" || (head === "settings" && rest === "agent-orchestration") || (head === "settings" && rest === "connected-agents")) return { view: "agentOrchestration", note: null, q: "" };
  if (head === "pilotSettings" || (head === "settings" && rest === "pilot")) return { view: "agents", note: null, q: "" };
  if (head === "connections" || (head === "settings" && rest === "connections")) return { view: "agentOrchestration", note: null, q: "" };
  if (head === "integrations") return { view: "integrations", note: null, q: "" };
  if (head === "agents" || head === "models" || (head === "settings" && rest === "models")) return { view: "agents", note: null, q: "" };
  // settings → vault: the folder in use. NOT #/vault — that head is the note
  // route above, so this one carries its own name (goto writes it) and
  // answers #/settings/vault as the readable spelling.
  if (head === "general" || (head === "settings" && rest === "general") || head === "vaultSettings" || (head === "settings" && rest === "vault"))
    return { view: "vaultSettings", note: null, q: "" };
  // settings → themes: the palette this machine wears (lib/theme.ts). Same
  // spelling rule as vault above — #/themes, and #/settings/themes reads.
  if (head === "themes" || (head === "settings" && rest === "themes"))
    return { view: "vaultSettings", note: null, q: "" };
  // Legacy shortcuts links now open its subsection in vault settings.
  if (head === "shortcuts" || (head === "settings" && rest === "shortcuts"))
    return { view: "vaultSettings", note: null, q: "" };
  // settings → diagnostics: the app's logs and this machine's facts (#710).
  // Same spelling rule.
  if (head === "diagnostics" || (head === "settings" && rest === "diagnostics"))
    return { view: "diagnostics", note: null, q: "" };
  // Legacy pilot links now open its subsection in vault settings.
  if (head === "pilot" || (head === "settings" && rest === "pilot"))
    return { view: "agents", note: null, q: "" };
  // the empty hash and anything unrecognized land on home — #/queue and the
  // desks that preceded it (#/config, #/inbox, #/intake, #/librarian,
  // #/triage) among them, now that the work-queue screen is gone. It read
  // the same queue home already reads for the ingest ETA and showed it as a
  // table nobody used; the endpoint stays, the screen does not.
  return { view: "home", note: null, q: "" };
}

function applyHash(preserveSelection = false): void {
  const s = parseHash();
  if (!preserveSelection && (s.note !== app.activeNote || (s.pilot ?? null) !== app.routePilot))
    app.graphView = { selected: s.pilot ? [s.pilot] : s.note ? [s.note] : [], excluded: [] };
  if (!preserveSelection && s.pilot) app.pilotAutofocus = false;
  app.routePilot = s.pilot ?? null;
  app.view = s.view;
  if (s.view === "top") app.textTab = "top";
  else if (s.view === "home" || s.view === "graph") app.textTab = "recent";
  app.activeNote = s.note;
  if (s.note && app.noteTab?.path !== s.note)
    app.noteTab = { path: s.note, title: titleOf(s.note.split("/").at(-1) ?? s.note) };
  app.query = s.q;
  app.searchSource = s.source ?? "";
}

export function goto(view: View): void {
  pushRoute(`#/${view}`);
  applyHash();
}

/** Jump straight to one note (from an intake decision or a wikilink). */
export function gotoNote(path: string, replace = false): void {
  // A Pilot's ingested source and legacy session paths are aliases for its
  // conversation, including links opened from the note browser.
  if (openConversationAlias(path, replace)) return;
  usageAction("note_opened");
  app.graphView = { selected: [path], excluded: [] };
  const hash = `#/vault/${enc(path)}`;
  if (location.hash !== hash) (replace ? replaceRoute : pushRoute)(hash);
  applyHash(true);
}

/** A Pilot is a navigable graph node, even before it has an ingested note. */
export function gotoPilot(id: string, replace = false): void {
  if (!isPilotChatId(id)) return;
  app.graphView = { selected: [id], excluded: [] };
  app.pilotAutofocus = true;
  const hash = `#/session/${id}`;
  if (location.hash !== hash) (replace ? replaceRoute : pushRoute)(hash);
  applyHash(true);
}

/** Reconcile membership without adding a second visit for the same Pilot. */
export function showPilotSelection(id: string): void {
  if (!isPilotChatId(id) || (app.routePilot === id && app.view === "home")) return;
  replaceRoute(`#/session/${id}`);
  applyHash(true);
}

/** Membership gestures update the text tab without making each edit a browser
 * history entry. The URL names a remaining anchor; the set stays in memory. */
export function showGraphSelection(path: string | null): void {
  if (!app.routePilot && path === app.activeNote && (!path || app.view === "vault")) return;
  replaceRoute(path ? `#/vault/${enc(path)}` : `#/${app.textTab === "top" ? "top" : "home"}`);
  if (!path) app.noteTab = null;
  applyHash(true);
}

/** The everywhere-search: entering search pushes ONE history entry (back
 * returns to where you were); further keystrokes replace it in place. */
export function gotoSearch(q: string, replace = false, source = app.searchSource): void {
  const h = `#/search/${encodeURIComponent(q)}${source ? `?source=${encodeURIComponent(source)}` : ""}`;
  if (replace) replaceRoute(h);
  else pushRoute(h);
  applyHash(); // sync now — the async hashchange re-applies harmlessly
}

// ── the live stream, supervised (#128) ──────────────────────────────────────
// `EventSource` retries a DROPPED connection by itself, and gives up
// permanently on one answered with an HTTP status. Both arrive in practice
// (routinely so behind the hosted era's proxy):
//
//   401  the session lapsed
//   502  the server is momentarily down — in the hosted era EVERY DEPLOY
//        restarted the viewer unit, killing the stream in every open tab,
//        for good
//
// The dot then sat dark for the life of the page with nothing said and no
// retry. Observed 2026-08-11: ~15 hours dark against a fully healthy server,
// recovered only by a redeploy plus a fresh load.
//
// So the retry is ours. Backoff is capped and jittered (a restart wakes every
// open tab at once, and they must not arrive together), and a returning tab or
// a returning network reconnects immediately rather than waiting out a backoff
// that grew while nobody was watching.
let es: EventSource | null = null;
let retryMs = RETRY_MIN_MS;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function connect(): void {
  es?.close();
  es = new EventSource("/api/events");
  es.addEventListener("vault", e => { observeVault(JSON.parse(e.data)); });
  es.addEventListener("usage", () => { app.usageRev++; });
  es.addEventListener("application", e => {
    try { receiveApplicationChange(JSON.parse(e.data)); } catch { applicationDisconnected(); }
  });
  es.addEventListener("gardener", e => {
    try { app.gardener = JSON.parse(e.data); } catch { /* ignore incomplete status */ }
  });
  es.onopen = () => {
    app.gardener = null;
    // Back after an outage (the engine restarted under us — a vault switch,
    // the first-run handover): every view re-reads. Without this the dot
    // went green while the feed kept saying the engine wasn't answering
    // (2026-08-27) — onmessage bumps rev only on a change ping, and a fresh
    // engine has nothing to ping about.
    const wasDown = !app.live;
    app.live = true;
    retryMs = RETRY_MIN_MS; // a good connection earns the next failure a fast retry
    if (wasDown) app.rev++;
  };
  es.onerror = () => {
    applicationDisconnected();
    app.gardener = null;
    app.live = false;
    es?.close(); // it will not retry an HTTP-status error itself; don't leave it half-open
    scheduleReconnect();
  };
  es.onmessage = (e) => {
    try {
      JSON.parse(e.data);
    } catch {
      /* unrecognized — treat as a change ping */
    }
    app.rev++;
    void refreshVault();
  };
}

function scheduleReconnect(): void {
  clearTimeout(retryTimer);
  const wait = retryDelayMs(retryMs);
  retryMs = nextRetryMs(retryMs);
  retryTimer = setTimeout(reconnect, wait);
}

/** Refresh FIRST, then reopen. The refresh is what surfaces a dead session:
 * `EventSource` never exposes the status behind its error, so a 401 and a 502
 * are indistinguishable here — but a plain GET tells them apart and
 * surfaces the failure. Without this, an expired session would retry a
 * stream it can never open, quietly, forever. */
function reconnect(): void {
  void refreshVault().finally(connect);
}

/** A tab that comes back, or a network that does, should not sit out a
 * backoff that grew while it was away. */
function reconnectNow(): void {
  if (app.live) return;
  clearTimeout(retryTimer);
  retryMs = RETRY_MIN_MS;
  reconnect();
}

let initialized = false;
export function init(): void {
  initRouteHistory();
  applyHash();
  if (initialized) return;
  initialized = true;
  addEventListener("hashchange", () => applyHash());
  void refreshVault();
  // The server pings /api/events whenever the vault changes on disk.
  connect();
  addEventListener("online", reconnectNow);
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reconnectNow();
  });
}
