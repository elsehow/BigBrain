import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "../lib/fsx";
import {
  clearNextFires,
  nextFireFile,
  readNextFire,
  requestWake,
  takeWake,
  writeNextFires,
} from "../lib/supervisorClock";

const vault = (): string => mkdtempSync(join(tmpdir(), "bb-clock-"));

describe("wake requests — the arrival's nudge to the supervisor's clock", () => {
  test("a request is taken exactly once", () => {
    const root = vault();
    expect(takeWake(root, "tend")).toBe(false); // nothing asked yet
    requestWake(root, "tend");
    expect(takeWake(root, "tend")).toBe(true);
    expect(takeWake(root, "tend")).toBe(false); // consumed
  });

  test("a burst of arrivals is ONE fire, not one each", () => {
    const root = vault();
    for (let i = 0; i < 50; i++) requestWake(root, "tend");
    expect(takeWake(root, "tend")).toBe(true);
    expect(takeWake(root, "tend")).toBe(false);
  });

  test("requests are per job — waking tend does not wake publish", () => {
    const root = vault();
    requestWake(root, "tend");
    expect(takeWake(root, "publish")).toBe(false);
    expect(takeWake(root, "tend")).toBe(true);
  });

  test("a job name that is not a plain segment is refused, never joined into a path", () => {
    const root = vault();
    for (const bad of ["../../etc/passwd", "a/b", "", ".", "Tend"]) {
      requestWake(root, bad);
      expect(takeWake(root, bad)).toBe(false);
    }
  });

  test("an unwritable vault costs a nudge, never an arrival", () => {
    // The landing path calls this AFTER the event is durable; it must not
    // throw whatever the filesystem says.
    expect(() => requestWake(join(tmpdir(), "bb-no-such-vault-ever"), "tend")).not.toThrow();
  });
});

describe("the published clock — when the job actually fires next", () => {
  test("a live supervisor's stamp is read back per job", () => {
    const root = vault();
    const at = Date.now() + 42_000;
    writeNextFires(root, { tend: at, publish: at + 1000 });
    expect(readNextFire(root, "tend")).toBe(at);
    expect(readNextFire(root, "publish")).toBe(at + 1000);
  });

  test("a job the plan does not carry has no clock here", () => {
    const root = vault();
    writeNextFires(root, { tend: Date.now() });
    expect(readNextFire(root, "granola")).toBeNull();
  });

  test("no stamp at all (a launchd install) is null, not zero", () => {
    expect(readNextFire(vault(), "tend")).toBeNull();
  });

  test("a stamp from a DEAD supervisor promises nothing", () => {
    const root = vault();
    ensureDir(join(root, ".state"));
    // pid 1 is alive but not ours; a pid that cannot exist is the case that
    // matters — a hard-killed supervisor leaves its stamp behind.
    writeFileSync(
      nextFireFile(root),
      JSON.stringify({ pid: 0x7fffffff, jobs: { tend: Date.now() + 1000 } })
    );
    expect(readNextFire(root, "tend")).toBeNull();
  });

  test("a torn or foreign stamp reads as null rather than throwing", () => {
    const root = vault();
    ensureDir(join(root, ".state"));
    for (const junk of ["{", "null", "[]", '{"jobs":{"tend":1}}', '{"pid":"x","jobs":{}}']) {
      writeFileSync(nextFireFile(root), junk);
      expect(readNextFire(root, "tend")).toBeNull();
    }
  });

  test("a clean stop leaves no clock behind", () => {
    const root = vault();
    writeNextFires(root, { tend: Date.now() + 1000 });
    expect(readNextFire(root, "tend")).not.toBeNull();
    clearNextFires(root);
    expect(readNextFire(root, "tend")).toBeNull();
  });
});
