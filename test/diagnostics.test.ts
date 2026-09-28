import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { diagnosticsReport, diagnosticsRoutes, findOnPath, logOrder, renderBundle, shellLogPath, tailFile } from "../lib/diagnostics";
import { dispatch, type Route } from "../lib/httpx";
import { NATIVE_YAML, nativeVault } from "./support/vault";

// settings › diagnostics (#710): the logs the app already writes, read
// back — tail-first, bounded, and rendered once as text for a message.
const tmp = (): string => mkdtempSync(join(tmpdir(), "bb-diag-"));

describe("tailFile", () => {
  test("the last n lines, and the whole count when the file was read whole", () => {
    const f = join(tmp(), "a.log");
    writeFileSync(f, Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    const t = tailFile(f, "a", 5);
    expect(t.lines).toEqual(["line 16", "line 17", "line 18", "line 19", "line 20"]);
    expect(t.total).toBe(20);
    expect(t.missing).toBe(false);
    expect(t.modified).toBeTruthy();
  });

  test("a big file is read from its end only: the torn first line is dropped, the count unknown", () => {
    const f = join(tmp(), "big.log");
    writeFileSync(f, Array.from({ length: 200 }, (_, i) => `entry number ${i + 1} with some padding`).join("\n") + "\n");
    const t = tailFile(f, "big", 3, 300);
    expect(t.lines).toEqual(["entry number 198 with some padding", "entry number 199 with some padding", "entry number 200 with some padding"]);
    expect(t.total).toBeNull();
    expect(t.lines.every((l) => l.startsWith("entry number"))).toBe(true);
  });

  test("a missing file is said, not thrown", () => {
    const t = tailFile(join(tmp(), "nope.log"), "nope");
    expect(t).toMatchObject({ name: "nope", missing: true, lines: [], bytes: 0, modified: null });
  });
});

describe("findOnPath", () => {
  test("the first hit on the PATH, files only", () => {
    const d = tmp();
    mkdirSync(join(d, "a"));
    mkdirSync(join(d, "b"));
    mkdirSync(join(d, "a", "claude")); // a directory named claude is not a command
    writeFileSync(join(d, "b", "claude"), "#!/bin/sh\n");
    expect(findOnPath("claude", `${join(d, "a")}:${join(d, "b")}:`)).toBe(join(d, "b", "claude"));
    expect(findOnPath("claude", join(d, "a"))).toBeNull();
  });
});

describe("logOrder and the shell log", () => {
  test("tend first, then api and web, then the rest by name", () => {
    expect(logOrder(["web", "granola", "api", "agent-chat", "tend", "publish"])).toEqual(["tend", "api", "web", "agent-chat", "granola", "publish"]);
    expect(logOrder(["granola"])).toEqual(["granola"]);
  });

  test("the shell writes under the app identifier, per platform", () => {
    expect(shellLogPath("darwin", "/Users/z")).toBe("/Users/z/Library/Logs/cool.bigbrain.desktop/BigBrain.log");
    expect(shellLogPath("linux", "/home/z")).toBe("/home/z/.local/share/cool.bigbrain.desktop/logs/BigBrain.log");
  });
});

describe("diagnosticsReport + renderBundle", () => {
  test("reads the vault's job logs tend-first and names a missing shell log", () => {
    const root = nativeVault({ files: { "vault.yaml": NATIVE_YAML } }); // auth: max by default — the bundle names it
    mkdirSync(join(root, ".state", "logs"), { recursive: true });
    writeFileSync(join(root, ".state", "logs", "api.log"), "api: listening\n");
    writeFileSync(join(root, ".state", "logs", "tend.log"), "tend: nothing due\ntend: round 1: spawn claude ENOENT\n");
    const r = diagnosticsReport(root, { shellLog: join(root, "no-shell.log") });
    expect(r.logs.map((l) => l.name)).toEqual(["tend", "api", "shell"]);
    expect(r.logs[0]!.lines.at(-1)).toBe("tend: round 1: spawn claude ENOENT");
    expect(r.logs.at(-1)).toMatchObject({ name: "shell", missing: true });
    expect(r.facts.vault).toBe(root);
    expect(r.facts.intake).toEqual({ running: false, lockPid: null });
    expect(r.facts.nextFires).toBeNull(); // nobody keeps a clock in a test

    const text = renderBundle(r, "0.1.23");
    expect(text).toContain("app         0.1.23");
    expect(text).toContain(`vault       ${root}`);
    expect(text).toContain("no live supervisor keeps the clock");
    expect(text).toContain("── tend: ");
    expect(text).toContain("spawn claude ENOENT");
    expect(text).toContain("(missing)");
    expect(renderBundle(r, null)).toContain("app         (not the desktop app)");
    // the credential line: Claude Code's own word, and vault.yaml's auth beside it
    expect(text).toMatch(/^model       anthropic · Pi · (connected|check Models settings)/m);
    expect(r.facts.auth).toEqual({ mode: "max", keyPresent: expect.any(Boolean) });
    // a vault not yet on the memory clock says so
    expect(r.facts.memory).toEqual({ lastRunAt: null, nextRunAt: null, failed: null });
    expect(text).toMatch(/^memory      never run — the first run is `bigbrain tend --force`/m);
  });

  // A failed memory run takes the interval's slot without a word anywhere
  // else (lib/memoryRun.ts, 2026-09-03): this line is where it shows.
  test("the memory line: last fold, next sweep, and the last attempt when it failed", () => {
    const failedRun = "2026-09-03T10-30-00-000Z-bbbb";
    const root = nativeVault({
      files: {
        "vault.yaml": NATIVE_YAML,
        ".state/memory.json": JSON.stringify({
          lastRunAt: "2026-09-02T10:00:00.000Z",
          nextRunAt: "2026-09-03T11:00:00.000Z",
          run: "2026-09-02T10-00-00-000Z-aaaa",
        }),
        "journal/memory/2026-09-02T10-00-00-000Z-aaaa.json": JSON.stringify({
          run: "2026-09-02T10-00-00-000Z-aaaa",
          startedAt: "2026-09-02T10:00:00.000Z",
        }),
        [`journal/memory/${failedRun}.json`]: JSON.stringify({
          run: failedRun,
          startedAt: "2026-09-03T10:30:00.000Z",
          error: "memory: claude -p failed (null):\n  spawn claude ENOENT\n",
        }),
      },
    });
    const r = diagnosticsReport(root, { shellLog: join(root, "no-shell.log") });
    expect(r.facts.memory).toEqual({
      lastRunAt: "2026-09-02T10:00:00.000Z",
      nextRunAt: "2026-09-03T11:00:00.000Z",
      // one line, whitespace folded
      failed: { run: failedRun, at: "2026-09-03T10:30:00.000Z", error: "memory: claude -p failed (null): spawn claude ENOENT" },
    });
    const text = renderBundle({ ...r, facts: { ...r.facts, at: "2026-09-03T11:00:00.000Z" } }, null);
    expect(text).toContain(
      `memory      last folded 25h 0m ago · next now · last attempt FAILED 30m ago (run ${failedRun}): memory: claude -p failed (null): spawn claude ENOENT`
    );
    // a successful newest run is no failure to report
    writeFileSync(
      join(root, "journal", "memory", "2026-09-03T11-00-00-000Z-cccc.json"),
      JSON.stringify({ run: "2026-09-03T11-00-00-000Z-cccc", startedAt: "2026-09-03T11:00:00.000Z" })
    );
    expect(diagnosticsReport(root, { shellLog: join(root, "no-shell.log") }).facts.memory.failed).toBeNull();
  });

  test("a vault with no logs yet still answers", () => {
    const root = nativeVault();
    const r = diagnosticsReport(root, { shellLog: join(root, "no-shell.log") });
    expect(r.logs.map((l) => l.name)).toEqual(["shell"]);
  });
});

// the routes, dispatched as web/server.ts would
function call(routes: Route[], method: string, path: string): Promise<{ code: number; type: string; body: string }> {
  return new Promise((resolve) => {
    const req = Object.assign(new PassThrough(), { method, url: path, headers: { host: "127.0.0.1" } });
    let code = 0;
    let type = "";
    let body = "";
    const res = {
      writeHead: (c: number, h?: Record<string, string>) => { code = c; type = h?.["content-type"] ?? ""; },
      setHeader() {},
      write: (b: string) => { body += b; },
      end: (b?: string) => { body += b ?? ""; resolve({ code, type, body }); },
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    dispatch(routes, req as any, res as any);
    req.end();
  });
}

describe("diagnosticsRoutes", () => {
  test("GET /api/diagnostics is the report; .txt is its text twin with the app version", async () => {
    const root = nativeVault();
    mkdirSync(join(root, ".state", "logs"), { recursive: true });
    writeFileSync(join(root, ".state", "logs", "tend.log"), "tend: nothing due\n");
    const routes = diagnosticsRoutes(root);
    const r = await call(routes, "GET", "/api/diagnostics");
    expect(r.code).toBe(200);
    const body = JSON.parse(r.body) as { facts: { vault: string }; logs: { name: string }[] };
    expect(body.facts.vault).toBe(root);
    expect(body.logs[0]!.name).toBe("tend");
    const t = await call(routes, "GET", "/api/diagnostics.txt?app=0.1.23");
    expect(t.code).toBe(200);
    expect(t.type).toContain("text/plain");
    expect(t.body).toContain("app         0.1.23");
    expect(t.body).toContain("tend: nothing due");
  });

  test("reveal names the folder even when it is not there to open", async () => {
    const root = nativeVault();
    const r = await call(diagnosticsRoutes(root), "POST", "/api/diagnostics/reveal");
    expect(JSON.parse(r.body)).toEqual({ ok: false, path: join(root, ".state", "logs") });
  });

  test("reveal shows the logs folder once it exists — through the opener it is given", async () => {
    const root = nativeVault();
    const dir = join(root, ".state", "logs");
    mkdirSync(dir, { recursive: true });
    const opened: string[] = [];
    const r = await call(diagnosticsRoutes(root, (d) => { opened.push(d); return true; }), "POST", "/api/diagnostics/reveal");
    expect(JSON.parse(r.body)).toEqual({ ok: true, path: dir });
    expect(opened).toEqual([dir]);
  });
});
