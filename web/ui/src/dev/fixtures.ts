import { publicPilotFixture } from "./publicPilotFixture";
import { newPilotChatSession } from "../../../../lib/pilotChatTypes";
import { withPilotChats } from "../lib/pilotChatGraph";
// FIXTURES — the shared vocabulary for talking about queue states without a
// vault. Two consumers, deliberately:
//
//   test/queueView.test.ts   asserts against them (bun test)
//   src/dev/Workbench.svelte renders them (bun run web:dev → /dev.html)
//
// One definition, so a scene you can SEE is the same scene the tests
// assert on, and a state that turns out to matter gets captured once. The
// scenes below skew hard toward what a live vault will not politely
// produce on demand: three fates of a directive at once, a note typed
// beside a capture, guidance long enough to bury its note.
//
// They were QueueTable's scenes until 2026-08-28, when the work-queue
// screen was deleted; what a queue message still RENDERS anywhere is its
// directives, on a note, so a scene is now a set of messages and nothing
// else. The run/observation/memory halves went with the table.
//
// This module is dev/test-only. Nothing under src/dev/ is reachable from
// index.html, so it never enters the app bundle.

import type { GraphData, GraphEdge, GraphNode, QueueMessageRow } from "../lib/types";

// ── factories ───────────────────────────────────────────────────────────────

export const msg = (over: Partial<QueueMessageRow> = {}): QueueMessageRow => ({
  state: "done",
  path: `queue/done/${over.id ?? "m1"}.yaml`,
  id: "m1",
  refs: ["granola-a"],
  from: "granola",
  via: "poll",
  enqueued: "2026-08-05T10:00:00Z",
  ...over,
});

// ── scenes ──────────────────────────────────────────────────────────────────

/** A set of queue messages, plus what the picker needs to label it. */
export interface QueueScene {
  label: string;
  /** what this scene is FOR — shown in the workbench, so a scene can't
   * quietly become decoration nobody remembers the point of */
  note: string;
  messages: QueueMessageRow[];
}

// ── keeping the clock alive ─────────────────────────────────────────────────
// The scenes carry FIXED timestamps, because tests must be deterministic.
// But gmailTs renders same-day stamps as "2:41 PM" and older ones as
// "Aug 6" — so a workbench full of frozen dates would exercise only the
// stale branch, forever, and the format the app actually shows most of the
// time would go unlooked-at. freshen() slides a whole scene forward by the
// gap between BASE and now, preserving every interval exactly. Tests use
// the raw scenes; only the workbench freshens.

const BASE = "2026-08-06T22:00:00Z";

const slide = (iso: string, deltaMs: number): string =>
  new Date(Date.parse(iso) + deltaMs).toISOString();

export function freshen(scene: QueueScene, now: Date = new Date()): QueueScene {
  const d = now.getTime() - Date.parse(BASE);
  return {
    ...scene,
    messages: scene.messages.map((x) => ({
      ...x,
      enqueued: slide(x.enqueued, d),
      ...(x.finished ? { finished: slide(x.finished, d) } : {}),
    })),
  };
}

