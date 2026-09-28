import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readBlob } from "../lib/blobs";
import { ensureItemId, receive, stampIntake } from "../lib/intake";
import { landReference, listReferenceItems, listReferencePaths } from "../lib/references";
import { appendSourceInsertion, readSourceInsertionLog, type SourceInsertion } from "../lib/insertionLog";
import { gitVault } from "./support/vault";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

const vault = (git = false) =>
  gitVault({ prefix: "bb-refs-", dirs: ["inbox"], commit: false, git });

/** Every landed item, from the insertion log — the record's observable
 * since #496 (references/*.md is no longer written). */
const landedEvents = (root: string): SourceInsertion[] => readSourceInsertionLog(root);
const landedEnvs = (root: string): Record<string, unknown>[] =>
  landedEvents(root).map((e) => e.envelope);

describe("landing an immutable insertion", () => {
  const content =
    "---\nid: email-abc123\ntitle: hi\nreceived: 2026-08-02T10:00:00.000Z\n---\n\nbody text\n";

  test("an item lands one insertion event with sha256 + received stamped — no markdown", () => {
    const root = vault();
    const { path } = receive({ root, content });

    expect(path).toMatch(/^log\/insertions\//);
    expect(existsSync(join(root, path))).toBe(true);

    const events = landedEvents(root);
    expect(events).toHaveLength(1);
    const env = events[0]!.envelope;
    expect(env["id"]).toBe("email-abc123");
    expect(env["title"]).toBe("hi");
    expect(env["received"]).toBe("2026-08-02T10:00:00.000Z"); // the front door's stamp wins
    expect(env["sha256"]).toBe(sha(content)); // identity = hash of the item text as delivered
    expect(events[0]!.body).toBe("body text\n");
    // #496: the compatibility projection is gone — nothing writes references/
    expect(existsSync(join(root, "references"))).toBe(false);
  });

  test("an id is generated (HTTP shape) when the item has none", () => {
    const root = vault();
    receive({ root, content: "just a thought" });
    const envs = landedEnvs(root);
    expect(envs).toHaveLength(1);
    expect(String(envs[0]!["id"])).toMatch(/^api-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z0-9]{6}$/);
    expect(landedEvents(root)[0]!.body).toBe("just a thought");
  });
});

describe("exact-dupe short-circuit", () => {
  const content =
    "---\nid: dupe-1\ntitle: same\nreceived: 2026-08-02T10:00:00.000Z\n---\n\nsame body\n";

  test("same sha256 twice → one insertion (#136)", () => {
    const root = vault();
    receive({ root, content });
    receive({ root, content });
    expect(landedEvents(root)).toHaveLength(1);
  });

  test("dedup returns the existing landing's identity — the insertion event path", () => {
    const root = vault();
    const first = landReference(root, content);
    expect(first.path).toMatch(/^log\/insertions\/2026-08\/ins_[a-f0-9]{24}\.json$/);
    const again = landReference(root, content);
    expect(again.deduped).toBe(true);
    expect(again.path).toBe(first.path);
    expect(again.id).toBe("dupe-1");
    expect(again.sha256).toBe(first.sha256);
    expect(again.insertionId).toBe(first.insertionId);
  });

  test("stamped redeliveries dedupe: identity is the PRE-stamp payload (the HTTP door)", () => {
    const root = vault();
    const payload = "---\ntitle: same thought\n---\n\nsame body\n";
    // two deliveries of the same client payload, stamped seconds apart —
    // fresh `received` + generated ids make the STAMPED text differ
    for (const t of ["2026-08-02T10:00:00.000Z", "2026-08-02T10:00:07.000Z"]) {
      const stamped = stampIntake(payload, {
        tokenId: "tok1",
        tokenName: "phone",
        now: new Date(t),
      });
      receive({ root, content: stamped, raw: payload });
    }
    expect(landedEvents(root)).toHaveLength(1); // one insertion, not two sharing an id
  });

  test("cross-writer dedup: an item landed by ANOTHER process is seen — the projection syncs", () => {
    const root = vault();
    const foreignSha = sha("foreign payload");
    // another process's landing: an insertion event on disk, no shared memory
    appendSourceInsertion(
      root,
      { id: "foreign-1", sha256: foreignSha, received: "2026-08-01T00:00:00.000Z" },
      "foreign payload\n"
    );
    const again = landReference(root, "foreign payload\n", { sha256: foreignSha });
    expect(again.deduped).toBe(true);
    expect(again.id).toBe("foreign-1");
    expect(landedEvents(root)).toHaveLength(1);
  });
});

