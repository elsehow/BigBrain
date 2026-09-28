import { expect, test } from "bun:test";
import { singleFlight } from "../web/ui/src/lib/singleFlight";

test("concurrent refresh consumers share a result, and the next refresh reads again", async () => {
  let release!: (value: number) => void, calls = 0;
  const refresh = singleFlight(() => { calls++; return new Promise<number>(resolve => { release = resolve; }); });
  const first = refresh(), second = refresh();
  expect(first).toBe(second); await Promise.resolve(); expect(calls).toBe(1);
  release(1); expect(await first).toBe(1); expect(await second).toBe(1);
  const third = refresh(); await Promise.resolve(); expect(calls).toBe(2);
  release(2); expect(await third).toBe(2);
});
test("a failed refresh is shared but a later refresh can recover", async () => {
  let calls = 0;
  const refresh = singleFlight(async () => { if (!calls++) throw new Error("offline"); return "recovered"; });
  const first = refresh(), second = refresh();
  expect(first).toBe(second); await expect(first).rejects.toThrow("offline");
  expect(await refresh()).toBe("recovered");
});