export const QUEUE_SCENES: Record<string, QueueScene> = {

  noteBesideACapture: {
    label: "a note beside a capture",
    note: "Saving a page and typing a note enqueues TWO messages against the same reference id. Correct — but the rows must not read as a double-add. The directive shows its guidance; only the arrival shows the title.",
    messages: [
      msg({
        id: "a1",
        state: "pending",
        refs: ["url-8f42"],
        via: "extension",
        from: "send-to-bigbrain",
        enqueued: "2026-08-06T21:50:00Z",
      }),
      msg({
        id: "g1",
        state: "pending",
        refs: ["url-8f42"],
        via: "extension",
        from: "alex@example.com",
        from_kind: "person",
        guidance: "compare spring and autumn",
        enqueued: "2026-08-06T21:51:00Z",
      }),
    ],
  },

  longLabels: {
    label: "labels that fight the grid",
    note: "Guidance long enough to bury the note it sits under — the clamp (220 chars or 4 lines, lib/queueView.ts) is what keeps a considered request from becoming a wall of text under a two-line note.",
    messages: [
      msg({
        id: "L1",
        state: "pending",
        refs: ["granola-a-meeting-id-nobody-has-seen-before-and-it-is-long-2026"],
        enqueued: "2026-08-06T21:50:00Z",
      }),
      msg({
        id: "L2",
        state: "pending",
        refs: [],
        guidance:
          "merge the two weather notebooks and reconcile the calibration dates against the sensor log, then tell me what changed",
        enqueued: "2026-08-06T21:51:00Z",
      }),
    ],
  },

  askedAboutThis: {
    label: "asked about this (note side)",
    note: "#50's note-side view. The user's words are their voice; the agent's are marked as data. The three fates a directive can wear — waiting, absorbed, failed — appear together, which no single moment in a live vault would show.",
    messages: [
      msg({
        id: "n1",
        state: "pending",
        refs: ["url-8f42"],
        from: "alex@example.com",
        via: "extension",
        from_kind: "person",
        guidance: "compare spring and autumn",
        enqueued: "2026-08-06T21:51:00Z",
      }),
      msg({
        id: "n2",
        state: "done",
        refs: ["url-8f42"],
        from: "claude-code",
        via: "session",
        from_kind: "agent",
        guidance:
          "The demo sensor-calibration guide is already in the notebook; link the two examples.",
        enqueued: "2026-08-06T20:00:00Z",
        finished: "2026-08-06T20:05:00Z",
        outcome: "url-8f42 absorbed → entities/demo-guide.md",
      }),
      msg({
        id: "n3",
        state: "failed",
        refs: ["url-8f42"],
        from: "alex@example.com",
        via: "web",
        from_kind: "person",
        guidance: "file this under the sensor-calibration thread",
        enqueued: "2026-08-06T18:00:00Z",
        finished: "2026-08-06T18:02:00Z",
        error: "claude -p failed (1): 429 rate_limit",
        attempts: 3,
      }),
      // Invented long migration note to exercise the multiline clamp.
      msg({
        id: "n5",
        state: "done",
        refs: ["url-8f42"],
        from: "alex@example.com",
        via: "zen browser",
        from_kind: "person",
        enqueued: "2026-08-06T16:00:00Z",
        finished: "2026-08-06T16:04:00Z",
        outcome: "url-8f42 absorbed → entities/demo-sensors.md",
        guidance:
          "compare spring and autumn\n\n(Demo migration annotation: this invented note\n" +
          "was previously represented as a separate reference. It now appears as a\n" +
          "directive beside the related sample capture. The extra lines exercise\n" +
          "the expanded and collapsed display states without copying any real\n" +
          "person's annotation or source material. Keeping the original instruction\n" +
          "separate from this annotation makes the author boundary visible.)",
      }),
      // must NOT render: an arrival is not something anyone said
      msg({
        id: "n4",
        state: "done",
        refs: ["url-8f42"],
        from: "send-to-bigbrain",
        via: "extension",
        from_kind: "agent",
        enqueued: "2026-08-06T17:00:00Z",
        finished: "2026-08-06T17:01:00Z",
        outcome: "absorbed",
      }),
    ],
  },

};

// ── graph scenes ────────────────────────────────────────────────────────────
// The link graph's states — the surface whose only honest test is the eye:
// hover weight, label crowding, how much of the map survives a dim. You
// cannot get these from a live vault on demand (you get whatever shape your
// notes happen to have), which is exactly why they are fabricated here.
//
// Positions are BAKED, so a scene is the same picture every time — a
// storyboard, not a simulation. That is now also how the real thing works:
// the server ships settled positions (lib/graphLayout.ts) and the component
// only draws, so a scene exercises the same path production does.

export interface GraphScene {
  label: string;
  note: string;
  data: GraphData;
}

/** A hub-and-fan graph: `hubs` dossiers, each fanning `fan` items, laid out
 * radially so the picture is deterministic (no RNG — a storyboard that
 * reshuffles is a storyboard you cannot compare against yesterday). The hubs
 * are also chained to each other, so hub hover has both kinds of neighbour. */
function constellation(hubs: number, fan: number): GraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const names = [
    "Ada Lovelace",
    "Grace Hopper",
    "Alan Turing",
    "Katherine Johnson",
    "Claude Shannon",
    "Barbara Liskov",
  ];
  const hubId = (h: number) => `entities/hub-${h}.md`;
  for (let h = 0; h < hubs; h++) {
    const a = (h / hubs) * Math.PI * 2;
    const hx = Math.cos(a) * 220,
      hy = Math.sin(a) * 220;
    nodes.push({
      id: hubId(h),
      title: names[h % names.length]!,
      group: "entity",
      degree: fan + 2,
      x: hx,
      y: hy,
      entity: true,
    });
    for (let k = 0; k < fan; k++) {
      const t = a + (k - (fan - 1) / 2) * 0.16;
      const id = `references/2026-08-11-item-${h}-${k}.md`;
      nodes.push({
        id,
        title: `A rather long landed item title ${h}-${k}`,
        group: "reference",
        degree: 1,
        x: hx + Math.cos(t) * 150,
        y: hy + Math.sin(t) * 150,
      });
      edges.push({ source: id, target: hubId(h) });
    }
    edges.push({ source: hubId(h), target: hubId((h + 1) % hubs) });
  }
  return { nodes, edges, hash: `wb-${hubs}-${fan}` };
}

