import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectRunUsage } from "../lib/meter";
import { mdVault } from "./support/vault";

const RESET_7D = "2026-09-02T17:00:00.000Z"; // Wed 10:00 PDT
const RESET_5H = "2026-08-28T01:20:00.000Z";
const r = (five: number, seven: number, reset7 = RESET_7D, reset5 = RESET_5H) => ({
  five_hour: { utilization: five, resets_at: reset5 },
  seven_day: { utilization: seven, resets_at: reset7 },
});

const vault = (): string => mdVault({
  prefix: "bb-plan-",
  dirs: ["journal/queue", "journal/memory", "journal/assertions/2026-08", "journal/tend/2026-08"],
});
const write = (root: string, rel: string, j: unknown): void =>
  writeFileSync(join(root, "journal", rel), JSON.stringify(j));

describe("historical journal usage", () => {
  test("collectRunUsage carries the meter through; a malformed one is dropped, not thrown", () => {
    const root = vault();
    write(root, "queue/ok.json", { run: "ok", startedAt: "2026-08-27T04:00:00.000Z", meter: { before: r(0, 0.1), after: r(0, 0.2) } });
    write(root, "queue/bad.json", { run: "bad", startedAt: "2026-08-27T04:00:00.000Z", meter: { before: "x", after: { seven_day: { utilization: "y" } } } });
    const per = collectRunUsage(root, "queue");
    expect(per.find((p) => p.run_id === "ok")?.meter?.after.seven_day?.utilization).toBe(0.2);
    expect(per.find((p) => p.run_id === "bad")?.meter).toBeUndefined();
  });

  // #640 gave both spawns one usage shape, so a tend journal now spells
  // cache reads `cache_read_tokens` like every other journal. Records
  // written before that — and every retired assertion-agent record — say
  // `cached_input_tokens`, and `bigbrain econ` must keep pricing them.
  test("both spellings of the cache-read count are read, old journals included", () => {
    const root = vault();
    const at = { started_at: "2026-08-27T04:00:00.000Z", model: "m" };
    write(root, "tend/2026-08/new.json", {
      format: "bigbrain-tend-run/v1", ...at,
      usage: { cost_usd: 1, cache_read_tokens: 700, cache_write_tokens: 5, turns: 1 },
    });
    write(root, "tend/2026-08/old.json", {
      format: "bigbrain-tend-run/v1", ...at,
      usage: { cost_usd: 1, cached_input_tokens: 700, cache_write_tokens: 5, turns: 1 },
    });
    const per = collectRunUsage(root, "tend");
    expect(per.find((p) => p.run_id === "new")?.cache_read_tokens).toBe(700);
    expect(per.find((p) => p.run_id === "old")?.cache_read_tokens).toBe(700);
  });
});
