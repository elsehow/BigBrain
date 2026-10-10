import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrationHealth, Telemetry, telemetryRoutes, type IntegrationHealth } from "../lib/telemetry";
import { PollError, withPollStatus } from "../lib/integrationStatus";
import { nativeVault } from "./support/vault";
import { fakeIntegrationActivation } from "./support/integrationActivation";
import { createServer } from "node:http";
import { dispatch } from "../lib/httpx";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function make(send: typeof fetch = fetch, configured = true) {
  const root = mkdtempSync(join(tmpdir(), "bb-telemetry-")); dirs.push(root);
  const options = { root, file: join(root, "consent.json"), token: configured ? "public-test-token" : "", region: "eu", fetch: send };
  return { collector: new Telemetry(options), options };
}
function capture() {
  const bodies: any[] = [];
  const send = (async (url: string, init: RequestInit) => { expect(url).toBe("https://eu.i.posthog.com/batch/"); bodies.push(JSON.parse(init.body as string)); return new Response("{}", { status: 200 }); }) as typeof fetch;
  return { bodies, send };
}
describe("opt-in telemetry", () => {
  test("both choices finish setup across restarts; absent or corrupt consent does not", async () => {
    const { bodies, send } = capture(); const { collector, options } = make(send);
    expect(collector.snapshot()).toMatchObject({ decided: false, enabled: false });
    collector.setConsent(false);
    const declined = new Telemetry(options);
    expect(declined.snapshot()).toMatchObject({ decided: true, enabled: false });
    declined.record("search", 10, true); declined.summarize(); await declined.flush();
    expect(bodies).toHaveLength(0);
    declined.setConsent(true);
    expect(new Telemetry(options).snapshot()).toMatchObject({ decided: true, enabled: true });
    for (const value of ['null', '{}', '{"enabled":true}', 'broken']) {
      writeFileSync(options.file, value);
      expect(new Telemetry(options).snapshot()).toMatchObject({ decided: false, enabled: false });
    }
  });
  test("off by default; never uploads old local activity on opt-in", async () => {
    const { bodies, send } = capture(); const { collector, options } = make(send);
    collector.record("search", 12, true); collector.action("note_opened", crypto.randomUUID()); collector.summarize(); await collector.flush();
    expect(bodies).toHaveLength(0); expect(collector.snapshot().enabled).toBe(false);
    collector.setConsent(true); collector.summarize(); await collector.flush(); expect(bodies).toHaveLength(0);
    collector.record("search", 10, true, false); collector.record("search", 30, false, false); collector.summarize(); await collector.flush();
    const event = bodies[0].batch[0];
    expect(event.event).toBe("desktop_operation"); expect(event.properties).toMatchObject({ count: 2, mean_ms: 20, max_ms: 30, failures: 1, $process_person_profile: false, $geoip_disable: true });
    expect(new Telemetry(options).snapshot().enabled).toBe(true);
    expect(JSON.stringify(bodies)).not.toContain(options.root);
    expect(collector.snapshot().queued).toBe(0);
  });
  test("consent excludes accumulated activity, in-flight operations and pre-consent CPU", async () => {
    const { bodies, send } = capture(); const { options } = make(send);
    let now = 0, user = 0;
    const collector = new Telemetry({ ...options, now: () => now, cpu: () => ({ user, system: 0 }), rss: () => 64 * 1048576 });
    collector.record("search", 999, true); collector.action("note_opened", crypto.randomUUID());
    const oldRequest = collector.begin("graph");
    now = 3_000; user = 3_000_000; collector.sample();
    now = 5_000; user = 5_000_000; collector.setConsent(true);
    oldRequest(true);
    collector.summarize(); await collector.flush(); expect(bodies).toHaveLength(0);
    now = 10_000; user = 5_500_000; collector.sample();
    collector.record("note", 12, true, false); collector.action("pilot_input_accepted", crypto.randomUUID());
    collector.summarize(); await collector.flush();
    const batch = bodies[0].batch;
    expect(batch.find((e: any) => e.event === "desktop_resources").properties.cpu_mean).toBe(10);
    expect(batch.filter((e: any) => e.event === "desktop_operation").map((e: any) => e.properties.operation)).toEqual(["note_idle"]);
    expect(batch.find((e: any) => e.event === "desktop_usage").properties).toMatchObject({ action: "pilot_input_accepted", count: 1 });
    const spanningWithdrawal = collector.begin("search");
    collector.setConsent(false); collector.setConsent(true); spanningWithdrawal(true);
    collector.summarize(); await collector.flush(); expect(bodies).toHaveLength(1);
    const persisted = new Telemetry(options);
    persisted.record("graph", 1, true); persisted.summarize(); await persisted.flush();
    expect(bodies[1].batch[0].distinct_id).toBe(JSON.parse(readFileSync(options.file, "utf8")).id);
  });
  test("allowlists actions and deduplicates retries without uploading action IDs", async () => {
    const { bodies, send } = capture(); const { collector } = make(send); collector.setConsent(true);
    const id = crypto.randomUUID(); collector.action("pilot_input_accepted", id); collector.action("pilot_input_accepted", id);
    collector.action("private prompt", crypto.randomUUID()); collector.action("note_opened", "a/private/path");
    collector.summarize(); await collector.flush();
    expect(bodies[0].batch).toHaveLength(1); expect(bodies[0].batch[0].properties.count).toBe(1);
    expect(JSON.stringify(bodies)).not.toContain(id); expect(JSON.stringify(bodies)).not.toContain("private");
  });
  test("retry queue is bounded; opting out clears it and rotates identity", async () => {
    const send = (async () => new Response("", { status: 503 })) as typeof fetch;
    const { collector, options } = make(send); collector.setConsent(true);
    const first = JSON.parse(readFileSync(options.file, "utf8")).id;
    for (let i = 0; i < 140; i++) { collector.record("graph", i, true); collector.summarize(); }
    expect(collector.snapshot().queued).toBe(100); await collector.flush(); expect(collector.snapshot().delivery).toBe("retrying");
    collector.setConsent(false); expect(collector.snapshot().queued).toBe(0); expect(JSON.parse(readFileSync(options.file, "utf8"))).toEqual({ enabled: false });
    collector.setConsent(true); expect(JSON.parse(readFileSync(options.file, "utf8")).id).not.toBe(first);
  });
  test("opt-out aborts an in-flight request and cannot restore its state", async () => {
    let aborted = false;
    const send = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
    })) as typeof fetch;
    const { collector } = make(send); collector.setConsent(true); collector.record("search", 1, true); collector.summarize();
    const pending = collector.flush(); collector.setConsent(false); await pending;
    expect(aborted).toBe(true); expect(collector.snapshot()).toMatchObject({ enabled: false, queued: 0, delivery: "idle" });
  });
  test("corrupt consent and unconfigured builds fail closed", async () => {
    const { bodies, send } = capture(); const { collector, options } = make(send, false);
    collector.setConsent(true); collector.record("note", 1, true); collector.summarize(); await collector.flush(); expect(bodies).toHaveLength(0);
    writeFileSync(options.file, '{"enabled":true}'); expect(new Telemetry(options).snapshot().enabled).toBe(false);
  });
  test("CPU units, memory, presence expiry, resume gaps, and local history bounds", () => {
    const { options } = make(); let now = 0, user = 0;
    const collector = new Telemetry({ ...options, now: () => now, cpu: () => ({ user, system: 0 }), rss: () => 128 * 1048576 });
    collector.presence(true); now = 10_000; user = 5_000_000; collector.sample();
    expect(collector.snapshot().samples[0]).toMatchObject({ cpuPercent: 50, rssMB: 128, foreground: true, timerDelayMs: 0 });
    now += 60_000; collector.sample(); expect(collector.snapshot().samples).toHaveLength(1);
    now += 10_500; collector.sample(); expect(collector.snapshot().samples.at(-1)).toMatchObject({ foreground: false, timerDelayMs: 500 });
    for (let i = 0; i < 400; i++) { now += 10_000; collector.sample(); }
    expect(collector.snapshot().samples).toHaveLength(360);
    collector.close();
  });
  test("integration health goes hourly, with consent: state, code and streak, never a message", async () => {
    const { bodies, send } = capture(); let now = 10_000_000;
    const root = mkdtempSync(join(tmpdir(), "bb-telemetry-")); dirs.push(root);
    const rows: IntegrationHealth[] = [{ integration: "granola", state: "error", code: "reconnect", failures: 1700, failingHours: 40.04 }];
    const collector = new Telemetry({ root, file: join(root, "consent.json"), token: "public-test-token", region: "eu", fetch: send, now: () => now, integrations: () => rows });
    collector.summarize(); await collector.flush(); expect(bodies).toHaveLength(0);
    collector.setConsent(true); collector.summarize(); await collector.flush();
    const [event] = bodies[0].batch;
    expect(event.event).toBe("integration_health");
    expect(event.properties).toMatchObject({ integration: "granola", state: "error", code: "reconnect", needs_action: true, failures: 1700, failing_hours: 40 });
    now += 3_000_000; collector.summarize(); await collector.flush(); expect(bodies).toHaveLength(1);
    now += 700_000; rows[0] = { integration: "granola", state: "ok", failures: 0, failingHours: 0 }; collector.summarize(); await collector.flush();
    expect(bodies[1].batch[0].properties).toMatchObject({ integration: "granola", state: "ok", code: "none", needs_action: false, failures: 0 });
  });
  test("integration health reads only pollers in use, and never their messages", async () => {
    const root = nativeVault({ files: { "vault.yaml": "integrations: {}\n" } }); dirs.push(root);
    await expect(withPollStatus(root, "granola", async () => { throw new PollError("Fixture Meeting could not be read"); })).rejects.toThrow();
    expect(integrationHealth(root)).toEqual([]);
    fakeIntegrationActivation(root, "granola");
    const [row] = integrationHealth(root);
    expect(row).toMatchObject({ integration: "granola", state: "error", code: "provider", failures: 1 });
    expect(JSON.stringify(row)).not.toContain("Fixture Meeting");
  });
  test("mutation endpoint rejects foreign origins and non-JSON requests", async () => {
    const { collector } = make(); const routes = telemetryRoutes(collector);
    const server = createServer((req, res) => { dispatch(routes, req, res); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}/api/telemetry`;
    try {
      expect((await fetch(url, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: '{"enabled":true}' })).status).toBe(403);
      expect((await fetch(url, { method: "POST", body: '{"enabled":true}' })).status).toBe(415);
      expect(collector.snapshot().enabled).toBe(false);
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"enabled":true}' });
      expect(r.status).toBe(200); expect(collector.snapshot().enabled).toBe(true);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