/** Strip the baked positions — what the client gets when the server had no
 * layout to send. */
function unpositioned(g: GraphData): GraphData {
  return { ...g, hash: `${g.hash}-unpositioned`, nodes: g.nodes.map(({ x: _x, y: _y, ...n }) => n) };
}

/** The same constellation with citation WEIGHTS on its edges: the hub chain
 * cited over and over, most fan items once, every fourth twice and every
 * eighth four times — the spread a vault has, where most pairs are cited
 * once and the heaviest are dozens deep. Deterministic, like the rest. */
function weighted(g: GraphData): GraphData {
  let k = 0;
  return {
    ...g,
    hash: `${g.hash}-weighted`,
    edges: g.edges.map((e) => {
      const hubHub = e.source.startsWith("entities/") && e.target.startsWith("entities/");
      const w = hubHub ? 9 : k++ % 8 === 7 ? 4 : k % 4 === 0 ? 2 : 1;
      return w > 1 ? { ...e, weight: w } : e;
    }),
  };
}

/** A small component outside the initial overview, with siblings that
 * collapse onto the same tether before background collision spacing. */
function hiddenCluster(): GraphData {
  const overview = Array.from({ length: 40 }, (_, i) => ({
    id: `overview-${i}`, title: `Overview ${i}`, group: "entities", degree: 2,
    x: -600 + (i % 8) * 60, y: Math.floor(i / 8) * 60,
  }));
  const hub = { id: "hidden-hub", title: "Hidden cluster", group: "entities", degree: 24, x: 1200, y: 0 };
  const leaves = Array.from({ length: 24 }, (_, i) => ({
    id: `hidden-${i}`, title: `Source ${i}`, group: "references", degree: 1, x: 2200 + i, y: 0,
  }));
  return {
    hash: "wb-hidden-cluster", nodes: [...overview, hub, ...leaves],
    edges: [
      ...overview.slice(1).map((n, i) => ({ source: overview[i]!.id, target: n.id })),
      ...leaves.map(n => ({ source: hub.id, target: n.id })),
    ],
  };
}

function pilotContextSample(): GraphData {
  const data = constellation(6, 22);
  // Cross-links give the background ordinary connected notes as well as hubs.
  const ordinary = data.nodes.filter(n => !n.entity);
  ordinary.forEach((node, i) => {
    for (const offset of [1, 7]) {
      const other = ordinary[(i + offset) % ordinary.length]!;
      data.edges.push({ source: node.id, target: other.id });
      node.degree++; other.degree++;
    }
  });
  const targets = [data.nodes[2]!, data.nodes[30]!, data.nodes[65]!];
  const sessions = targets.map((target, i) => {
    const context = [target.id, ...data.nodes.slice(i * 23 + 4, i * 23 + 7).map(n => n.id)];
    const session = newPilotChatSession(context, `pilot-${String(i).padStart(32, "0")}`);
    session.title = ["Reviewing sources", "Ready to continue", "Needs your answer"][i]!;
    session.phase = i === 0 ? "working" : "answered";
    if (i === 2) session.notifications = [{ id: "question", key: "question", pilotId: session.id,
      pilotTitle: session.title, messageId: "m", kind: "question", text: "Which source?", at: session.created, seen: false }];
    return session;
  });
  return withPilotChats({ ...data, hash: "wb-pilot-context" }, sessions.map(publicPilotFixture), null)!;
}

