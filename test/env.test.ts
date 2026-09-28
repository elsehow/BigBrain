import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ENGINE_ROOT } from "../lib/engine";
import { apiPort, webPort } from "../lib/env";

/**
 * The environment is the engine's second configuration surface, and
 * lib/env.ts is where its names live. The reads below were at 21 scattered
 * call sites before #524's follow-up, which is how "4747" came to be written
 * in three files and "4748" in three more.
 */

const sourceFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      if (f === "node_modules" || f === "dist" || f.startsWith(".")) continue;
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".ts")) out.push(p);
    }
  };
  for (const d of ["lib", "bin", "web", "integrations"]) walk(join(ENGINE_ROOT, d));
  return out;
};

/** A READ of a BIGBRAIN_* variable — an assignment (`= ...`) is a write, and
 * bin/desktop.ts legitimately sets two for its children. */
const BIGBRAIN_READ = /process\.env(?:\["BIGBRAIN_[A-Z_]+"\]|\.BIGBRAIN_[A-Z_]+)(?!\s*=[^=])/;

describe("every BIGBRAIN_* variable is named in lib/env.ts", () => {
  test("nothing else reads one out of process.env", () => {
    // web/ui/vite.config.ts is the one exception — it runs under vite's own
    // tsconfig and cannot import from lib/. Its copy is pinned by the next
    // test rather than by this one.
    const allowed = new Set(["lib/env.ts", "web/ui/vite.config.ts"]);
    const offenders = sourceFiles()
      .map((p) => relative(ENGINE_ROOT, p))
      .filter((rel) => !allowed.has(rel))
      .filter((rel) => BIGBRAIN_READ.test(readFileSync(join(ENGINE_ROOT, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  // web/ui/vite.config.ts runs under vite's own tsconfig and cannot import
  // from lib/, so it carries the one deliberate copy of the viewer's default
  // port. This is the assertion that keeps the copy honest.
  test("vite's dev-proxy default is the port lib/env.ts serves", () => {
    const cfg = readFileSync(join(ENGINE_ROOT, "web", "ui", "vite.config.ts"), "utf8");
    const m = /BIGBRAIN_WEB_PORT"\]\s*\?\?\s*"(\d+)"/.exec(cfg);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(webPort());
  });
});

describe("the port knobs", () => {
  const withEnv = <T,>(vars: Record<string, string | undefined>, fn: () => T): T => {
    const before = { ...process.env };
    try {
      for (const [k, v] of Object.entries(vars))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      return fn();
    } finally {
      for (const k of Object.keys(vars)) delete process.env[k];
      for (const [k, v] of Object.entries(before)) if (k in vars) process.env[k] = v;
    }
  };

  test("defaults: viewer 4747, intake 4748", () => {
    withEnv({ BIGBRAIN_WEB_PORT: undefined, BIGBRAIN_API_PORT: undefined, PORT: undefined }, () => {
      expect(webPort()).toBe(4747);
      expect(apiPort()).toBe(4748);
    });
  });

  test("each has its own knob", () => {
    withEnv({ BIGBRAIN_WEB_PORT: "5000", BIGBRAIN_API_PORT: "5001", PORT: undefined }, () => {
      expect(webPort()).toBe(5000);
      expect(apiPort()).toBe(5001);
    });
  });

  // A bare PORT= in the vault's .env reaches every server the vault starts,
  // because bun autoloads .env with cwd = vault. It is the LAST fallback, and
  // the per-server knob beats it — otherwise both servers pile onto one port,
  // which is the hazard .env.example warns about.
  test("PORT is the last fallback, and a specific knob beats it", () => {
    withEnv({ BIGBRAIN_WEB_PORT: undefined, BIGBRAIN_API_PORT: undefined, PORT: "6000" }, () => {
      expect(webPort()).toBe(6000);
      expect(apiPort()).toBe(6000);
    });
    withEnv({ BIGBRAIN_WEB_PORT: "7000", BIGBRAIN_API_PORT: undefined, PORT: "6000" }, () => {
      expect(webPort()).toBe(7000);
      expect(apiPort()).toBe(6000);
    });
  });
});
