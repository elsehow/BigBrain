import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { admit, FirewallUnavailable, hold, land } from "../lib/door";
import { firewallKey, windows, withheldLog } from "../lib/firewall";
import { saveJevKey } from "../lib/jevSettings";
import { JEV_MODEL } from "../lib/sharedJev";
import { readSourceInsertionLog } from "../lib/insertionLog";
import { stagedCount } from "../lib/stage";
import type { StagedItem } from "../lib/stageStorage";
import { mdVault } from "./support/vault";

// The door (lib/door.ts) is the one way an arrival persists, and the
// firewall (lib/firewall.ts) screens it first. All content here is invented.

const ENGINE = join(import.meta.dir, "..");

describe("nothing reaches the record or the stage around the door", () => {
  const sources = (dir: string): string[] =>
    readdirSync(join(ENGINE, dir), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".ts") && !d.parentPath.includes("node_modules"))
      .map((d) => relative(ENGINE, join(d.parentPath, d.name)));
  const files = [...sources("bin"), ...sources("lib"), ...sources("integrations"), "web/server.ts"];
  const importsOf = (file: string, module: RegExp): string[] => {
    const text = readFileSync(join(ENGINE, file), "utf8");
    const names: string[] = [];
    for (const m of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g))
      if (module.test(m[2]!)) names.push(...m[1]!.split(",").map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!));
    if (new RegExp(`import\\s*\\*\\s*as\\s+\\w+\\s+from\\s*["'][^"']*${module.source.replace(/\$$/, "")}["']`).test(text)) names.push("*");
    return names;
  };
  const callersOf = (name: string, module: RegExp) =>
    files.filter((f) => importsOf(f, module).some((n) => n === name || n === "*")).sort();

  test("only the door lands (receive) or stages (stage)", () => {
    expect(callersOf("receive", /\/intake$/)).toEqual(["lib/door.ts"]);
    expect(callersOf("stage", /\/stage(Storage)?$/)).toEqual(["lib/door.ts"]);
  });

  test("admit — landing what the door already staged — is for the admission paths only", () => {
    expect(callersOf("admit", /\/door$/)).toEqual(["lib/granolaRevision.ts", "lib/stage.ts", "lib/thatTracks.ts"]);
    expect(callersOf("holdCleared", /\/door$/)).toEqual(["lib/granolaStage.ts"]);
  });
});

// A fake Jev: words in the state decide the answer. The firewall's request
// goes to it (BIGBRAIN_FIREWALL_URL), with the key from a store of the
// test's own (BIGBRAIN_SHARED_CONNECTIONS) — never the machine's.
const seen: string[] = [];
const auth: (string | null)[] = [];
const models: string[] = [];
let mode: "ok" | "broken" = "ok";
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { model: string; state: string; questions: Record<string, unknown> };
    seen.push(body.state);
    auth.push(req.headers.get("authorization"));
    models.push(body.model);
    if (mode === "broken") return Response.json({ answers: {} });
    const p = (hit: boolean) => ({ type: "noul", noul: hit ? 0.97 : 0.02 });
    return Response.json({
      model: body.model,
      answers: { credential: p(/RESET-TOKEN/.test(body.state)) },
    });
  },
});
const store = join(mkdtempSync(join(tmpdir(), "bb-door-jev-")), "shared-connections.json");
const env = { url: process.env["BIGBRAIN_FIREWALL_URL"], store: process.env["BIGBRAIN_SHARED_CONNECTIONS"] };
beforeAll(() => {
  process.env["BIGBRAIN_FIREWALL_URL"] = `http://127.0.0.1:${server.port}/v1/systemone`;
  process.env["BIGBRAIN_SHARED_CONNECTIONS"] = store;
  saveJevKey(store, "example-jev-key");
});
afterAll(() => {
  server.stop(true);
  for (const [k, v] of [["BIGBRAIN_FIREWALL_URL", env.url], ["BIGBRAIN_SHARED_CONNECTIONS", env.store]] as const)
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
});
/** Run `fn` with no Jev key on the machine. */
async function keyless(fn: () => Promise<void>): Promise<void> {
  saveJevKey(store, null);
  try { await fn(); } finally { saveJevKey(store, "example-jev-key"); }
}

const vault = (yaml = "integrations: {}\n"): string => mdVault({ prefix: "bb-door-", files: { "vault.yaml": yaml } });
const item = (root: string, content: string, id = "email-1"): [string, StagedItem] => [
  root,
  { id, source: "email", at: "2026-10-01T09:00:00Z", line: "a head", scopes: {}, name: `${id}.md`, content },
];
const mail = (body: string) =>
  `---\nid: m-1\nfrom: Quillpad <no-reply@quillpad.example>\ndate: 2026-10-01T09:00:00Z\ntitle: Subject with 482910\n---\n${body}\n`;
// What a vault carried under the retired local model (#46).
const RETIRED = "integrations: {}\nfirewall:\n  model: clef-flash\n  url: http://127.0.0.1:9/v1/systemone\n  thresholds:\n    credential: 0.99\n    malicious: 0.99\n";

