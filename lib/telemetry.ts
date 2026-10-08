/** Explicit, content-free desktop telemetry. Local history is bounded and volatile;
 * consent is installation-local, never part of a synced vault. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { posthogToken, posthogRegion } from "./env";
import { writeAtomic } from "./fsx";
import { telemetryConfig } from "./telemetryConfig";
import { configDir, engineIdentity } from "./engine";
import { intakeRunning } from "./assertionAgent";
import { json, readBody, type Route } from "./httpx";

export type Operation = "search" | "graph" | "note" | "pilot_submit";
export interface ResourceSample {
  at: number; ageMinutes: number; cpuPercent: number; rssMB: number; timerDelayMs: number;
  foreground: boolean; gardening: boolean;
}
interface Aggregate { count: number; totalMs: number; maxMs: number; failures: number }
export interface TelemetrySnapshot {
  enabled: boolean; decided: boolean; configured: boolean; samples: ResourceSample[];
  operations: Record<string, Aggregate>; actions: Record<string, number>; queued: number; delivery: "idle" | "sent" | "retrying";
}
interface Event { uuid: string; event: string; timestamp: string; properties: Record<string, string | number | boolean> }
const targets = { us: "https://us.i.posthog.com/batch/", eu: "https://eu.i.posthog.com/batch/" };
export class Telemetry {
  private consent: { enabled: boolean; id?: string } = { enabled: false };
  private decided = false;
  private samples: ResourceSample[] = [];
  private operations: Record<string, Aggregate> = {};
  private pending: Event[] = [];
  private delivery: TelemetrySnapshot["delivery"] = "idle";
  private controller?: AbortController;
  private busy = false;
  private foregroundClients = new Map<string, number>();
  private startAt: number;
  private lastAt: number;
  private cpu: NodeJS.CpuUsage;
  private timer?: ReturnType<typeof setInterval>;
  private lastFlush: number;
  private sampleWindow: ResourceSample[] = [];
  private generation = 0;
  private actions: Record<string, number> = {};
  private seenActions = new Set<string>();
  constructor(private options: { file: string; root: string; token?: string; region?: string; fetch?: typeof fetch; release?: string; now?: () => number; cpu?: () => NodeJS.CpuUsage; rss?: () => number }) {
    this.startAt = this.lastAt = this.lastFlush = this.now();
    this.cpu = (options.cpu ?? process.cpuUsage)();
    try {
      const value = JSON.parse(readFileSync(options.file, "utf8"));
      if (value?.enabled === false) this.decided = true;
      else if (value?.enabled === true && typeof value.id === "string" && /^[0-9a-f-]{36}$/.test(value.id)) {
        this.consent = { enabled: true, id: value.id };
        this.decided = true;
      }
    } catch { /* absent/corrupt consent always means off */ }
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  get configured(): boolean { return !!this.options.token && (this.options.region === "us" || this.options.region === "eu"); }
  setConsent(enabled: boolean): void {
    const next = enabled ? { enabled, id: this.consent.id ?? crypto.randomUUID() } : { enabled: false };
    writeAtomic(this.options.file, JSON.stringify(next), 0o600);
    this.consent = next;
    this.decided = true;
    this.generation++;
    this.controller?.abort();
    this.pending = [];
    this.sampleWindow = [];
    this.operations = {};
    this.actions = {};
    this.seenActions.clear();
    this.delivery = "idle";
    // Start the resource measurement window at the consent boundary.
    this.lastAt = this.lastFlush = this.now();
    this.cpu = (this.options.cpu ?? process.cpuUsage)();
  }
  action(name: string, id: string): void {
    if (!["note_opened", "pilot_input_accepted"].includes(name) || !/^[0-9a-f-]{36}$/.test(id) || this.seenActions.has(id)) return;
    this.seenActions.add(id);
    if (this.seenActions.size > 1000) this.seenActions.delete(this.seenActions.values().next().value!);
    this.actions[name] = (this.actions[name] ?? 0) + 1;
  }
  presence(foreground: boolean, client = "default"): void {
    if (client.length > 64) return;
    if (foreground) this.foregroundClients.set(client, this.now() + 75_000);
    else this.foregroundClients.delete(client);
    if (this.foregroundClients.size > 8) this.foregroundClients.delete(this.foregroundClients.keys().next().value!);
  }
  private gardening(): boolean {
    return intakeRunning(this.options.root);
  }
  record(operation: Operation, ms: number, success: boolean, gardening = this.gardening()): void {
    if (!["search", "graph", "note", "pilot_submit"].includes(operation) || !Number.isFinite(ms) || ms < 0) return;
    const key = `${operation}_${gardening ? "gardening" : "idle"}`;
    const a = this.operations[key] ??= { count: 0, totalMs: 0, maxMs: 0, failures: 0 };
    a.count++; a.totalMs += Math.min(ms, 3_600_000); a.maxMs = Math.max(a.maxMs, Math.min(ms, 3_600_000)); a.failures += success ? 0 : 1;
  }
  begin(operation: Operation): (success: boolean) => void {
    const at = performance.now(), gardening = this.gardening(), generation = this.generation;
    return success => {
      // A request started before a consent change belongs to the old window.
      if (generation === this.generation) this.record(operation, performance.now() - at, success, gardening);
    };
  }
  sample(): void {
    const now = this.now(), elapsed = now - this.lastAt, cpu = (this.options.cpu ?? process.cpuUsage)();
    // Omit long gaps (sleep or long stalls); this is a coarse timer-delay measure.
    if (elapsed > 0 && elapsed < 30_000) {
      const sample: ResourceSample = { at: now, ageMinutes: Math.floor((now - this.startAt) / 60_000),
        cpuPercent: Math.round(((cpu.user - this.cpu.user + cpu.system - this.cpu.system) / (elapsed * 1000)) * 1000) / 10,
        rssMB: Math.round((this.options.rss?.() ?? process.memoryUsage().rss) / 1048576), timerDelayMs: Math.max(0, elapsed - 10_000),
        foreground: [...this.foregroundClients.values()].some(until => now < until), gardening: this.gardening() };
      this.samples.push(sample); if (this.samples.length > 360) this.samples.shift();
      if (this.consent.enabled) { this.sampleWindow.push(sample); if (this.sampleWindow.length > 30) this.sampleWindow.shift(); }
    }
    this.cpu = cpu; this.lastAt = now;
    if (now - this.lastFlush >= 300_000) { this.lastFlush = now; this.summarize(); void this.flush(); }
  }
  start(): void { if (!this.timer) { this.timer = setInterval(() => this.sample(), 10_000); this.timer.unref(); } }
  close(): void { clearInterval(this.timer); this.timer = undefined; this.controller?.abort(); }
  private enqueue(event: string, properties: Event["properties"]): void {
    if (!this.consent.enabled || !this.configured) return;
    this.pending.push({ uuid: crypto.randomUUID(), event, timestamp: new Date().toISOString(), properties: {
      ...properties, schema: 1, platform: process.platform, arch: process.arch,
      release: this.options.release ?? "development", $process_person_profile: false, $geoip_disable: true,
    } });
    if (this.pending.length > 100) this.pending.shift();
  }
  summarize(): void {
    for (const foreground of [true, false]) for (const gardening of [true, false]) {
      const rows = this.sampleWindow.filter(s => s.foreground === foreground && s.gardening === gardening);
      if (!rows.length) continue;
      this.enqueue("desktop_resources", { foreground, gardening, samples: rows.length,
        cpu_mean: rows.reduce((n, s) => n + s.cpuPercent, 0) / rows.length,
        rss_mean_mb: rows.reduce((n, s) => n + s.rssMB, 0) / rows.length,
        rss_max_mb: Math.max(...rows.map(s => s.rssMB)), timer_delay_max_ms: Math.max(...rows.map(s => s.timerDelayMs)),
        age_minutes: rows.at(-1)!.ageMinutes, scope: "viewer_engine" });
    }
    for (const [operation, a] of Object.entries(this.operations)) this.enqueue("desktop_operation", {
      operation, count: a.count, mean_ms: a.totalMs / a.count, max_ms: a.maxMs, failures: a.failures,
    });
    for (const [action, count] of Object.entries(this.actions)) this.enqueue("desktop_usage", { action, count });
    this.sampleWindow = []; this.operations = {}; this.actions = {};
  }
  async flush(): Promise<void> {
    if (this.busy || !this.consent.enabled || !this.configured || !this.pending.length) return;
    this.pending = this.pending.filter(e => Date.now() - Date.parse(e.timestamp) < 86_400_000);
    if (!this.pending.length) return;
    this.busy = true;
    const generation = this.generation, batch = this.pending.slice(), controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000); timeout.unref();
    try {
      const response = await (this.options.fetch ?? fetch)(targets[this.options.region as keyof typeof targets], {
        method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: this.options.token, batch: batch.map(e => ({ ...e, distinct_id: this.consent.id })) }),
      });
      if (!response.ok) throw new Error("delivery failed");
      if (generation === this.generation) { const ids = new Set(batch.map(e => e.uuid)); this.pending = this.pending.filter(e => !ids.has(e.uuid)); this.delivery = "sent"; }
    } catch { if (generation === this.generation) this.delivery = "retrying"; }
    finally { clearTimeout(timeout); this.busy = false; this.controller = undefined; }
  }
  snapshot(): TelemetrySnapshot { return { enabled: this.consent.enabled, decided: this.decided, configured: this.configured,
    samples: [...this.samples], operations: structuredClone(this.operations), actions: { ...this.actions }, queued: this.pending.length, delivery: this.delivery }; }
}
let current: Telemetry | undefined;
export function telemetry(root: string): Telemetry {
  if (!current) {
    const bundle = engineIdentity().bundle;
    current = new Telemetry({ root, file: join(configDir(), "telemetry.json"),
      token: posthogToken() ?? telemetryConfig.token, region: posthogRegion() ?? telemetryConfig.region,
      release: bundle?.match(/^engine ([a-f0-9]+)/m)?.[1] ?? "development" });
  }
  return current;
}
export function telemetryRoutes(collector: Telemetry): Route[] {
  return [
    { method: "GET", path: "/api/telemetry", handler: ({ res }) => json(res, 200, collector.snapshot()) },
    { method: "POST", path: "/api/telemetry", handler: ({ req, res }) => {
      if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") return json(res, 415, { error: "JSON required" });
      if (req.headers.origin) {
        try { const origin = new URL(req.headers.origin); if (origin.protocol !== "http:" || origin.host !== req.headers.host) throw new Error(); }
        catch { return json(res, 403, { error: "Same origin required" }); }
      }
      void readBody(req, 512).then(raw => {
        const value = JSON.parse(raw);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        if (typeof value.enabled === "boolean") collector.setConsent(value.enabled);
        else if (typeof value.foreground === "boolean") { collector.presence(value.foreground, typeof value.client === "string" ? value.client : "default"); return json(res, 200, { ok: true }); }
        else if (typeof value.action === "string" && typeof value.id === "string") { collector.action(value.action, value.id); return json(res, 200, { ok: true }); }
        else throw new Error();
        json(res, 200, collector.snapshot());
      }).catch(() => json(res, 400, { error: "Could not update telemetry settings" }));
    } },
  ];
}
