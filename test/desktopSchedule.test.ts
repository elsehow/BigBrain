import { describe, expect, test } from "bun:test";
import { CADENCE, cadence, Scheduler, durationLabel, wokeAfter } from "../lib/desktopSchedule";

const T0 = 1_700_000_000_000;
const none = new Set<string>();
const jobs = [
  { name: "tend", interval: 300, atStart: true },
  { name: "publish", interval: 900, atStart: false },
  { name: "granola", interval: 300, atStart: false },
];

describe("Scheduler", () => {
  test("atStart jobs fire on the first beat; the rest wait one interval", () => {
    const s = new Scheduler(jobs, T0);
    expect(s.due(T0, none)).toEqual(["tend"]);
    s.started("tend", T0);
    expect(s.due(T0 + 1000, none)).toEqual([]);
    expect(s.due(T0 + 300_000, none)).toEqual(["tend", "granola"]);
    expect(s.due(T0 + 900_000, none)).toEqual(["tend", "publish", "granola"]);
  });

  test("a fire pushes the clock a full interval from now, not from the missed slot", () => {
    const s = new Scheduler(jobs, T0);
    s.started("tend", T0 + 17_000); // fired 17 s late
    expect(s.nextAt("tend")).toBe(T0 + 317_000);
    expect(s.due(T0 + 316_000, none)).not.toContain("tend");
    expect(s.due(T0 + 317_000, none)).toContain("tend");
  });

  test("two hours asleep = one catch-up fire per job, never one per missed interval", () => {
    const s = new Scheduler(jobs, T0);
    for (const n of s.due(T0, none)) s.started(n, T0);
    const wake = T0 + 2 * 3_600_000;
    const first = s.due(wake, none);
    expect(first).toEqual(["tend", "publish", "granola"]);
    for (const n of first) s.started(n, wake);
    // The very next beat: nothing — the backlog was one fire each.
    expect(s.due(wake + 1000, none)).toEqual([]);
    expect(s.due(wake + 299_000, none)).toEqual([]);
    expect(s.due(wake + 300_000, none)).toEqual(["tend", "granola"]);
  });

  test("a job still running is skipped and fires on the first beat after it exits", () => {
    const s = new Scheduler(jobs, T0);
    s.started("tend", T0);
    const running = new Set(["tend"]);
    expect(s.due(T0 + 400_000, running)).toEqual(["granola"]);
    expect(s.due(T0 + 400_000, none)).toEqual(["tend", "granola"]);
  });

  test("a poke brings the clock to now — the arrival does not wait out the tick", () => {
    const s = new Scheduler(jobs, T0);
    s.started("tend", T0);
    const arrived = T0 + 22_000; // 22 s in; 278 s still to run on the clock
    expect(s.due(arrived, none)).toEqual([]);
    s.poke("tend", arrived);
    expect(s.due(arrived, none)).toEqual(["tend"]);
    // and only that job — a wake is never a general catch-up
    expect(s.due(arrived, none)).not.toContain("publish");
  });

  test("a poke fires ONCE: the fire it earns resets the clock a full interval", () => {
    const s = new Scheduler(jobs, T0);
    s.started("tend", T0);
    s.poke("tend", T0 + 1000);
    s.started("tend", T0 + 1000);
    expect(s.due(T0 + 2000, none)).toEqual([]);
    expect(s.nextAt("tend")).toBe(T0 + 301_000);
  });

  test("a poke during a run waits for it, then fires on the first beat after", () => {
    const s = new Scheduler(jobs, T0);
    s.started("tend", T0);
    s.poke("tend", T0 + 5_000);
    expect(s.due(T0 + 6_000, new Set(["tend"]))).toEqual([]);
    expect(s.due(T0 + 6_000, none)).toEqual(["tend"]);
  });

  test("a job the plan does not carry cannot be poked into existence", () => {
    const s = new Scheduler(jobs, T0);
    s.poke("gmail", T0);
    expect(s.nextAt("gmail")).toBeUndefined();
    expect(s.due(T0, none)).toEqual(["tend"]); // the atStart job, and nothing new
  });
});

describe("wokeAfter", () => {
  test("an on-time beat is 0; a gap wider than the tolerance is the gap", () => {
    expect(wokeAfter(T0, T0 + 1000, 1000)).toBe(0);
    expect(wokeAfter(T0, T0 + 2900, 1000)).toBe(0);
    expect(wokeAfter(T0, T0 + 3001, 1000)).toBe(3001);
    expect(wokeAfter(T0, T0 + 7_200_000, 1000)).toBe(7_200_000);
  });
});

describe("durationLabel", () => {
  test("ms, s, min", () => {
    expect(durationLabel(800)).toBe("800 ms");
    expect(durationLabel(40_367)).toBe("40 s");
    expect(durationLabel(7_200_000)).toBe("120 min");
  });
});

describe("cadence", () => {
  // These four numbers were the launchd templates' `StartInterval` until
  // #645; the table is now their only home, so they get pinned here. A
  // change to one of them is a change to how often the machine works.
  test("every recurring job's interval, by name", () => {
    expect(CADENCE).toEqual({ tend: 300, publish: 900, granola: 60, email: 60, "that-tracks": 60 });
  });

  test("the two inbound pollers run every minute, not the workers' five", () => {
    expect(CADENCE["agent-chat"]).toBeUndefined();
    // granola joined at a minute on 2026-09-04: one cheap list call per poll
    expect(cadence("granola")).toBe(60);
    expect(cadence("tend")).toBe(300);
  });

  test("an integration with no entry gets the 5-minute default", () => {
    expect(cadence("something-new")).toBe(300);
  });
});

describe("Scheduler.add — a job the plan gained after start (#749)", () => {
  const T0 = Date.parse("2026-09-04T10:00:00Z");
  const none = new Set<string>();
  test("joins the rotation; atStart fires on the next beat, otherwise one interval out; a known name is left alone", () => {
    const s = new Scheduler([{ name: "tend", interval: 300, atStart: false }], T0);
    s.add({ name: "email", interval: 60, atStart: true }, T0 + 5_000);
    expect(s.due(T0 + 5_000, none)).toEqual(["email"]);
    s.started("email", T0 + 5_000);
    expect(s.due(T0 + 64_000, none)).toEqual([]);
    expect(s.due(T0 + 65_000, none)).toEqual(["email"]);
    s.add({ name: "granola", interval: 60, atStart: false }, T0 + 10_000);
    expect(s.nextAt("granola")).toBe(T0 + 70_000);
    const before = s.nextAt("tend");
    s.add({ name: "tend", interval: 1, atStart: true }, T0 + 20_000);
    expect(s.nextAt("tend")).toBe(before);
  });
});
