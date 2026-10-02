import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { applyConfig } from "../lib/config";
import { screen } from "../lib/firewall";
import { installModel, llamaServerPath, localFirewallUrl, modelInstalled, modelPath, type FirewallModel } from "../lib/firewallModel";
import { loadManifest, parseFirewall } from "../lib/manifest";
import { gitVault, mdVault } from "./support/vault";

// The firewall's local model: config, the verified download, the server
// binary, and the windowing that keeps a prompt inside one llama.cpp batch.
// Every byte here is invented.

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["BIGBRAIN_MODELS_DIR", "BIGBRAIN_LLAMA_SERVER", "BIGBRAIN_FIREWALL_PORT"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("config", () => {
  test("a block without a url is the local model; with one, that endpoint", () => {
    expect(parseFirewall({})).toEqual({ model: "clef-flash", thresholds: { credential: 0.25, malicious: 0.85 } });
    expect(parseFirewall({ url: "https://decide.example/v1/systemone" })?.url).toBe("https://decide.example/v1/systemone");
    expect(() => parseFirewall({ url: "ftp://nope" })).toThrow("url");
    process.env["BIGBRAIN_FIREWALL_PORT"] = "4999";
    expect(localFirewallUrl()).toBe("http://127.0.0.1:4999/v1/systemone");
  });

  test("the local port never inherits a bare PORT (that is the api's own port)", () => {
    const prior = process.env["PORT"];
    process.env["PORT"] = "4747";
    try {
      expect(localFirewallUrl()).toBe("http://127.0.0.1:4750/v1/systemone");
    } finally {
      if (prior === undefined) delete process.env["PORT"];
      else process.env["PORT"] = prior;
    }
  });

  test("applyConfig turns it on and off, committed, keeping the file's comments", () => {
    const root = gitVault({ files: { "vault.yaml": "# my vault\nintegrations: {}\n" } });
    expect(applyConfig({ firewall: { model: "clef-flash" } }, root).committed).toBe(true);
    expect(loadManifest(root).firewall?.model).toBe("clef-flash");
    expect(readFileSync(join(root, "vault.yaml"), "utf8")).toContain("# my vault");
    expect(applyConfig({ firewall: { model: "clef-flash" } }, root).changed).toEqual([]);
    expect(applyConfig({ firewall: null }, root).committed).toBe(true);
    expect(loadManifest(root).firewall).toBeUndefined();
    expect(() => applyConfig({ firewall: { model: "clef-flash", url: "nope" } }, root)).toThrow("url");
  });
});

describe("the verified download", () => {
  const bytes = new TextEncoder().encode("invented model weights ".repeat(64));
  const model = (over: Partial<FirewallModel> = {}): FirewallModel => ({
    repo: "example/model-GGUF",
    revision: "0".repeat(40),
    file: "Model-Q8_0.gguf",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    license: "Apache-2.0",
    ...over,
  });
  const serve = (honorRange = true): { fetch: typeof fetch; urls: string[]; ranges: (string | null)[] } => {
    const urls: string[] = [];
    const ranges: (string | null)[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      const range = new Headers(init?.headers).get("range");
      ranges.push(range);
      const from = range && honorRange ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
      return new Response(bytes.slice(from), { status: from ? 206 : 200 });
    }) as typeof fetch;
    return { fetch: f, urls, ranges };
  };

  test("downloads the pinned revision, verifies, and installs", async () => {
    process.env["BIGBRAIN_MODELS_DIR"] = mkdtempSync(join(tmpdir(), "bb-models-"));
    const m = model();
    const s = serve();
    expect(modelInstalled(m)).toBe(false);
    await installModel(m, () => {}, s.fetch);
    expect(s.urls).toEqual([`https://huggingface.co/example/model-GGUF/resolve/${"0".repeat(40)}/Model-Q8_0.gguf`]);
    expect(modelInstalled(m)).toBe(true);
    await installModel(m, () => {}, s.fetch); // installed: no second download
    expect(s.urls).toHaveLength(1);
  });

  test("resumes a partial download, and starts over when the server ignores the range", async () => {
    const m = model();
    for (const honor of [true, false]) {
      process.env["BIGBRAIN_MODELS_DIR"] = mkdtempSync(join(tmpdir(), "bb-models-"));
      writeFileSync(`${modelPath(m)}.part`, bytes.slice(0, 100));
      const s = serve(honor);
      await installModel(m, () => {}, s.fetch);
      expect(s.ranges).toEqual(["bytes=100-"]);
      expect(readFileSync(modelPath(m))).toEqual(Buffer.from(bytes));
    }
  });

  test("a file that does not match its sha256 is deleted, never installed", async () => {
    process.env["BIGBRAIN_MODELS_DIR"] = mkdtempSync(join(tmpdir(), "bb-models-"));
    const m = model({ sha256: "f".repeat(64) });
    await expect(installModel(m, () => {}, serve().fetch)).rejects.toThrow("corrupt");
    expect(modelInstalled(m)).toBe(false);
    expect(existsSync(`${modelPath(m)}.part`)).toBe(false);
  });
});

