import "../../design/tokens.css";
import "../../app.css";

// Install isolation BEFORE evaluating any app modules (including theme caches).
// This preview never reads the origin's real theme/skin/session preferences.
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(),
    getItem: key => values.get(key) ?? null, key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); }, setItem: (key, value) => { values.set(key, String(value)); } };
}
Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
Object.defineProperty(window, "sessionStorage", { value: memoryStorage(), configurable: true });
window.fetch = (async () => new Response('{"error":"Preview is initializing"}', { status: 503 })) as unknown as typeof window.fetch;
// No external links/popups escape the simulation, even from other settings tabs.
window.open = () => null;
window.addEventListener("click", event => {
  const link = (event.target as Element | null)?.closest?.("a[href]");
  if (link && !link.getAttribute("href")?.startsWith("#")) {
    event.preventDefault(); event.stopImmediatePropagation();
  }
}, true);

async function boot() {
  const { installFakeApi, setVaultState, SETTINGS } = await import("../fakeApi");
  installFakeApi();
  const fixture = structuredClone(SETTINGS.vault!);
  fixture.label = "Integration activation preview";
  fixture.recent = [];
  fixture.connections = [];
  fixture.graph = { ...fixture.graph, nodes: [], edges: [] };
  fixture.vault.view = { references: 0, entities: 0 };
  fixture.integrations = [];
  fixture.skins = undefined;
  fixture.setup!.vault = { path: "/demo/sample-vault", created: "2026-09-18T12:00:00Z" };
  fixture.setup!.identity = { name: "Sample", entity_id: "ent_demo" };
  setVaultState(fixture);

  const fakeFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return new Response("Preview only", { status: 403 });
    if (url.pathname === "/api/pilot/chat") return json({ sessions: [] });
    if (url.pathname === "/api/pilot/chat/github") return json({ connected: false, phase: "idle", repositories: [] });
    if (url.pathname === "/api/telemetry") return json({ enabled: false, decided: true, configured: true });
    return fakeFetch(input, options); // fakeApi returns 404 for unknown paths, never native fetch.
  }) as typeof window.fetch;
  const { THEMES, setChoice, watchSystemTheme } = await import("../../lib/theme");
  const theme = new URLSearchParams(location.search).get("theme");
  setChoice(THEMES.find(value => value === theme) ?? (theme === "dark" ? "dusk" : "default"));
  watchSystemTheme();
  // Base owns init(): the route must exist BEFORE mount, not in a parent onMount.
  history.replaceState(null, "", `${location.pathname}${location.search}#/integrations`);
  const [{ mount }, { default: Preview }] = await Promise.all([import("svelte"), import("./IntegrationPreview.svelte")]);
  mount(Preview, { target: document.getElementById("app")! });
}

void boot().catch(error => {
  document.getElementById("app")!.textContent = `Preview could not initialize: ${String(error)}`;
});