describe("#498: a landing mints no queue message", () => {
  test("a drop yields an insertion and nothing under queue/", () => {
    const root = vault();
    receive({
      root,
      content:
        "---\nid: q-1\ntype: reference\nfrom: granola\nsource: granola\nreceived: 2026-08-02T10:00:00.000Z\n---\nbody\n",
    });
    expect(landedEnvs(root).map((e) => e["id"])).toEqual(["q-1"]);
    expect(existsSync(join(root, "queue"))).toBe(false);
  });
});

describe("attachments in the insertion envelope", () => {
  test("blob lands in the CAS; envelope carries {name, sha256, bytes, mime} refs", () => {
    const root = vault();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    receive({
      root,
      content: "---\nid: pic-1\nreceived: 2026-08-02T10:00:00.000Z\n---\npic",
      attachments: [{ name: "photo.png", b64: png.toString("base64") }],
    });
    expect(readBlob(root, sha(png))).toEqual(png);
    const [event] = landedEvents(root);
    expect(event!.envelope["attachments"]).toEqual([
      { name: "photo.png", sha256: sha(png), bytes: 4, mime: "image/png" },
    ]);
    expect(event!.body).toContain(`![photo.png](blob:${sha(png)})`);
    expect(existsSync(join(root, "inbox", "attachments"))).toBe(false);
  });
});

