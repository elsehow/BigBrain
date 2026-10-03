import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { admit, FirewallUnavailable, hold, land } from "../lib/door";
import { windows, withheldLog } from "../lib/firewall";
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

// A fake Jev/SystemOne endpoint: words in the state decide the answer.
const seen: string[] = [];
let mode: "ok" | "broken" = "ok";
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { model: string; state: string; questions: Record<string, unknown> };
    seen.push(body.state);
    if (mode === "broken") return Response.json({ answers: {} });
    const p = (hit: boolean) => ({ type: "noul", noul: hit ? 0.97 : 0.02 });
    return Response.json({
      model: body.model,
      answers: { credential: p(/RESET-TOKEN/.test(body.state)) },
    });
  },
});
afterAll(() => server.stop(true));

const vault = (url = `http://127.0.0.1:${server.port}/v1/systemone`, extra = ""): string =>
  mdVault({ prefix: "bb-door-", files: { "vault.yaml": `firewall:\n  url: ${url}\n${extra}` } });
const item = (root: string, content: string, id = "email-1"): [string, StagedItem] => [
  root,
  { id, source: "email", at: "2026-10-01T09:00:00Z", line: "a head", scopes: {}, name: `${id}.md`, content },
];
const mail = (body: string) =>
  `---\nid: m-1\nfrom: Quillpad <no-reply@quillpad.example>\ndate: 2026-10-01T09:00:00Z\ntitle: Subject with 482910\n---\n${body}\n`;

describe("the firewall at the door", () => {
  test("no firewall block: the door lands and stages as it always did", async () => {
    const root = mdVault({ prefix: "bb-door-off-", files: { "vault.yaml": "integrations: {}\n" } });
    await land({ root, content: mail("RESET-TOKEN") });
    expect(readSourceInsertionLog(root)).toHaveLength(1);
  });

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
    const down = vault("http://127.0.0.1:9/v1/systemone");
    await expect(land({ root: down, content: mail("Photos from the lake") })).rejects.toBeInstanceOf(FirewallUnavailable);
    await expect(hold(...item(down, mail("A newsletter")))).rejects.toBeInstanceOf(FirewallUnavailable);
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

  test("a malformed firewall block is an error, never a silent off", async () => {
    const root = mdVault({ prefix: "bb-door-bad-", files: { "vault.yaml": "firewall:\n  url: http://127.0.0.1:9/v1/systemone\n  thresholds:\n    credential: 2\n" } });
    await expect(land({ root, content: mail("Photos from the lake") })).rejects.toThrow("firewall");
    expect(readSourceInsertionLog(root)).toHaveLength(0);
  });

  test("a retired malicious threshold in vault.yaml is ignored, not an error that stops intake", async () => {
    const root = vault(undefined, "  thresholds:\n    malicious: 0.99\n");
    await land({ root, content: mail("Photos from the lake") });
    expect(readSourceInsertionLog(root)).toHaveLength(1);
  });

  test("admission lands what the door staged without asking again", () => {
    const root = vault("http://127.0.0.1:9/v1/systemone");
    expect(admit({ root, content: mail("already screened when staged") }).deduped).toBe(false);
  });
});
