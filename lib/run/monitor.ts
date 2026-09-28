import { modelProvider } from "../modelResolution";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { writeAtomic } from "../fsx";
import type { ModelSession, ModelSessionSetup, ModelSessionTurn } from "./session";
import type { ModelObservation, RunPhase, RunRecord, UsageSample } from "./monitorTypes";

const context = new AsyncLocalStorage<string>();
export const providerId = modelProvider;
const count = (n: unknown): number | null => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
export function usageSample(id: string, model: string, value: Record<string, any> | undefined, _format: "pi" | "claude", scope: UsageSample["scope"] = "request"): UsageSample {
  value ??= {};
  const cached = count(value.cacheRead ?? value.cache_read_input_tokens);
  const input = count(value.input ?? value.input_tokens);
  return { kind: "usage", id, models: [model], scope,
    input: input,
    output: count(value.output ?? value.output_tokens), cacheRead: cached,
    cacheWrite: count(value.cacheWrite ?? value.cache_creation_input_tokens),
    estimatedCostUsd: count(value.cost?.total ?? value.total_cost_usd) };
}

/** Per-run durable checkpoints: no prompt, tool payload, account email or credentials.
 * Publication is atomic; a process crash leaves the last known phase, never success. */
export function monitoredSession<T extends ModelSession>(session: T, setup: ModelSessionSetup, role: string, validate?: (text: string | null) => void): T & ModelSession {
  let runId: string | undefined;
  return new Proxy(session, {
    get(target, key) {
      if (key === "runId") return runId;
      if (key !== "turn") {
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (args: ModelSessionTurn) => {
        const now = () => new Date().toISOString();
        const at = now();
        const record: RunRecord = { version: 1, id: crypto.randomUUID(), parentId: context.getStore(),
          role: role === "tend" ? "gardener" : role, provider: providerId(setup.config), adapter: setup.config.adapter,
          model: setup.config.model, accountId: session.accountId ?? null, sessionId: session.sessionId ?? null,
          transport: session.transport, startedAt: at, updatedAt: at, phase: "preparing",
          lifecycle: [{ phase: "preparing", at }], samples: [], quota: [] };
        const path = join(setup.root, "journal", "model-runs", at.slice(0, 7), `${record.id}.json`);
        runId = record.id;
        let warned = false;
        const save = () => {
          record.updatedAt = now(); record.sessionId = session.sessionId ?? record.sessionId;
          const observations = [...record.samples, ...record.quota];
          const identities = new Set(observations.map(s => s.accountId ?? null));
          record.accountId = observations.length ? identities.size === 1 ? observations[0]!.accountId ?? null : null : session.accountId ?? null;
          record.transport = session.transport;
          if (session.execution) { record.provider = session.execution.provider; record.adapter = session.execution.choice.adapter; record.model = session.execution.choice.model; }
          try { writeAtomic(path, JSON.stringify(record) + "\n", 0o600); }
          catch { if (!warned) { console.warn("[model-monitor] Could not persist run monitoring."); warned = true; } }
        };
        const phase = (next: RunPhase) => {
          if (record.finishedAt && ["running", "waiting_for_tools"].includes(next)) return;
          record.phase = next; record.lifecycle.push({ phase: next, at: now() }); save();
        };
        const observe = (value: ModelObservation) => {
          const sample = { ...value, at: value.at ?? now(), accountId: value.accountId === undefined ? session.accountId ?? null : value.accountId };
          if (sample.kind === "usage") {
            const i = record.samples.findIndex(s => s.id === sample.id);
            if (i < 0) record.samples.push(sample); else record.samples[i] = sample;
          } else if (Number.isFinite(sample.used) && sample.used >= 0 && sample.used <= 1 && Number.isFinite(Date.parse(sample.resetsAt))) {
            record.quota.push(sample);
          }
          save(); args.observe?.(sample);
        };
        save();
        return context.run(record.id, async () => {
          let tools = 0;
          try {
            const result = await session.turn({ ...args, observe,
              connected: () => { phase("running"); args.connected(); },
              tool: async (name, input) => {
                tools++; phase("waiting_for_tools");
                try { return await context.run(record.id, () => args.tool(name, input)); }
                finally { if (--tools === 0) phase("running"); }
              } });
            validate?.(result);
            record.finishedAt = now();
            phase(args.signal.aborted ? "cancelled" : result === null ? "failed" : "completed");
            return result;
          } catch (error) {
            record.finishedAt = now(); phase(args.signal.aborted ? "cancelled" : "failed"); throw error;
          }
        });
      };
    },
  });
}

export function readModelRuns(root: string, since: string): RunRecord[] {
  const dir = join(root, "journal", "model-runs");
  const runs: RunRecord[] = [];
  let months: string[];
  try { months = readdirSync(dir); } catch { return runs; }
  for (const month of months.filter(m => /^\d{4}-\d{2}$/.test(m) && m >= since.slice(0, 7))) {
    let files: string[];
    try { files = readdirSync(join(dir, month)); } catch { continue; }
    for (const file of files.filter(f => f.endsWith(".json"))) {
      try {
        const r = JSON.parse(readFileSync(join(dir, month, file), "utf8"));
        if (r.version === 1 && typeof r.id === "string" && typeof r.provider === "string" && typeof r.role === "string" &&
          typeof r.startedAt === "string" && Number.isFinite(Date.parse(r.startedAt)) && r.startedAt >= since &&
          typeof r.updatedAt === "string" && Number.isFinite(Date.parse(r.updatedAt)) &&
          (r.accountId === null || typeof r.accountId === "string") &&
          (r.finishedAt === undefined || typeof r.finishedAt === "string" && Number.isFinite(Date.parse(r.finishedAt))) &&
          Array.isArray(r.samples) && Array.isArray(r.quota)) runs.push(r);
      } catch { /* A damaged journal cannot take down settings. */ }
    }
  }
  return runs;
}