describe("the intake commit", () => {
  test("landing is committed as author intake, naming the item; inbox stays uncommitted", () => {
    const root = vault(true);
    receive({
      root,
      content: "---\nid: c-1\ntitle: commit me\nreceived: 2026-08-02T10:00:00.000Z\n---\nx",
    });
    const log = spawnSync("git", ["log", "--author=intake", "--name-only", "--pretty=%an %s"], {
      cwd: root,
      encoding: "utf8",
    }).stdout;
    expect(log).toContain("intake intake: c-1 — commit me");
    expect(log).toContain("log/insertions/2026-08/");
    expect(log).not.toContain("references/"); // #496: nothing written there
    expect(log).not.toContain("inbox/");
    // inbox copy exists but was never staged
    const staged = spawnSync("git", ["ls-files", "inbox"], {
      cwd: root,
      encoding: "utf8",
    }).stdout.trim();
    expect(staged).toBe("");
  });


  test("the intake commit never sweeps another writer's staged work (the editor race)", () => {
    const root = vault(true);
    // the editor mid-run: record work staged, commitRun not yet reached
    mkdirSync(join(root, "entities"), { recursive: true });
    writeFileSync(join(root, "entities", "filed.md"), "---\nid: filed-1\n---\nfiled\n");
    spawnSync("git", ["add", "--", "entities"], { cwd: root, encoding: "utf8" });

    receive({
      root,
      content: "---\nid: race-1\nreceived: 2026-08-02T10:00:00.000Z\n---\nx",
    });

    // the intake commit carries ONLY the insertion log — no staged record work
    const shown = spawnSync("git", ["show", "--name-only", "--pretty=%an", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).stdout;
    expect(shown).toContain("intake");
    expect(shown).toContain("log/insertions/2026-08/");
    expect(shown).not.toContain("entities/");
    // and the editor's staged addition survives, still staged (detectMoves reads this)
    const staged = spawnSync("git", ["diff", "--cached", "--name-status"], {
      cwd: root,
      encoding: "utf8",
    }).stdout;
    expect(staged).toContain("A\tentities/filed.md");
  });

  // #216's guarantee, one era on: the frozen references/ tree is not in the
  // landing pathspec at all, so a foreign edit there can never ride an
  // intake-authored commit — it sits uncommitted where a human (or the
  // tripwire) can see it.
  test("a foreign edit to a FROZEN reference does NOT ride a landing commit (#216, #496)", () => {
    const root = vault(true);
    mkdirSync(join(root, "references"), { recursive: true });
    const victim = join(root, "references", "2026-08-02-victim.md");
    writeFileSync(victim, "---\nid: victim-1\n---\noriginal text\n");
    spawnSync("git", ["add", "--", "references"], { cwd: root, encoding: "utf8" });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=seed", "commit", "-q", "-m", "frozen history"], {
      cwd: root,
      encoding: "utf8",
    });
    writeFileSync(victim, `${readFileSync(victim, "utf8")}\nTAMPERED\n`);

    receive({
      root,
      content: "---\nid: later-1\ntitle: later\nreceived: 2026-08-02T11:00:00.000Z\n---\nunrelated\n",
    });

    const laundered = spawnSync("git", ["log", "-S", "TAMPERED", "--oneline"], {
      cwd: root,
      encoding: "utf8",
    }).stdout.trim();
    expect(laundered).toBe(""); // never committed, by anyone
    const status = spawnSync("git", ["status", "--porcelain", "--", "references"], {
      cwd: root,
      encoding: "utf8",
    }).stdout;
    expect(status).toContain(" M references/2026-08-02-victim.md");
    expect(
      spawnSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf8" }).stdout
    ).toContain("intake: later-1");
  });

  // commitLanding is fail-soft, so a landing whose commit failed leaves an
  // uncommitted insertion event on disk, and "the next landing commit
  // sweeps it" is a documented promise.
  test("an orphan left by an earlier failed commit is still swept up", () => {
    const root = vault(true);
    mkdirSync(join(root, "log", "insertions", "2026-08"), { recursive: true });
    writeFileSync(
      join(root, "log", "insertions", "2026-08", "ins_orphan.json"),
      '{"event":"source.inserted","id":"ins_orphan","source_id":"orphan-1"}\n'
    );

    receive({
      root,
      content: "---\nid: sweeper-1\ntitle: sweeper\nreceived: 2026-08-02T10:00:00.000Z\n---\nx",
    });

    const shown = spawnSync("git", ["show", "--name-only", "--pretty=%an", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).stdout;
    expect(shown).toContain("log/insertions/2026-08/ins_orphan.json"); // the orphan rode along
    expect(shown).toContain("log/insertions/2026-08/ins_");
  });

  test("a root with no git repo still lands (commit is fail-soft, event kept)", () => {
    const root = vault(false);
    const r = receive({ root, content: "---\nid: ng-1\n---\nx" });
    expect(r.path).toBeDefined();
    expect(existsSync(join(root, r.path!))).toBe(true);
    expect(landedEvents(root)).toHaveLength(1);
  });
});

describe("landing immutability", () => {
  test("a landed event never changes: no filing stamps, dedup leaves it byte-identical", () => {
    const root = vault();
    const content = "---\nid: imm-1\nreceived: 2026-08-02T10:00:00.000Z\n---\nfixed\n";
    receive({ root, content });
    const [event] = landedEvents(root);
    const abs = join(root, "log", "insertions", "2026-08", `${event!.id}.json`);
    const first = readFileSync(abs, "utf8");
    expect(first).not.toMatch(/"(filed|triage_run)"/); // the stamps die on this plane
    receive({ root, content });
    expect(readFileSync(abs, "utf8")).toBe(first);
  });
});