describe("when the firewall is on", () => {
  test("no Jev key: off — the door lands and stages as it always did", async () => {
    await keyless(async () => {
      const root = vault();
      seen.length = 0;
      await land({ root, content: mail("RESET-TOKEN") });
      expect(await hold(...item(root, mail("RESET-TOKEN")))).toBe(true);
      expect(readSourceInsertionLog(root)).toHaveLength(1);
      expect(seen).toEqual([]);
    });
  });

  test("a Jev key turns it on by default, asking Jev with that key", async () => {
    const root = vault();
    seen.length = auth.length = models.length = 0;
    await expect(land({ root, content: mail("RESET-TOKEN") })).rejects.toMatchObject({ code: "withheld" });
    expect(seen).toHaveLength(1);
    expect(auth).toEqual(["Bearer example-jev-key"]);
    expect(models).toEqual([JEV_MODEL]);
    expect(firewallKey(root)).toBe("example-jev-key");
  });

  test("turned off with a key set, it stays off; turned on without a key, it is still off", async () => {
    const off = vault("integrations: {}\nsecurity:\n  firewall: false\n");
    seen.length = 0;
    await land({ root: off, content: mail("RESET-TOKEN") });
    expect(readSourceInsertionLog(off)).toHaveLength(1);
    expect(seen).toEqual([]);
    const on = vault("integrations: {}\nsecurity:\n  firewall: true\n");
    expect(firewallKey(on)).toBe("example-jev-key");
    await keyless(async () => {
      expect(firewallKey(on)).toBeUndefined();
      await land({ root: on, content: mail("RESET-TOKEN") });
      expect(readSourceInsertionLog(on)).toHaveLength(1);
    });
  });

  test("a retired local-model block loads and is not read: no stall on a model server that is gone", async () => {
    // no key: off, though the block named a local server that is not there
    await keyless(async () => {
      const root = vault(RETIRED);
      await land({ root, content: mail("Photos from the lake") });
      expect(readSourceInsertionLog(root)).toHaveLength(1);
    });
    // a key: Jev screens it, not the block's url, and at the firewall's own threshold
    const root = vault(RETIRED);
    seen.length = 0;
    await land({ root, content: mail("Photos from the lake") });
    expect(seen).toHaveLength(1);
    await expect(land({ root, content: mail("RESET-TOKEN") })).rejects.toMatchObject({ code: "withheld" });
  });

  test("a malformed security.firewall is an error, never a silent off", async () => {
    const root = vault("integrations: {}\nsecurity:\n  firewall: maybe\n");
    await expect(land({ root, content: mail("Photos from the lake") })).rejects.toThrow("security.firewall");
    expect(readSourceInsertionLog(root)).toHaveLength(0);
  });
});

describe("the firewall at the door", () => {
  test("an ordinary item passes, and the model read it", async () => {
    const root = vault();
    seen.length = 0;
    const r = await land({ root, content: mail("Photos from the lake") });
    expect(r.deduped).toBe(false);
    expect(seen.join()).toContain("Photos from the lake");
    expect(await hold(...item(root, mail("A newsletter")))).toBe(true);
    expect(stagedCount(root)).toBe(1);
  });

  test("a reset email is withheld: not landed, not staged, one metadata line without the subject", async () => {
    const root = vault();
    await expect(land({ root, content: mail("https://quillpad.example/reset?t=RESET-TOKEN") })).rejects.toMatchObject({
      code: "withheld",
    });
    expect(await hold(...item(root, mail("https://quillpad.example/reset?t=RESET-TOKEN")))).toBe(false);
    expect(readSourceInsertionLog(root)).toHaveLength(0);
    expect(stagedCount(root)).toBe(0);
    const lines = readFileSync(withheldLog(root), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ source: "email", reason: "credential", from: "Quillpad <no-reply@quillpad.example>" });
    expect(JSON.stringify(lines)).not.toContain("482910");
    expect(JSON.stringify(lines)).not.toContain("RESET-TOKEN");
  });

  test("a forwarded message in a text attachment is screened too", async () => {
    const root = vault();
    const eml = { name: "fwd.eml", b64: Buffer.from("Subject: reset\n\nRESET-TOKEN").toString("base64") };
    await expect(land({ root, content: mail("see attached"), attachments: [eml] })).rejects.toMatchObject({ code: "withheld" });
  });

  test("a long item is read in windows, so a secret at the tail is not cut off", async () => {
    const root = vault();
    seen.length = 0;
    const long = mail("filler ".repeat(10_000) + "RESET-TOKEN");
    expect(windows(long).length).toBeGreaterThan(1);
    await expect(land({ root, content: long })).rejects.toMatchObject({ code: "withheld" });
    expect(seen.length).toBe(windows(long).length);
  });

  test("fails closed: an unreachable or nonsensical firewall lets nothing through", async () => {
    const down = vault();
    process.env["BIGBRAIN_FIREWALL_URL"] = "http://127.0.0.1:9/v1/systemone";
    try {
      await expect(land({ root: down, content: mail("Photos from the lake") })).rejects.toBeInstanceOf(FirewallUnavailable);
      await expect(hold(...item(down, mail("A newsletter")))).rejects.toBeInstanceOf(FirewallUnavailable);
    } finally {
      process.env["BIGBRAIN_FIREWALL_URL"] = `http://127.0.0.1:${server.port}/v1/systemone`;
    }
    expect(readSourceInsertionLog(down)).toHaveLength(0);
    expect(stagedCount(down)).toBe(0);
    expect(existsSync(withheldLog(down))).toBe(false);

    const root = vault();
    mode = "broken";
    try {
      await expect(land({ root, content: mail("Photos from the lake") })).rejects.toBeInstanceOf(FirewallUnavailable);
    } finally {
      mode = "ok";
    }
    expect(readSourceInsertionLog(root)).toHaveLength(0);
  });

  test("admission lands what the door staged without asking again", () => {
    const root = vault();
    seen.length = 0;
    expect(admit({ root, content: mail("already screened when staged") }).deduped).toBe(false);
    expect(seen).toEqual([]);
  });
});