export const GRAPH_SAMPLES: Record<string, GraphScene> = {
  pilots: {
    label: "Active Pilots · direct context",
    note: "Running, waiting, and between-turn Pilots in a crowded graph. Compare prioritizing their direct context with the ordinary overview.",
    data: pilotContextSample(),
  },
  selection: {
    label: "Compose a selection",
    note: "Click Alpha, Shift-click Beta, then Ctrl-click Shared. Both neighborhoods stay selected while Shared disappears. Undo and Restore bring it back; hovering never expands the graph.",
    data: {
      hash: "wb-graph-selection",
      nodes: [
        { id: "alpha", title: "Alpha", group: "entities", degree: 3, x: -110, y: 0 },
        { id: "beta", title: "Beta", group: "entities", degree: 3, x: 110, y: 0 },
        { id: "shared", title: "Shared", group: "references", degree: 2, x: 0, y: -100 },
        { id: "alpha-only", title: "Alpha only", group: "references", degree: 1, x: -200, y: 90 },
        { id: "beta-only", title: "Beta only", group: "references", degree: 1, x: 200, y: 90 },
      ],
      edges: [
        { source: "alpha", target: "beta" },
        { source: "alpha", target: "shared" },
        { source: "beta", target: "shared" },
        { source: "alpha", target: "alpha-only" },
        { source: "beta", target: "beta-only" },
      ],
    },
  },
  hiddenCluster: {
    label: "Hidden cluster",
    note: "Select Hidden cluster to reveal a component outside the overview. Its 24 nearly coincident sources should have space without moving the overview.",
    data: hiddenCluster(),
  },
  small: {
    label: "Small constellation",
    note: "",
    data: weighted(constellation(6, 9)),
  },
  sparse: {
    label: "sparse — few links",
    note: "Three small clusters. Unhovered, the full-page rule only names hubs once you are zoomed in enough to hold text — so this scene reads bare until you zoom, which is the intent, not a bug.",
    data: constellation(3, 3),
  },
  crowded: {
    label: "crowded — dense fan",
    note: "More than the layout can space out: nodes overlap and labels collide. A hover treatment that survives here survives a real vault.",
    data: constellation(6, 22),
  },
  weighted: {
    label: "weighted — cited pairs brighter",
    note: "Edges carry citation weights (2026-09-05): the hub chain is nine assertions deep and draws at full strength, most fan threads were cited once and sit at the faint band, a few twice or four times between. The rim should read as a haze the core stands out of — the still life's constellation — without the single threads vanishing.",
    data: weighted(constellation(6, 12)),
  },
  unpositioned: {
    label: "no positions from the server",
    note: "Nodes arrive with no x/y — a vault whose .state could not be written, so the server had nothing settled to send. The component falls back to the phyllotaxis seed and draws SOMETHING legible rather than piling every node on the origin. Never seen in a healthy vault; it is the failure this fallback exists for.",
    data: unpositioned(constellation(5, 7)),
  },
  empty: {
    label: "empty vault",
    note: "No nodes at all: the canvas must not throw and fit() must not divide by an empty bounding box. What a brand-new vault shows before anything has landed.",
    data: { nodes: [], edges: [], hash: "wb-empty" },
  },
};

export const GRAPH_SCENES: Record<string, GraphScene> = {
  graph: {
    label: "Graph",
    note: "Select a neighborhood to bring its direct connections to the surface. Tune depth, visibility, spacing and color trails in one view, using your graph or a sample.",
    data: GRAPH_SAMPLES.small!.data,
  },
};

// ---------------------------------------------------------------------------
// UpdateNudge — the "a newer BigBrain exists" strip (lib/update.svelte.ts).
// A scene here is the store's state written by hand: the workbench has no
// shell, so nothing else can ever raise the banner.

export interface UpdateScene {
  label: string;
  note: string;
  available: { version: string; notes: string | null } | null;
  phase: "idle" | "installing" | "failed";
  error: string | null;
}

export const UPDATE_SCENES: Record<string, UpdateScene> = {
  ready: {
    label: "1 · a version is waiting",
    note: "The shell found a newer build on the site. One strip above the top bar: the version, UPDATE & RELAUNCH, and × — which keeps THIS version quiet for good (bb-update-skip) while the next one speaks again. Nothing downloads until the button is pressed.",
    available: { version: "0.2.0", notes: null },
    phase: "idle",
    error: null,
  },
  installing: {
    label: "2 · installing",
    note: "The button was pressed: the strip says what is happening and that the app will relaunch itself — both buttons gone, because there is nothing left to decide and ×-ing a half-installed update would be a lie. In the app this state ends with the window going away.",
    available: { version: "0.2.0", notes: null },
    phase: "installing",
    error: null,
  },
  failed: {
    label: "3 · the install failed",
    note: "The download or the signature check went wrong (offline mid-download, a truncated file). The shell's words land in the strip, the button says TRY AGAIN, and × still works — a failed update must never wedge the banner open. A long error must ellipsize, not push the buttons off the strip.",
    available: { version: "0.2.0", notes: null },
    phase: "failed",
    error: "the request timed out after 30s: download from https://bigbrain.exe.xyz/download/BigBrain_0.2.0_aarch64.app.tar.gz was interrupted",
  },
};