describe("listReferencePaths / listReferenceItems — the frozen record's direct reads", () => {
  // #496: intake no longer grows this tree; these readers serve the frozen
  // markdown history a pre-native vault carries. Fixtures write the files
  // directly, the way history left them.
  const frozen = (root: string): void => {
    mkdirSync(join(root, "references"), { recursive: true });
    writeFileSync(
      join(root, "references", "2026-07-01-a-1.md"),
      "---\nid: a-1\nreceived: 2026-07-01T10:00:00.000Z\n---\nx\n"
    );
    writeFileSync(
      join(root, "references", "2026-08-02-hi.md"),
      "---\nid: it-1\ntitle: hi\nreceived: 2026-08-02T10:00:00.000Z\n---\nbody\n"
    );
  };

  test("listReferencePaths returns every frozen reference as a sorted vault-relative path", () => {
    const root = vault();
    frozen(root);
    expect(listReferencePaths(root)).toEqual([
      "references/2026-07-01-a-1.md",
      "references/2026-08-02-hi.md",
    ]);
  });

  test("listReferenceItems parses each item's envelope and stats its mtime", () => {
    const root = vault();
    frozen(root);
    const items = listReferenceItems(root);
    expect(items).toHaveLength(2);
    const hi = items.find((i) => i.path === "references/2026-08-02-hi.md")!;
    expect(hi.envelope.id).toBe("it-1");
    expect(hi.envelope.title).toBe("hi");
    expect(hi.mtimeMs).toBeGreaterThan(0);
  });

  test("no references/ yet → both return empty, not throw", () => {
    const root = vault();
    expect(listReferencePaths(root)).toEqual([]);
    expect(listReferenceItems(root)).toEqual([]);
  });
});

describe("ensureItemId (the ssh path's stamp)", () => {
  test("stamps an ssh-prefixed id, HTTP id shape, when none present", () => {
    const out = ensureItemId("just text", new Date("2026-08-02T10:00:00.000Z"));
    expect(out).toMatch(/^---\nid: ssh-2026-08-02T10-00-00-[a-z0-9]{6}\n---\n\njust text$/);
  });

  test("keeps frontmatter and adds only the id", () => {
    const out = ensureItemId("---\ntitle: hi\n---\nbody");
    expect(out).toContain("title: hi");
    expect(out).toMatch(/\nid: ssh-/);
  });

  test("an existing id passes through byte-identical", () => {
    const content = "---\nid: granola-8f42\ntitle: hi\n---\nbody";
    expect(ensureItemId(content)).toBe(content);
  });
});

describe("substrate type stamping at landing (drop-zone cut 3)", () => {
  test("a bare drop lands as type: reference — the only arrival type, never a guess", () => {
    const root = vault();
    receive({ root, content: "just a thought" });
    const [env] = landedEnvs(root);
    expect(env!["type"]).toBe("reference");
    expect(env!["category"]).toBe("drop"); // nothing declared — the bare-drop word, editor-reassignable
  });

  test("flavor words normalize to strong types at landing, surviving as tags", () => {
    const root = vault();
    receive({
      root,
      content: "---\nid: g-1\ntype: transcript\n---\nwords",
    });
    receive({
      root,
      content: "---\nid: g-2\nkind: meeting\n---\nwords again",
    });
    const byId = new Map(landedEnvs(root).map((env) => [String(env["id"]), env] as const));
    expect(byId.get("g-1")?.["type"]).toBe("reference");
    expect(byId.get("g-1")?.["tags"]).toEqual(["transcript"]);
    expect(byId.get("g-1")?.["category"]).toBe("transcript"); // the ONE category — the door's flavor word
    expect(byId.get("g-2")?.["type"]).toBe("reference");
    expect(byId.get("g-2")?.["tags"]).toEqual(["meeting"]);
    expect(byId.get("g-2")?.["category"]).toBe("meeting");
    expect(byId.get("g-2")?.["kind"]).toBe("meeting"); // legacy field untouched — record, not rewrite
  });

  test("an unknown declared word never becomes a type: reference + the word as a tag", () => {
    const root = vault();
    receive({
      root,
      content: "---\nid: v-1\ntype: voicemail\n---\nbeep",
    });
    const [env] = landedEnvs(root);
    expect(env!["type"]).toBe("reference");
    expect(env!["tags"]).toEqual(["voicemail"]);
  });
});
