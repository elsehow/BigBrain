// Dev/test only: the base with Field on top, over a fabricated vault (every
// name here is invented). The rest of the engine is fakeApi's, through the
// graph fixture; this answers what only Field asks: the entity graph, the
// record, the sorted feed and the coding desktops. `?empty` is a new vault;
// `?view=field` keeps the browser suite's `?view=classic` off it; `?update`
// shows the update banner, `?credits` a provider out of usage credits beside it,
// `?working` a Desktop at work (its cube turning).
import { mount } from "svelte";
import "../design/tokens.css";
import "../app.css";
import Base from "../components/Base.svelte";
import { installGraphFixture } from "./graphFixture";
import { watchSystemTheme } from "../lib/theme";
import { update } from "../lib/update.svelte";

const empty = new URLSearchParams(location.search).has("empty");
if (new URLSearchParams(location.search).has("update")) update.available = { version: "0.7.24", notes: "Preview update" };
await installGraphFixture();

const NAMES = ["Orrery repair", "Atlas survey", "Kit Brennan", "Briar Lowe", "Harbor lab", "Ridgeway trail", "Lantern grant", "Quill press", "Tidewater review", "Marlow studio"];
const entities = empty ? [] : NAMES.map((title, i) => ({ id: `ent_${i}`, title, group: "entity", entity: true as const, degree: 10 - i,
  path: `projection/entities/ent_${i}.md`, x: Math.cos(i * 0.9) * (80 + i * 18), y: Math.sin(i * 0.9) * (80 + i * 18) }));
const memory = empty ? [] : [{ id: "memory/atlas.md", title: "Atlas", group: "memory", degree: 3, path: "memory/atlas.md", x: 40, y: -30 }];
const graph = { hash: empty ? "empty" : "field", nodes: [...entities, ...memory],
  edges: empty ? [] : NAMES.slice(1).map((_, i) => ({ source: `ent_${i}`, target: `ent_${i + 1}`, weight: 2 })) };
const at = (min: number) => new Date(Date.UTC(2026, 9, 5, 9, min)).toISOString();
const feed = empty ? [] : NAMES.slice(0, 4).map((name, i) => ({ id: `ast_${i}`, at: at(i), author: null, by: "you", model: false, text: `${name} was noted.`, entities: [`ent_${i}`] }));
const sorted = empty ? [] : [
  { source: "ins_a", section: "needs-you", headline: "Kit asks for the orrery repair estimate by Friday.", due: null, added: at(30), entities: ["ent_0", "ent_2"],
    title: "Orrery estimate", path: "log/insertions/2026-10/ins_a.json", via: "email" },
  { source: "ins_b", section: "know", headline: "The Atlas survey's second leg is complete.", due: null, added: at(20), entities: ["ent_1"],
    title: "Atlas survey update", path: "log/insertions/2026-10/ins_b.json", via: "rss" },
  { source: "ins_c", section: "agent", headline: "Harbor lab sent the grant draft for review.", due: null, added: at(10), entities: ["ent_4", "ent_6"],
    title: "Lantern grant draft", path: "log/insertions/2026-10/ins_c.json", via: "email" },
];

let outOfCredits = new URLSearchParams(location.search).has("credits");
const fake = window.fetch;
(window as unknown as { fetch: typeof fake }).fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  if (url.pathname === "/api/graph") return json(graph);
  if (url.pathname === "/api/v2") return json({ authors: [], feed });
  if (url.pathname === "/api/v2/sorted") return json({ rows: sorted });
  if (url.pathname === "/api/v2/entity") return json({ rows: feed.filter((r) => r.entities.includes(url.searchParams.get("id") ?? "")) });
  if (url.pathname === "/api/desktops") return json({ desktops: [] });
  // a new desktop is counted (the browser suite reads it), not started
  if (url.pathname === "/api/desktops/create") {
    const w = window as unknown as { desktopsCreated?: number };
    w.desktopsCreated = (w.desktopsCreated ?? 0) + 1;
    return json({ error: "The workbench starts no desktops." }, 501);
  }
  // `?credits`: the gardener's provider is out of usage credits until Retry
  if (url.pathname === "/api/credits/retry") { outOfCredits = false; return json({ providers: {} }); }
  if (url.pathname === "/api/credits") return json({ providers: outOfCredits ? { anthropic: { since: at(0), at: at(5), roles: ["tend", "quick"], detail: "Your credit balance is too low." } } : {} });
  const note = url.pathname === "/api/note" ? sorted.find((r) => r.path === url.searchParams.get("path")) : undefined;
  if (note) return json({ path: note.path, kind: "markdown", content: `# ${note.title}\n\n${note.headline}`, origin: { kind: "url", url: `https://example.com/${note.source}` } });
  if (url.pathname === "/api/note/briefing") return json({ error: "no briefings here" }, 404);
  return fake(input, init);
}) as typeof fake;

watchSystemTheme();
// unpinned, as the app mounts it: Field unless the address says ?view=classic
mount(Base, { target: document.getElementById("app")! });
