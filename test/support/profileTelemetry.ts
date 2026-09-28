/** Synthetic collector overhead; no vault content, network, or real preferences. */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Telemetry } from "../../lib/telemetry";
const root = mkdtempSync(join(tmpdir(), "bb-profile-telemetry-"));
try {
  for (const enabled of [false, true]) {
    let now = Date.now();
    const collector = new Telemetry({ root, file: join(root, "consent.json"), now: () => now });
    collector.setConsent(enabled);
    const cpu = process.cpuUsage(), started = performance.now();
    const iterations = 10_000;
    for (let i = 0; i < iterations; i++) { now += 10_000; collector.sample(); }
    const used = process.cpuUsage(cpu);
    console.log(JSON.stringify({ enabled, iterations, wallMicrosecondsPerSample: (performance.now() - started) * 1000 / iterations,
      cpuMicrosecondsPerSample: (used.user + used.system) / iterations, retainedSamples: collector.snapshot().samples.length }));
    collector.close();
  }
} finally { rmSync(root, { recursive: true, force: true }); }
