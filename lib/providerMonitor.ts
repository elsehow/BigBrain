import { readModelRuns } from "./run/monitor";
import type { ProviderMonitor, RunRecord, UsageSample } from "./run/monitorTypes";

/** Each provider declares its observation capabilities. Quota sources live in
 * its authenticated adapter; settings never starts a CLI or borrows credentials. */
export interface ProviderMonitoringAdapter {
  tokens: boolean;
  quota: boolean;
}
export const PROVIDER_MONITORS: Record<string, ProviderMonitoringAdapter> = {
  anthropic: { tokens: true, quota: true },
  "openai-codex": { tokens: true, quota: true },
  openai: { tokens: true, quota: false },
};
const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
const validCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export const sampleTokens = (s: UsageSample): number => fields.reduce((n, field) => n + (validCount(s[field]) ? s[field] : 0), 0);

export function summarizeProvider(provider: string, records: RunRecord[], now = new Date(), adapter = PROVIDER_MONITORS[provider] ?? { tokens: true, quota: false }): ProviderMonitor {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const runs = records.filter(r => r.provider === provider && r.startedAt >= since && r.startedAt <= now.toISOString());
  const roles = new Map<string, ProviderMonitor["roles"][number]>();
  for (const run of runs) {
    const role = roles.get(run.role) ?? { role: run.role, runs: 0, measuredRuns: 0, tokens: 0, partial: false };
    role.runs++;
    const samples = run.samples.filter(s => s && s.kind === "usage");
    if (samples.some(s => fields.some(f => validCount(s[f])))) role.measuredRuns++;
    role.tokens += samples.reduce((n, sample) => n + sampleTokens(sample), 0);
    role.partial ||= !samples.length || samples.some(s => s.partial || fields.some(f => !validCount(s[f]))) || run.phase !== "completed";
    roles.set(run.role, role);
  }
  const accounts = runs.flatMap(run => {
    const observations = [...run.samples, ...run.quota].filter(Boolean);
    return observations.length ? observations.map(s => s.accountId === undefined ? run.accountId : s.accountId) : [run.accountId];
  });
  const identities = new Set(accounts.filter(Boolean));
  const identity = identities.size > 1 ? "multiple" : accounts.some(id => !id) || !accounts.length ? "unknown" : "known";
  const readings = runs.flatMap(run => run.quota.filter(q => q && typeof q.window === "string" && typeof q.at === "string" && typeof q.resetsAt === "string" && validCount(q.used) && q.used <= 1 &&
    Number.isFinite(Date.parse(q.resetsAt)) && Number.isFinite(Date.parse(q.at)) && Date.parse(q.at) <= now.getTime()))
    .sort((a, b) => a.at.localeCompare(b.at));
  const windows: ProviderMonitor["quota"]["windows"] = [];
  // Never merge quota from different or unidentified accounts.
  if (identity === "known") for (const window of new Set(readings.map(q => q.window))) {
    const latest = readings.filter(q => q.window === window).at(-1)!;
    windows.push({ window, used: latest.used, resetsAt: latest.resetsAt, asOf: latest.at,
      stale: Date.parse(latest.resetsAt) <= now.getTime() || now.getTime() - Date.parse(latest.at) > 15 * 60_000 });
  }
  const stale = windows.some(w => w.stale);
  return { provider, since, asOf: runs.map(r => r.updatedAt).sort().at(-1) ?? null, capabilities: adapter,
    roles: [...roles.values()].sort((a, b) => a.role.localeCompare(b.role)), accountIdentity: identity,
    quota: { state: !adapter.quota ? "unsupported" : !windows.length ? "unavailable" : stale ? "stale" : "current", windows } };
}
export function providerMonitoring(root: string, now = new Date()): Record<string, ProviderMonitor> {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const runs = readModelRuns(root, since);
  return Object.fromEntries([...new Set([...Object.keys(PROVIDER_MONITORS), ...runs.map(r => r.provider)])]
    .map(provider => [provider, summarizeProvider(provider, runs, now)]));
}
