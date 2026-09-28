import { vaultFetch as fetch } from "./vaultScope";
/**
 * diagnostics.ts — the settings › diagnostics screen's half of the wire
 * (#710). The engine's lib/diagnostics.ts answers these under the desktop
 * app only; a headless host's viewer gets a 404, which reads as null here
 * and the screen says so.
 */

export interface LogTail {
  name: string;
  path: string;
  lines: string[];
  total: number | null;
  bytes: number;
  modified: string | null;
  missing: boolean;
}

export interface DiagnosticsFacts {
  connection?: { provider: string; connected: boolean };
  chatgpt?: { connected: boolean; runtime: boolean };
  at: string;
  engine: string;
  bundle: string | null;
  supervisor: number | null;
  supervisorAlive: boolean;
  vault: string;
  platform: string;
  bun: string;
  jobsPath: string;
  /** `account` and `auth` are absent from an engine older than 0.1.26. */
  claude: { path: string | null; loggedIn: boolean; account?: string | null };
  curationAgent?: "claude" | "codex" | "pi";
  codex?: { installed: string | false; account: string | null; supported?: boolean };
  auth?: { mode: "max" | "api" | null; keyPresent: boolean };
  /** The memory pass's standing (absent before 0.1.27): a failed run takes
   * the interval's slot silently, and this is where it shows. */
  memory?: {
    rebuildRecommended?: { current: number; target: number };
    lastRunAt: string | null;
    nextRunAt: string | null;
    failed: { run: string; at: string | null; error: string } | null;
  };
  nextFires: Record<string, number> | null;
  intake: { running: boolean; lockPid: number | null };
}

export interface DiagnosticsReport {
  facts: DiagnosticsFacts;
  logs: LogTail[];
}

/** lib/preflight.ts's Check, as the probe route returns it. */
export interface ProbeResult {
  name: string;
  ok: boolean;
  level: "fail" | "warn";
  detail: string;
  fix?: string;
}

/** The facts and the log tails — null when there is no desktop door here. */
export async function diagnosticsReport(): Promise<DiagnosticsReport | null> {
  const r = await fetch("/api/diagnostics", { headers: { Accept: "application/json" } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`diagnostics answered ${r.status}`);
  return (await r.json()) as DiagnosticsReport;
}

/** The same report as one block of text, for the clipboard. `app` is the
 * shell's version — the engine cannot know it, the shell can. */
export async function diagnosticsText(app: string | null): Promise<string> {
  const r = await fetch(`/api/diagnostics.txt${app ? `?app=${encodeURIComponent(app)}` : ""}`);
  if (!r.ok) throw new Error(`diagnostics answered ${r.status}`);
  return r.text();
}

/** `claude -p` under the jobs PATH, the scheduled tick's own call. Up to two
 * minutes: the button says so while it waits. */
export async function runProbe(): Promise<ProbeResult> {
  const r = await fetch("/api/diagnostics/probe", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error(`probe answered ${r.status}`);
  return (await r.json()) as ProbeResult;
}

/** Show the logs folder in the OS. `ok: false` when the engine could not —
 * the path comes back either way, to show. */
export async function revealLogs(): Promise<{ ok: boolean; path: string }> {
  const r = await fetch("/api/diagnostics/reveal", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error(`reveal answered ${r.status}`);
  return (await r.json()) as { ok: boolean; path: string };
}
