import { vaultFetch as fetch } from "./vaultScope";
import type { TelemetrySnapshot } from "../../../../lib/telemetry";
export type { TelemetrySnapshot };
export async function telemetryState(update?: { enabled: boolean }): Promise<TelemetrySnapshot | null> {
  const r = await fetch("/api/telemetry", update ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(update) } : undefined);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Performance diagnostics unavailable");
  return r.json();
}
export function startTelemetryPresence(): () => void {
  const client = crypto.randomUUID();
  let pending = false, active = true;
  const send = async (): Promise<void> => {
    if (pending || !active) return;
    pending = true;
    try { await post({ client, foreground: document.visibilityState === "visible" && document.hasFocus() }); }
    catch { /* best effort, including older engines */ }
    finally { pending = false; }
  };
  // Page teardown must not start a presence fetch; resume after bfcache restores.
  const hide = () => { active = false; };
  const show = () => { active = true; void send(); };
  window.addEventListener("pagehide", hide); window.addEventListener("pageshow", show);
  void send();
  const timer = setInterval(() => { if (document.visibilityState === "visible") void send(); }, 30_000);
  document.addEventListener("visibilitychange", send); window.addEventListener("focus", send); window.addEventListener("blur", send);
  return () => { active = false; window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", show); clearInterval(timer); document.removeEventListener("visibilitychange", send); window.removeEventListener("focus", send); window.removeEventListener("blur", send); };
}

async function post(value: Record<string, string | boolean>): Promise<void> {
  await fetch("/api/telemetry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
}
/** Explicit actions only; never include the note path or Pilot input itself. */
export function usageAction(action: "note_opened" | "pilot_input_accepted", id: string = crypto.randomUUID()): void {
  void post({ action, id }).catch(() => {});
}
