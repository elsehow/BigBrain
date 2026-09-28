import { pilotScenarios, runPilotScenario } from "./applicationScenarios";
import { pilotChatDetail, pilotChatSummary } from "../../../../lib/pilotChatSummary";
/** Read-only fabricated HTTP boundary; the production shell and views still render. */
export function installApplicationScenario() {
  const params = new URLSearchParams(location.search), seed = Number(params.get("seed") ?? 41);
  if (!Number.isInteger(seed) || seed < 0 || seed > 10000) throw new Error("Use a scenario seed from 0 to 10000.");
  const trace = pilotScenarios(seed).find(s => s.id === params.get("scenario"));
  if (!trace) throw new Error("Unknown application scenario.");
  const result = runPilotScenario(trace);
  const step = Number(params.get("step") ?? result.frames.length - 1);
  const state = result.frames[step]?.state;
  if (!state) throw new Error("Unknown scenario step.");
  const original = window.fetch;
  window.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/pilot/chat") return json({ sessions: [pilotChatSummary(state)] });
    if (url.pathname === "/api/pilot/chat/session") return json(pilotChatDetail(state));
    if (url.pathname === "/api/pilot/chat/presence") return json({ ok: true });
    if (url.pathname === "/api/pilot/work") return json({ sessions: [] });
    if (url.pathname.startsWith("/api/pilot/chat/") && options?.method === "POST") return json({ error: "Scenario preview is read-only. Change the selected trace or step." }, 409);
    return original(input, options);
  }) as typeof fetch;
  location.hash = `#/session/${state.id}`;
  document.documentElement.dataset.applicationScenario = trace.id;
}
