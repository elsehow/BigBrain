import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mdVault } from "./support/vault";

test("concurrent conflicting appends accept exactly one complete event", async () => {
  const root = mdVault({ dirs: ["log/events/2026-09"] });
  const children = Array.from({ length: 6 }, (_, i) => Bun.spawn([
    process.execPath, join(import.meta.dir, "support/eventLogWriter.ts"), root, String(i),
  ], { stdout: "pipe", stderr: "pipe" }));
  try {
    const deadline = Date.now() + 10_000;
    while (!children.every((_, i) => existsSync(join(root, `ready-${i}`)))) {
      if (Date.now() > deadline) throw new Error("writers did not start");
      await Bun.sleep(2);
    }
    writeFileSync(join(root, "go"), "");
    const results = await Promise.all(children.map(async (child) => {
      const text = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return JSON.parse(text) as { writer: string; accepted: boolean; error?: string };
    }));
    const accepted = results.filter((r) => r.accepted);
    expect(accepted).toHaveLength(1);
    expect(results.filter((r) => !r.accepted).every((r) => r.error?.includes("immutable event collision"))).toBe(true);
    const dir = join(root, "log/events/2026-09");
    expect(JSON.parse(readFileSync(join(dir, "one-event.json"), "utf8"))).toEqual({ id: "one-event", value: accepted[0]!.writer });
    expect(readdirSync(dir)).toEqual(["one-event.json"]);
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