test("the server binary: an override must exist; otherwise beside bun, or none", () => {
  process.env["BIGBRAIN_LLAMA_SERVER"] = "/nonexistent/llama-server";
  expect(llamaServerPath()).toBeUndefined();
  const bin = join(mkdtempSync(join(tmpdir(), "bb-bin-")), "llama-server");
  writeFileSync(bin, "");
  process.env["BIGBRAIN_LLAMA_SERVER"] = bin;
  expect(llamaServerPath()).toBe(bin);
});

describe("windows that fit the server's batch", () => {
  // A fake endpoint with llama.cpp's limit: refuse a state over 3000
  // characters as too large. A secret sits past every window boundary.
  const seen: number[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { state } = (await req.json()) as { state: string };
      seen.push(state.length);
      if (state.length > 3000)
        return Response.json({ error: { code: 500, message: "input (9000 tokens) is too large to process. increase the physical batch size" } }, { status: 500 });
      const p = (hit: boolean) => ({ type: "noul", noul: hit ? 0.97 : 0.02 });
      return Response.json({ answers: { credential: p(state.includes("RESET-TOKEN")), malicious: p(false) } });
    },
  });
  afterAll(() => server.stop(true));

  test("a window the server calls too large is halved until it fits, and the secret is still found", async () => {
    const root = mdVault({ prefix: "bb-fw-", files: { "vault.yaml": `firewall:\n  url: http://127.0.0.1:${server.port}/v1/systemone\n` } });
    const v = await screen(root, "x".repeat(7000) + " RESET-TOKEN");
    expect(v.pass).toBe(false);
    expect(Math.max(...seen.filter((n) => n <= 3000))).toBeLessThanOrEqual(3000);
    expect(seen.some((n) => n > 3000)).toBe(true);
  });
});

test("the supervisor plans the model server only once the firewall is local and the model is installed", async () => {
  const root = mdVault({ prefix: "bb-fw-plan-", files: { "vault.yaml": "integrations: {}\nfirewall:\n  model: clef-flash\n" } });
  const models = mkdtempSync(join(tmpdir(), "bb-models-"));
  const plan = async (): Promise<string> => {
    const child = Bun.spawn([process.execPath, "bin/desktop.ts", "--dry-run"], {
      env: { ...process.env, BIGBRAIN_VAULT: root, BIGBRAIN_DEV: "1", HOME: root, BIGBRAIN_MODELS_DIR: models },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return out;
  };
  expect(await plan()).not.toContain("firewall-server");
  // Installed is the verified size in place: a sparse file stands in for 9.7 GB.
  const { firewallModel } = await import("../lib/firewallModel");
  const m = firewallModel("clef-flash");
  const { openSync, ftruncateSync, closeSync } = await import("node:fs");
  const fd = openSync(join(models, m.file), "w");
  ftruncateSync(fd, m.bytes);
  closeSync(fd);
  expect(await plan()).toContain("bin/firewall-server.ts");
  writeFileSync(join(root, "vault.yaml"), "integrations: {}\nfirewall:\n  url: https://decide.example/v1/systemone\n");
  expect(await plan()).not.toContain("firewall-server");
});
