import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrationStatus, PollError, pollErrorCode, pollHealth, withPollStatus } from "../lib/integrationStatus";
const scratch = () => mkdtempSync(join(tmpdir(), "bb-poll-status-"));

test("quiet successful polls update checked time independently of last arrival", async () => {
  const root = scratch();
  expect(integrationStatus(root, "granola", false, false).state).toBe("off");
  expect(integrationStatus(root, "granola", true, false).state).toBe("unset");
  expect(integrationStatus(root, "granola", true, true).state).toBe("waiting");
  await withPollStatus(root, "granola", async () => ({ arrivals: 1 }));
  const first = integrationStatus(root, "granola", true, true);
  expect(first.checkedAt).toBeTruthy(); expect(first.lastArrivalAt).toBeTruthy();
  await withPollStatus(root, "granola", async () => ({ arrivals: 0 }));
  const quiet = integrationStatus(root, "granola", true, true);
  expect(quiet.state).toBe("ok"); expect(quiet.lastArrivalAt).toBe(first.lastArrivalAt);
  expect(integrationStatus(root, "granola", true, true, Date.now() + 240_000).state).toBe("waiting");
});

test("errors preserve last successful check; arbitrary errors and credentials never reach settings", async () => {
  const root = scratch();
  await withPollStatus(root, "granola", async () => ({ arrivals: 0 }));
  const checked = integrationStatus(root, "granola", true, true).checkedAt;
  await expect(withPollStatus(root, "granola", async () => { throw new Error("secret-key"); })).rejects.toThrow();
  expect(integrationStatus(root, "granola", true, true)).toMatchObject({ state: "error", checkedAt: checked });
  expect(readFileSync(join(root, ".state/integrations/granola.json"), "utf8")).not.toContain("secret-key");
  await expect(withPollStatus(root, "granola", async () => { throw new PollError("Replace the key"); })).rejects.toThrow();
  expect(integrationStatus(root, "granola", true, true).label).toBe("Replace the key");
  await withPollStatus(root, "granola", async () => ({ arrivals: 0 }));
  expect(integrationStatus(root, "granola", true, true).label).toBe("Up to date");
});

test("import progress is visible, corrupt status recovers, and stopped imports do not spin forever", async () => {
  const root = scratch();
  await withPollStatus(root, "that-tracks", async progress => {
    progress("importing");
    expect(integrationStatus(root, "that-tracks", true, true).state).toBe("importing");
    expect(integrationStatus(root, "that-tracks", true, true, Date.now() + 240_000).state).toBe("waiting");
    return { arrivals: 0 };
  });
  writeFileSync(join(root, ".state/integrations/that-tracks.json"), "{");
  expect(integrationStatus(root, "that-tracks", true, true).state).toBe("waiting");
});

test("a failure's code, streak and start ride the receipt; success ends the streak", async () => {
  const root = scratch();
  await expect(withPollStatus(root, "granola", async () => { throw new PollError("Reconnect it", "reconnect"); })).rejects.toThrow();
  const first = integrationStatus(root, "granola", true, true);
  expect(first).toMatchObject({ state: "error", label: "Reconnect it", code: "reconnect", needsAction: true });
  expect(first.failingSince).toBeTruthy();
  await expect(withPollStatus(root, "granola", async () => { throw Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" }); })).rejects.toThrow();
  expect(integrationStatus(root, "granola", true, true)).toMatchObject({ code: "network", needsAction: false, failingSince: first.failingSince });
  const health = pollHealth(root, "granola", Date.parse(first.failingSince!) + 2 * 3_600_000);
  expect(health).toEqual({ state: "error", code: "network", failures: 2, failingHours: 2 });
  await withPollStatus(root, "granola", async () => ({ arrivals: 0 }));
  const ok = integrationStatus(root, "granola", true, true);
  expect(ok.state).toBe("ok"); expect(ok.code).toBeUndefined(); expect(ok.failingSince).toBeUndefined();
  expect(pollHealth(root, "granola")).toEqual({ state: "ok", failures: 0, failingHours: 0 });
});

test("a poll killed mid-run neither ends nor restarts a streak; unknown errors and forged codes say nothing", async () => {
  const root = scratch(), file = join(root, ".state/integrations/granola.json");
  await expect(withPollStatus(root, "granola", async () => { throw new Error("secret-key"); })).rejects.toThrow();
  const since = integrationStatus(root, "granola", true, true).failingSince;
  await withPollStatus(root, "granola", async () => {
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ state: "checking", failures: 1, failingSince: since });
    throw new DOMException("timed out", "TimeoutError");
  }).catch(() => {});
  expect(pollHealth(root, "granola")).toMatchObject({ code: "network", failures: 2 });
  expect(pollErrorCode(new Error("anything"))).toBe("unknown");
  writeFileSync(file, JSON.stringify({ state: "error", at: new Date().toISOString(), code: "secret-key", failures: "many" }));
  expect(pollHealth(root, "granola")).toEqual({ state: "error", failures: 0, failingHours: 0 });
  expect(integrationStatus(root, "granola", true, true).code).toBeUndefined();
});
