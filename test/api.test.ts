import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApiHandler, MAX_REQUEST_BYTES, ROUTES } from "../lib/api";
import { listTokens, mintToken, revokeToken } from "../lib/auth";
import { readBlob } from "../lib/blobs";
import { sweep } from "../lib/door";
import { saveJevKey } from "../lib/jevSettings";
import { MAX_BYTES } from "../lib/intake";
import { labels, ledgerRel, readLedger } from "../lib/retrieval";
import { appendSourceInsertionEvent, insertionEventRel, readSourceInsertionLog, type SourceInsertion } from "../lib/insertionLog";
import { appendAssertionEvent, assertionEntityId, createAssertionEvent } from "../lib/assertionLog";
import { landedTextById } from "./support/landed";
import { insertion, NATIVE_YAML } from "./support/vault";

function setup(
  scopes: string[] = ["inbox:write"],
  identity?: { owner?: string; kind?: "person-device" | "agent" }
) {
  const root = mkdtempSync(join(tmpdir(), "bb-api-vault-"));
  mkdirSync(join(root, "inbox"), { recursive: true });
  const storePath = join(mkdtempSync(join(tmpdir(), "bb-api-store-")), "tokens.json");
  const minted = mintToken(storePath, root, "test token", scopes, identity);
  const handler = makeApiHandler({ root, storePath, log: () => {} });
  return { root, storePath, handler, ...minted };
}

const drop = (body: string, token?: string, qs = "poke=false") =>
  new Request(`http://api.test/v1/drop?${qs}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body,
  });

describe("auth", () => {
  test("no header → 401 with WWW-Authenticate", async () => {
    const { handler } = setup();
    const res = await handler(drop("x"));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  // #639: `last_used` is stamped ONCE, at dispatch, after auth and the
  // scope gate. It used to be a hand-written `touch()` inside ten
  // handlers, placed differently in each — first statement in one, after
  // the 404 in the next — so the field meant "was dispatched" on some
  // routes and "did some work" on others.
  test("last_used is stamped at dispatch, and a refused request still counts", async () => {
    const { handler, token, record, storePath } = setup(["vault:read"]);
    expect(listTokens(storePath).find((t) => t.id === record.id)!.last_used).toBeNull();
    // A refusal from inside the handler: the credential worked, the
    // request did not — and that is still a use. (Before, `touch()` sat
    // AFTER this early return in noteHandler, so it was not.)
    const miss = await handler(
      new Request("http://api.test/v1/note?path=nope.md", { headers: { Authorization: `Bearer ${token}` } })
    );
    expect(miss.status).toBe(403);
    expect(listTokens(storePath).find((t) => t.id === record.id)!.last_used).not.toBeNull();
  });

  // The one exception, and it is now in the table (`touch: false`) rather
  // than in the absence of a line. whoami is the validity PROBE —
  // `bigbrain connect` calls it the instant a token is minted — so
  // counting it would make a credential that has never done anything read
  // as used on the agents card.
  test("whoami is a probe, not a use: it does not stamp last_used", async () => {
    const { handler, token, record, storePath } = setup(["vault:read"]);
    const who = await handler(
      new Request("http://api.test/v1/whoami", { headers: { Authorization: `Bearer ${token}` } })
    );
    expect(who.status).toBe(200);
    expect(listTokens(storePath).find((t) => t.id === record.id)!.last_used).toBeNull();
  });

  test("garbage token → 401", async () => {
    const { handler } = setup();
    expect((await handler(drop("x", "bb_00000000_nope"))).status).toBe(401);
    expect((await handler(drop("x", "not-even-a-token"))).status).toBe(401);
  });

  test("revoked token → 401 immediately", async () => {
    const { handler, token, record, storePath } = setup();
    expect((await handler(drop("x", token))).status).toBe(200);
    revokeToken(storePath, record.id);
    expect((await handler(drop("x", token))).status).toBe(401);
  });

  test("empty store fails closed → 401", async () => {
    const { handler, token, storePath } = setup();
    writeFileSync(storePath, JSON.stringify({ version: 1, vault: "/v", tokens: [] }));
    expect((await handler(drop("x", token))).status).toBe(401);
  });

  test("wrong scope → 403 naming the scope", async () => {
    const { handler, token } = setup(["vault:read"]); // read-only token, asked to write
    const res = await handler(drop("x", token, "poke=false"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("inbox:write");
  });
});

describe("drop", () => {
  test("happy path lands a stamped file", async () => {
    const { handler, token, record, root } = setup();
    const res = await handler(
      drop("---\ntitle: hi\nsource: forged\n---\nbody", token, "name=clip.md&poke=false")
    );
    expect(res.status).toBe(200);
    const { path, id } = (await res.json()) as { path: string; id: string };
    expect(path).toBe("inbox/clip.md"); // the slot name; the landing is the event
    const onDisk = landedTextById(root, id);
    expect(onDisk).toContain("source: api");
    expect(onDisk).toContain(`submitted_by: ${record.id}`);
    expect(onDisk).toContain("submitted_via:");
    expect(onDisk).toContain("received:");
    expect(onDisk).not.toContain("forged");
    expect(onDisk).toContain("title: hi");
    expect(onDisk.trim().endsWith("body")).toBe(true);
  });

  test("JSON body with attachments lands both, stamped", async () => {
    const { handler, token, root } = setup();
    const res = await handler(
      new Request("http://api.test/v1/drop?name=shot.md&poke=false", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          content: "---\ntitle: shot\n---\n",
          attachments: [{ name: "shot.jpg", b64: Buffer.from("jpegbytes").toString("base64") }],
        }),
      })
    );
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const onDisk = landedTextById(root, id);
    expect(onDisk).toContain("source: api"); // still stamped in JSON mode
    const sha = createHash("sha256").update("jpegbytes").digest("hex");
    expect(onDisk).toContain(`![shot.jpg](blob:${sha})`); // CAS ref, lib/envelope.ts's contract
    expect(readBlob(root, sha)?.toString()).toBe("jpegbytes");
  });

  test("owned person-device token stamps its owner as from", async () => {
    const { handler, token, root } = setup(["inbox:write"], {
      owner: "nick@example.com",
      kind: "person-device",
    });
    const res = await handler(drop("body", token, "name=n.md&poke=false"));
    const { id } = (await res.json()) as { id: string };
    const onDisk = landedTextById(root, id);
    expect(onDisk).toContain("from: nick@example.com");
    expect(onDisk).toContain("from_kind: person");
  });

  test("agent token stamps its NAME as from", async () => {
    const { handler, token, root } = setup(["inbox:write"], {
      owner: "nick@example.com",
      kind: "agent",
    });
    const res = await handler(drop("body", token, "name=n.md&poke=false"));
    const { id } = (await res.json()) as { id: string };
    const onDisk = landedTextById(root, id);
    expect(onDisk).toContain("from: test token");
    expect(onDisk).toContain("from_kind: agent");
  });

  test("legacy token (no identity) stamps no principal", async () => {
    const { handler, token, root } = setup();
    const res = await handler(drop("body", token, "name=n.md&poke=false"));
    const { id } = (await res.json()) as { id: string };
    const onDisk = landedTextById(root, id);
    expect(onDisk).not.toMatch(/^from:/m);
    expect(onDisk).not.toMatch(/^from_kind:/m);
  });

  test("payload may claim agent identity through a person token, never person", async () => {
    const { handler, token, root } = setup(["inbox:write"], {
      owner: "nick@example.com",
      kind: "person-device",
    });
    const agent = await handler(
      drop("---\nfrom: claude-opus\nfrom_kind: agent\n---\nbody", token, "name=a.md&poke=false")
    );
    const agentDisk = landedTextById(root, ((await agent.json()) as { id: string }).id);
    expect(agentDisk).toContain("from: claude-opus");
    expect(agentDisk).toContain("from_kind: agent");
    const forged = await handler(
      drop(
        "---\nfrom: someone-else@example.com\nfrom_kind: person\n---\nbody",
        token,
        "name=f.md&poke=false"
      )
    );
    const forgedDisk = landedTextById(root, ((await forged.json()) as { id: string }).id);
    expect(forgedDisk).not.toContain("someone-else");
    expect(forgedDisk).toContain("from: nick@example.com"); // the credential wins
    expect(forgedDisk).toContain("from_kind: person");
  });

  test("empty body → 400", async () => {
    const { handler, token } = setup();
    expect((await handler(drop("  \n", token))).status).toBe(400);
  });

  test("oversize body → 413", async () => {
    const { handler, token } = setup();
    expect((await handler(drop("x".repeat(MAX_BYTES + 1), token))).status).toBe(413);
  });

  test("rate limit → 429 with Retry-After, refills with time", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-api-vault-"));
    mkdirSync(join(root, "inbox"), { recursive: true });
    const storePath = join(mkdtempSync(join(tmpdir(), "bb-api-store-")), "tokens.json");
    const { token } = mintToken(storePath, root, "burst", ["inbox:write"]);
    let t = Date.parse("2026-07-13T10:00:00Z");
    const handler = makeApiHandler({ root, storePath, log: () => {}, now: () => new Date(t) });

    for (let i = 0; i < 30; i++) expect((await handler(drop("x", token))).status).toBe(200);
    const limited = await handler(drop("x", token));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);

    t += 10_000; // 10s refills ~5 tokens
    expect((await handler(drop("x", token))).status).toBe(200);
  });
});

describe("surface", () => {
  test("whoami returns id/name/identity/scopes", async () => {
    const { handler, token, record } = setup(["inbox:write"]);
    const res = await handler(
      new Request("http://api.test/v1/whoami", { headers: { Authorization: `Bearer ${token}` } })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: record.id,
      name: "test token",
      owner: null,
      kind: null,
      scopes: ["inbox:write"],
    });
  });

  test("OPTIONS preflight carries CORS headers", async () => {
    const { handler } = setup();
    const res = await handler(new Request("http://api.test/v1/drop", { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  test("unknown routes → 404, including outside /v1", async () => {
    const { handler } = setup();
    expect((await handler(new Request("http://api.test/"))).status).toBe(404);
    expect((await handler(new Request("http://api.test/v1/nope"))).status).toBe(404);
    expect(
      (await handler(new Request("http://api.test/api/config", { method: "POST", body: "{}" })))
        .status
    ).toBe(404);
  });
});

// ── Item B: read-back routes + the whole-request body cap (§5) ───────────────
describe("read-back routes (§5): status under vault:read", () => {
  const authGet = (p: string, token?: string) =>
    new Request(`http://api.test${p}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  describe("GET /v1/status", () => {
    test("empty vault → zero due, null last_run", async () => {
      const { handler, token } = setup(["vault:read"]);
      const res = await handler(authGet("/v1/status", token));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        due: { intake: 0 },
        last_run: null,
      });
    });

    test("reports the NEWEST queue journal as last_run", async () => {
      const { handler, token, root } = setup(["vault:read"]);
      mkdirSync(join(root, "journal", "queue"), { recursive: true });
      writeFileSync(
        join(root, "journal", "queue", "2026-08-08T10-00-00-aaaa.json"),
        JSON.stringify({
          run: "old",
          model: "m",
          outcomes: ["x absorbed"],
          startedAt: "t0",
          wallMs: 1,
        })
      );
      writeFileSync(
        join(root, "journal", "queue", "2026-08-08T11-00-00-bbbb.json"),
        JSON.stringify({
          run: "new",
          model: "claude-opus-5",
          outcomes: ["y absorbed"],
          startedAt: "t1",
          wallMs: 2,
        })
      );
      const body = (await (await handler(authGet("/v1/status", token))).json()) as {
        last_run: { run: string; model: string; outcomes: string[] };
      };
      expect(body.last_run.run).toBe("new");
      expect(body.last_run.model).toBe("claude-opus-5");
      expect(body.last_run.outcomes).toEqual(["y absorbed"]);
    });

    test("a NEWER stage pre-pass record is not a run — last_run stays the newest execution (#308)", async () => {
      const { handler, token, root } = setup(["vault:read"]);
      mkdirSync(join(root, "journal", "queue"), { recursive: true });
      writeFileSync(
        join(root, "journal", "queue", "2026-08-08T10-00-00-aaaa.json"),
        JSON.stringify({ run: "exec", model: "claude-opus-5", startedAt: "t0", wallMs: 1 })
      );
      writeFileSync(
        join(root, "journal", "queue", "2026-08-08T11-00-00-bbbb.json"),
        JSON.stringify({
          run: "stg",
          stage: "resolve",
          shadow: true,
          model: "claude-haiku-4-5",
          startedAt: "t1",
          wallMs: 2,
        })
      );
      const body = (await (await handler(authGet("/v1/status", token))).json()) as {
        last_run: { run: string };
      };
      expect(body.last_run.run).toBe("exec");
    });

    test("without vault:read → 403; without a token → 401", async () => {
      const { handler, token } = setup(["inbox:write"]);
      expect((await handler(authGet("/v1/status", token))).status).toBe(403);
      expect((await handler(authGet("/v1/status"))).status).toBe(401);
    });
  });
});

describe("the whole-request body cap (§5)", () => {
  test("a drop body over MAX_REQUEST_BYTES → 413", async () => {
    const { handler, token } = setup(["inbox:write"]);
    const res = await handler(drop("x".repeat(MAX_REQUEST_BYTES + 1), token));
    expect(res.status).toBe(413);
  });
});

// Issue #50: the HTTP front door reports the landed reference id, so a client
// can name it in a directive's refs. Additive — `path` is unchanged.
describe("POST /v1/drop while the firewall can't answer", () => {
  test("is accepted with a receipt (202), kept, and lands once it answers", async () => {
    const { handler, token, root } = setup();
    writeFileSync(join(root, "vault.yaml"), "integrations: {}\n");
    const store = join(mkdtempSync(join(tmpdir(), "bb-api-jev-")), "shared-connections.json");
    saveJevKey(store, "example-jev-key");
    const prior = { store: process.env["BIGBRAIN_SHARED_CONNECTIONS"], url: process.env["BIGBRAIN_FIREWALL_URL"] };
    process.env["BIGBRAIN_SHARED_CONNECTIONS"] = store;
    process.env["BIGBRAIN_FIREWALL_URL"] = "http://127.0.0.1:9/v1/systemone";
    try {
      const res = await handler(drop("---\ntitle: lake\n---\nPhotos from the lake", token, "name=lake.md&poke=false"));
      expect(res.status).toBe(202);
      const receipt = (await res.json()) as { queued: boolean; id: string };
      expect(receipt).toEqual({ queued: true, id: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(readSourceInsertionLog(root)).toHaveLength(0);
      saveJevKey(store, null); // no longer failing (here: switched off), the next sweep lands it
      expect(await sweep(root)).toEqual({ settled: 1, waiting: 0 });
      expect(readSourceInsertionLog(root)).toHaveLength(1);
    } finally {
      for (const [k, v] of [["BIGBRAIN_SHARED_CONNECTIONS", prior.store], ["BIGBRAIN_FIREWALL_URL", prior.url]] as const)
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
});

describe("POST /v1/drop — the landing receipt", () => {
  test("returns the reference id alongside the path", async () => {
    const { handler, token } = setup();
    const res = await handler(drop("---\nid: d-1\ntitle: A page\n---\nbody\n", token));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { path?: string; id?: string };
    expect(j.path).toBeTruthy();
    expect(j.id).toBe("d-1");
  });

  test("mints an id when the client sends none — the client never has to", async () => {
    // the extension deliberately mints no id (dedup is the payload sha),
    // so the id it needs for a directive can only come from here
    const { handler, token } = setup();
    const j = (await (await handler(drop("no frontmatter at all", token))).json()) as {
      id?: string;
    };
    expect(j.id).toMatch(/^api-\d{4}-\d{2}-\d{2}T/);
  });

  test("a re-drop of identical bytes returns the SAME id", async () => {
    const { handler, token } = setup();
    const body = "---\ntitle: Unchanged\n---\nsame bytes\n";
    const a = (await (await handler(drop(body, token))).json()) as { id?: string };
    const b = (await (await handler(drop(body, token))).json()) as { id?: string };
    expect(b.id).toBe(a.id);
  });

  // #334: the receipt names two files, and only one of them is fetchable.
  // A client that grounds a reader on `path` — the extension's DISCUSS chip
  // did, from #64 until now — hands out a link this same server refuses.
  // #496: ref_path is the immutable insertion event; references/*.md is no
  // longer written.
  test("ref_path names the insertion event, and THIS server can read it back", async () => {
    const { handler, token } = setup(["inbox:write", "vault:read"]);
    const note = (p: string) =>
      new Request(`http://api.test/v1/note?path=${encodeURIComponent(p)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

    const j = (await (
      await handler(drop("---\ntitle: A clipped page\n---\nbody\n", token))
    ).json()) as { path?: string; ref_path?: string };

    expect(j.ref_path).toMatch(/^log\/insertions\/\d{4}-\d{2}\/ins_[a-f0-9]{24}\.json$/);
    // Readable the instant the drop confirms — no triage pass in between.
    expect((await handler(note(j.ref_path!))).status).toBe(200);
    // And the desk copy is not, which is the whole bug: same receipt, same
    // moment, one path serving 200 and the other 403.
    expect(j.path).toMatch(/^inbox\//);
    expect((await handler(note(j.path!))).status).toBe(403);
  });

  test("a re-drop of identical bytes returns the reference already there", async () => {
    // The dedup branch writes no desk copy at all, so `path` names a slot on
    // no disk — all the more reason a re-clip's DISCUSS line takes ref_path.
    const { handler, token } = setup();
    const body = "---\ntitle: Unchanged\n---\nsame bytes\n";
    const a = (await (await handler(drop(body, token))).json()) as { ref_path?: string };
    const b = (await (await handler(drop(body, token))).json()) as { ref_path?: string };
    expect(a.ref_path).toBeTruthy();
    expect(b.ref_path).toBe(a.ref_path!);
  });
});

// Issue #105: the memory tree over HTTP — the plugin's SessionStart source.
// Its own jail, one tree wide: the note door cannot see memory/.
describe("GET /v1/memory (#105)", () => {
  const get = (path: string, token?: string) =>
    new Request(`http://api.test${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  const INDEX = "# Memory\n\n- [[memory/big-brain|BigBrain]] — load for engine work\n";
  const TOPIC = "---\ntitle: BigBrain\n---\nCites [[entities/bigbrain|the dossier]].\n";

  /** setup() writes no memory/ tree — the fixture is this route's whole world. */
  function memoryVault(scopes: string[] = ["vault:read"]) {
    const s = setup(scopes);
    mkdirSync(join(s.root, "memory"), { recursive: true });
    writeFileSync(join(s.root, "memory", "MEMORY.md"), INDEX);
    writeFileSync(join(s.root, "memory", "big-brain.md"), TOPIC);
    return s;
  }

  test("the index arm returns memory/MEMORY.md, byte-for-byte, as markdown", async () => {
    const { handler, token } = memoryVault();
    const res = await handler(get("/v1/memory", token));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.text()).toBe(INDEX); // raw: frontmatter kept, links unresolved
    // an empty ?path= is the same no-slug request, not a forbidden one
    expect(await (await handler(get("/v1/memory?path=", token))).text()).toBe(INDEX);
  });

  test("?path=<slug> returns that topic file's bytes", async () => {
    const { handler, token } = memoryVault();
    const res = await handler(get("/v1/memory?path=big-brain", token));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(TOPIC);
  });

  test("jail: traversal, an absolute path, and a NUL byte → 403", async () => {
    const { handler, token, root } = memoryVault();
    mkdirSync(join(root, "entities"), { recursive: true });
    writeFileSync(join(root, "entities", "alex-rowan.md"), "the dossier");
    for (const p of [
      "../entities/alex-rowan",
      "/etc/passwd",
      "big-brain\0",
      "../../etc/passwd",
    ]) {
      expect((await handler(get(`/v1/memory?path=${encodeURIComponent(p)}`, token))).status).toBe(
        403
      );
    }
  });

  test("a symlink under memory/ that escapes it → 403 (realpath re-check)", async () => {
    const { handler, token, root } = memoryVault();
    const secret = mkdtempSync(join(tmpdir(), "bb-secret-"));
    writeFileSync(join(secret, "passwd.md"), "root:x:0:0");
    symlinkSync(join(secret, "passwd.md"), join(root, "memory", "escape.md"));
    expect((await handler(get("/v1/memory?path=escape", token))).status).toBe(403);
  });

  test("an absent slug → 404, not 403 (existence stays distinct)", async () => {
    const { handler, token } = memoryVault();
    expect((await handler(get("/v1/memory?path=never-written", token))).status).toBe(404);
  });

  test("a vault with no memory tree → 404, never a 500", async () => {
    const { handler, token } = setup(["vault:read"]);
    expect((await handler(get("/v1/memory", token))).status).toBe(404);
  });

  test("needs vault:read: without the scope 403, without a token 401", async () => {
    const noScope = memoryVault(["inbox:write"]);
    const res = await noScope.handler(get("/v1/memory", noScope.token));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("vault:read");
    expect((await noScope.handler(get("/v1/memory"))).status).toBe(401);
    expect((await noScope.handler(get("/v1/memory?path=big-brain"))).status).toBe(401);
  });

  // This guarded READ_TREES by checking that /v1/ls and /v1/file could not
  // see memory/. Both routes were deleted in the dead-code pass (#648), so
  // the check now reads 404-because-no-route and proves nothing. The jail
  // itself is asserted directly two tests below, which is where it belongs.

  // The index this door serves advertises `[[memory/big-brain|BigBrain]]`,
  // and a reader that followed it into /v1/note was told the path was not a
  // readable vault path. Any path the system prints must be fetchable by the
  // note door — so it serves the memory tree through the SAME one-tree
  // jail, with READ_TREES itself untouched.
  test("/v1/note opens the memory paths the index advertises", async () => {
    const { handler, token } = memoryVault();
    const res = await handler(get("/v1/note?path=memory/big-brain.md", token));
    expect(res.status).toBe(200);
    const note = (await res.json()) as { path: string; title: string; markdown: string };
    expect(note.path).toBe("memory/big-brain.md");
    expect(note.title).toBe("BigBrain"); // frontmatter parsed, like any note here
    expect(note.markdown).toContain("Cites [[entities/bigbrain|the dossier]].");
    // the index itself, and the record link inside a topic file, both resolve
    const index = (await (
      await handler(get("/v1/note?path=memory/MEMORY.md", token))
    ).json()) as { links: { name: string; path: string | null }[] };
    expect(index.links).toEqual([{ name: "memory/big-brain", path: "memory/big-brain.md" }]);
  });

  test("/v1/note's memory arm is the memory jail, not a way around READ_TREES", async () => {
    const { handler, token, root } = memoryVault();
    mkdirSync(join(root, "prompts"), { recursive: true });
    writeFileSync(join(root, "prompts", "intake.md"), "# The intake prompt\n");
    for (const p of ["memory/../prompts/intake.md", "memory/", "memory/nested/../../.env"]) {
      const res = await handler(get(`/v1/note?path=${encodeURIComponent(p)}`, token));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain("forbidden path");
    }
    // an absent topic file is 404, not 403 — existence stays distinct
    expect((await handler(get("/v1/note?path=memory/never-written.md", token))).status).toBe(404);
  });
});

describe("the product shell's read route (#42): /v1/note", () => {
  const get = (path: string, token?: string) =>
    new Request(`http://api.test${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  /** A vault with three curated notes (controlled mtimes), one library
   * source, and one inbox straggler. */
  function vaultFixture() {
    const s = setup(["vault:read"]);
    const write = (rel: string, text: string, ageMinutes: number) => {
      const abs = join(s.root, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, text);
      const t = new Date(Date.now() - ageMinutes * 60_000);
      utimesSync(abs, t, t);
    };
    write("entities/bigbrain.md", "---\ntitle: BigBrain\n---\nThe product itself.\n", 30);
    write(
      "references/clip-one.md",
      "---\ntitle: A Clipped Page\ncategory: article\n---\n# Heading to skip\nProse about [[BigBrain]] and [[nowhere]].\n",
      10
    );
    write("entities/INDEX.md", "No frontmatter here, just *prose*.\n", 20);
    write("inbox/unsorted/stray.md", "stray\n", 1);
    return { ...s, write };
  }

  describe("GET /v1/note", () => {
    test("returns the parsed note with resolved links", async () => {
      const { handler, token } = vaultFixture();
      const res = await handler(get("/v1/note?path=references/clip-one.md", token));
      expect(res.status).toBe(200);
      const j = (await res.json()) as {
        title: string;
        markdown: string;
        links: { name: string; path: string | null }[];
      };
      expect(j.title).toBe("A Clipped Page");
      expect(j.markdown).not.toContain("category:");
      expect(j.markdown).toContain("[[BigBrain]]");
      expect(j.links[0]).toEqual({ name: "BigBrain", path: "entities/bigbrain.md" });
    });

    test("a root-relative link resolves — the form the vault mandates", async () => {
      // `[[entities/bigbrain|the product]]` is the REQUIRED link form (a target
      // that names its tree lets two notes share a basename). Resolving only
      // bare basenames left every correctly-written link answering null, which
      // is exactly the form the record is full of.
      const { handler, token, write } = vaultFixture();
      write(
        "references/qualified.md",
        "---\ntitle: Q\n---\nSee [[entities/bigbrain|the product]] and [[references/clip-one]].\n",
        5
      );
      const j = (await (
        await handler(get("/v1/note?path=references/qualified.md", token))
      ).json()) as {
        links: { name: string; path: string | null }[];
      };
      expect(j.links).toEqual([
        { name: "entities/bigbrain", path: "entities/bigbrain.md" },
        { name: "references/clip-one", path: "references/clip-one.md" },
      ]);
    });

    test("a bare link still resolves, and a qualified miss is still null", async () => {
      const { handler, token, write } = vaultFixture();
      write("references/mixed.md", "---\ntitle: M\n---\n[[BigBrain]] · [[entities/nowhere]]\n", 5);
      const j = (await (await handler(get("/v1/note?path=references/mixed.md", token))).json()) as {
        links: { name: string; path: string | null }[];
      };
      expect(j.links).toEqual([
        { name: "BigBrain", path: "entities/bigbrain.md" },
        { name: "entities/nowhere", path: null },
      ]);
    });

    test("an anchored link resolves — the target, not the #section, is what's looked up (#257)", async () => {
      // Before #257 the chip regex captured `page#section` whole as the
      // target, so idx.get() never found it and every anchored link's chip
      // came back null — the live bug this issue tracks.
      const { handler, token, write } = vaultFixture();
      write(
        "references/anchored.md",
        "---\ntitle: A\n---\nSee [[entities/bigbrain#Some Heading]] and [[BigBrain^block-id|the block]].\n",
        5
      );
      const j = (await (
        await handler(get("/v1/note?path=references/anchored.md", token))
      ).json()) as {
        links: { name: string; path: string | null }[];
      };
      expect(j.links).toEqual([
        { name: "entities/bigbrain", path: "entities/bigbrain.md" },
        { name: "BigBrain", path: "entities/bigbrain.md" },
      ]);
    });

    test("the read jail holds: traversal, dot-trees, non-md → 403; absent → 404", async () => {
      const { handler, token } = vaultFixture();
      expect((await handler(get("/v1/note?path=../secrets.md", token))).status).toBe(403);
      expect((await handler(get("/v1/note?path=.state/role", token))).status).toBe(403);
      expect((await handler(get("/v1/note?path=entities/x.txt", token))).status).toBe(403);
      expect((await handler(get("/v1/note?path=entities/absent.md", token))).status).toBe(404);
      expect((await handler(get("/v1/note?path=", token))).status).toBe(403);
    });

    test("a native source-search hit opens through the same note route", async () => {
      const { root, handler, token } = setup(["vault:read"]);
      const source = insertion({
        id: "ins_0123456789abcdef01234567",
        source_id: "source-1",
        author: { kind: "service", id: "test" },
        title: "GPU research meeting",
        body: "Ada reviewed the matrix kernel.",
        envelope: { category: "meeting", source: "granola" },
        received_at: "2026-08-18T12:00:00.000Z",
        content_sha256: "sha-source",
      });
      appendSourceInsertionEvent(root, source);
      const path = insertionEventRel(source);
      const res = await handler(get(`/v1/note?path=${encodeURIComponent(path)}`, token));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        path,
        title: source.title,
        category: "meeting",
        source: "granola",
        markdown: expect.stringContaining(source.body),
      });
      expect(readLedger(root)).toContainEqual(expect.objectContaining({ t: "use", path, via: "api" }));
    });

    test("a projected entity is windowed by q / after / n / order, and says what it left out", async () => {
      const { root, handler, token } = setup(["vault:read"]);
      const source = insertion({
        id: "ins_window0000000000000000a",
        source_id: "plan-session",
        author: { kind: "service", id: "test" },
        title: "Business plan session",
        body: "pricing and deploys",
        envelope: { category: "agent-chat" },
        received_at: "2026-08-23T12:00:00.000Z",
        content_sha256: "sha-window",
      });
      appendSourceInsertionEvent(root, source);
      const bb = { id: assertionEntityId("BigBrain"), label: "BigBrain" };
      const claim = (text: string, created_at: string): void => {
        appendAssertionEvent(root, createAssertionEvent({
          text: `[[${bb.id}|BigBrain]] ${text}`,
          entities: [bb],
          sources: [source.id],
          author: { kind: "model", id: "test", invocation_id: "run-1" },
          confidence: "direct",
          created_at,
          produced_by: { procedure: "test", version: "v1" },
        }, new Map([[source.id, source]])));
      };
      claim("deploys from one main branch.", "2026-08-12T10:00:00.000Z");
      claim("pricing was reopened.", "2026-08-13T10:00:00.000Z");
      claim("pricing must route tokens to the user.", "2026-08-23T10:00:00.000Z");
      const path = `projection/entities/${bb.id}.md`;
      const read = async (qs: string) => {
        const res = await handler(get(`/v1/note?path=${encodeURIComponent(path)}${qs}`, token));
        return {
          status: res.status,
          body: (await res.json()) as { markdown: string; assertions_total?: number; assertions_shown?: number; error?: string },
        };
      };
      const whole = await read("");
      expect(whole.status).toBe(200);
      expect(whole.body.assertions_total).toBe(3);
      expect(whole.body.assertions_shown).toBe(3);
      expect(whole.body.markdown.indexOf("deploys")).toBeLessThan(whole.body.markdown.indexOf("route tokens"));
      expect(whole.body.markdown).not.toContain("of 3 assertions");
      const q = await read("&q=pricing");
      expect(q.body.assertions_shown).toBe(2);
      expect(q.body.markdown).not.toContain("deploys");
      expect(q.body.markdown).toContain('2 of 3 assertions, matching "pricing"');
      const recent = await read("&after=2026-08-20");
      expect(recent.body.assertions_shown).toBe(1);
      expect(recent.body.markdown).toContain("route tokens");
      const newest = await read("&n=1&order=desc");
      expect(newest.body.assertions_shown).toBe(1);
      expect(newest.body.markdown).toContain("route tokens");
      expect(newest.body.markdown).toContain("newest first");
      const desc = await read("&order=desc");
      expect(desc.body.markdown.indexOf("route tokens")).toBeLessThan(desc.body.markdown.indexOf("deploys"));
      // The door owns its 400s, each naming what would work.
      expect((await read("&order=sideways")).body.error).toContain("order=desc");
      expect((await read("&n=0")).status).toBe(400);
      expect((await read("&after=yesterday")).body.error).toContain("YYYY-MM-DD");
      expect((await read("&format=pdf")).body.error).toContain("format=markdown");
    });

    // A dossier's body is nothing BUT links — every bullet cites its sources
    // and names the other entities it touches — and `links` came back empty
    // for all of them: the resolver only knew the two curated trees it walks,
    // so a `[[projection/entities/…]]` or `[[log/insertions/…]]` target found
    // nothing and answered null. A reader navigating the graph by `links`
    // was stranded on the densest page in the vault.
    test("a projected dossier resolves its own links: its cross-references and its citations", async () => {
      const { root, handler, token } = setup(["vault:read"]);
      const source: SourceInsertion = {
        event: "source.inserted",
        id: "ins_d0551e70000000000000000a",
        source_id: "planning-session",
        author: { kind: "service", id: "test" },
        title: "Planning session",
        body: "Ada and the engine.",
        envelope: { category: "meeting" },
        received_at: "2026-08-22T12:00:00.000Z",
        content_sha256: "sha-dossier",
      };
      appendSourceInsertionEvent(root, source);
      const bb = { id: assertionEntityId("BigBrain"), label: "BigBrain" };
      const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
      appendAssertionEvent(root, createAssertionEvent({
        text: `[[${bb.id}|BigBrain]] is the engine [[${ada.id}|Ada Lovelace]] runs.`,
        entities: [bb, ada],
        sources: [source.id],
        author: { kind: "model", id: "test", invocation_id: "run-1" },
        confidence: "direct",
        created_at: "2026-08-22T12:01:00.000Z",
        produced_by: { procedure: "test", version: "v1" },
      }, new Map([[source.id, source]])));
      const path = `projection/entities/${bb.id}.md`;
      const res = await handler(get(`/v1/note?path=${encodeURIComponent(path)}`, token));
      expect(res.status).toBe(200);
      const note = (await res.json()) as {
        markdown: string;
        links: { name: string; path: string | null }[];
      };
      expect(note.markdown).toContain(`[[projection/entities/${ada.id}.md|Ada Lovelace]]`);
      expect(note.links).toEqual([
        { name: `projection/entities/${ada.id}.md`, path: `projection/entities/${ada.id}.md` },
        { name: insertionEventRel(source), path: insertionEventRel(source) },
      ]);
      // the contract that matters: every path this door prints, this door opens
      for (const link of note.links) {
        const followed = await handler(get(`/v1/note?path=${encodeURIComponent(link.path!)}`, token));
        expect(followed.status).toBe(200);
      }
    });

    // The field report: /v1/search returned an insertion path and /v1/note
    // refused that exact path as `forbidden path`, while its siblings opened.
    // The event had been retracted from the log; the projection search reads
    // kept the row (its sync only ever adds). searchCore drops those hits
    // now — this is the door's half: a path that is SHAPED like a projected
    // note the record no longer holds gets a 404 that names the reason,
    // never a jail 403 that sends the reader hunting for a permission
    // problem it never had.
    test("a retracted source event is 404-with-a-reason, not `forbidden path`", async () => {
      const { root, handler, token } = setup(["vault:read"]);
      const source: SourceInsertion = {
        event: "source.inserted",
        id: "ins_832cf82309c6f01341bbf881",
        source_id: "agent-chat-1",
        author: { kind: "service", id: "test" },
        title: "Claude Code — bb-desktop-test",
        body: "A transcript the vault later retracted.",
        envelope: { category: "agent-chat" },
        received_at: "2026-08-26T12:00:00.000Z",
        content_sha256: "sha-retracted",
      };
      appendSourceInsertionEvent(root, source);
      const path = insertionEventRel(source);
      expect((await handler(get(`/v1/note?path=${encodeURIComponent(path)}`, token))).status).toBe(200);
      rmSync(join(root, path));
      const gone = await handler(get(`/v1/note?path=${encodeURIComponent(path)}`, token));
      expect(gone.status).toBe(404);
      expect(((await gone.json()) as { error: string }).error).toContain("not in the log");
      // an entity the record holds no assertions about is the same story
      const noEntity = await handler(
        get("/v1/note?path=projection/entities/ent_0000000000000000dead.md", token)
      );
      expect(noEntity.status).toBe(404);
      expect(((await noEntity.json()) as { error: string }).error).toContain("no assertions");
      // …and a path in no served tree is still 403, still says `forbidden
      // path` (bb.sh greps for it), and now names the served set
      const outside = await handler(get("/v1/note?path=log/assertions/2026-08/a.json", token));
      expect(outside.status).toBe(403);
      const error = ((await outside.json()) as { error: string }).error;
      expect(error).toContain("forbidden path");
      expect(error).toContain("references");
      expect(error).toContain("memory");
    });

    test("q windows a big SOURCE to the turns that match, with the rest marked by line", async () => {
      // The live failure (#618 follow-up): a 290KB agent-chat transcript
      // fetched through this door arrived as head and tail, and the agent
      // hand-wrote grep against a temp file to reach three turns. The door
      // does the grep now.
      const { root, handler, token } = setup(["vault:read"]);
      const turns = Array.from({ length: 200 }, (_, i) =>
        i === 120
          ? "user: and what did we decide about pricing?\n\nassistant: pricing routes tokens to the user — BYO model."
          : `user: turn ${i}\n\nassistant: acknowledged ${i}.`
      ).join("\n\n");
      const source: SourceInsertion = {
        event: "source.inserted",
        id: "ins_0123456789abcdef01234567",
        source_id: "long-session",
        author: { kind: "service", id: "test" },
        title: "Claude Code — BigBrain (2026-08-27)",
        body: turns,
        envelope: { category: "agent-chat" },
        received_at: "2026-08-27T12:00:00.000Z",
        content_sha256: "sha-transcript",
      };
      appendSourceInsertionEvent(root, source);
      const path = insertionEventRel(source);
      const read = async (qs = "") =>
        (await (
          await handler(get(`/v1/note?path=${encodeURIComponent(path)}${qs}`, token))
        ).json()) as {
          markdown: string;
          blocks_total?: number;
          blocks_matched?: number;
          blocks_shown?: number;
          error?: string;
        };

      const whole = await read();
      expect(whole.blocks_total).toBeUndefined(); // an unwindowed read is untouched
      expect(whole.markdown.length).toBeGreaterThan(9_000);

      const windowed = await read("&q=pricing+tokens");
      expect(windowed.blocks_matched).toBe(1);
      expect(windowed.blocks_shown).toBe(5); // the turn, plus two either side
      expect(windowed.markdown).toContain("pricing routes tokens to the user");
      expect(windowed.markdown).toContain("Windowed: 1 of 401 blocks match");
      expect(windowed.markdown).toContain("elided");
      expect(windowed.markdown.length).toBeLessThan(2_000);
      expect(windowed.markdown).not.toContain("turn 5");

      // slack widens the context; the door bounds it.
      expect((await read("&q=pricing+tokens&slack=6")).blocks_shown).toBe(13);
      expect((await read("&q=pricing+tokens&slack=0")).blocks_shown).toBe(1);
      expect((await read("&q=pricing+tokens&slack=99")).error).toContain("0 to 20");

      // A markdown note takes the same window — one implementation, not two.
      mkdirSync(join(root, "references"), { recursive: true });
      writeFileSync(
        join(root, "references", "long.md"),
        "---\ntitle: Long\n---\n\n" +
          Array.from({ length: 50 }, (_, i) => (i === 25 ? "the needle paragraph" : `filler ${i}`)).join("\n\n")
      );
      const md = (await (
        await handler(get("/v1/note?path=references/long.md&q=needle&slack=1", token))
      ).json()) as { blocks_shown: number; markdown: string; links: unknown[] };
      expect(md.blocks_shown).toBe(3);
      expect(md.markdown).toContain("the needle paragraph");
      expect(md.markdown).not.toContain("filler 1\n");
    });

    test("toc=1 maps a dossier by date instead of eliding it to head and tail", async () => {
      const { root, handler, token } = setup(["vault:read"]);
      const source: SourceInsertion = {
        event: "source.inserted",
        id: "ins_fedcba9876543210fedcba98",
        source_id: "toc-session",
        author: { kind: "service", id: "test" },
        title: "Sessions",
        body: "a long conversation",
        envelope: { category: "agent-chat" },
        received_at: "2026-08-23T12:00:00.000Z",
        content_sha256: "sha-toc",
      };
      appendSourceInsertionEvent(root, source);
      const bb = { id: assertionEntityId("BigBrain"), label: "BigBrain" };
      const days = ["2026-06-02", "2026-06-14", "2026-07-03", "2026-08-01", "2026-08-27"];
      days.forEach((day, i) => {
        appendAssertionEvent(root, createAssertionEvent({
          text: `[[${bb.id}|BigBrain]] claim number ${i}.`,
          entities: [bb],
          sources: [source.id],
          author: { kind: "model", id: "test", invocation_id: "run-1" },
          confidence: "direct",
          created_at: `${day}T10:00:00.000Z`,
          produced_by: { procedure: "test", version: "v1" },
        }, new Map([[source.id, source]])));
      });
      const path = `projection/entities/${bb.id}.md`;
      const res = await handler(get(`/v1/note?path=${encodeURIComponent(path)}&toc=1`, token));
      const body = (await res.json()) as { markdown: string; assertions_total: number; assertions_shown: number };
      expect(body.assertions_total).toBe(5);
      expect(body.assertions_shown).toBe(5);
      expect(body.markdown).toContain("Table of contents: 5 assertions, 2026-06-02 → 2026-08-27");
      expect(body.markdown).toContain("## 2026-08 — 2 assertions (2026-08-01 → 2026-08-27)");
      expect(body.markdown).toContain("`after=2026-06-02 before=2026-06-14`");
      // The handle in the map really is a window this door accepts.
      const bucket = (await (
        await handler(get(`/v1/note?path=${encodeURIComponent(path)}&after=2026-06-02&before=2026-06-14`, token))
      ).json()) as { assertions_shown: number };
      expect(bucket.assertions_shown).toBe(2);
      // The map composes with the window, and rides format=markdown too.
      const narrowed = (await (
        await handler(get(`/v1/note?path=${encodeURIComponent(path)}&toc=1&after=2026-08-01&format=markdown`, token))
      ).text());
      expect(narrowed).toContain("Table of contents: 2 of 5 assertions");
      expect(narrowed).not.toContain("## 2026-06");
    });

    test("format=markdown is the same note as text, newlines intact, links at the end", async () => {
      const { root, handler, token } = setup(["vault:read"]);
      mkdirSync(join(root, "references"), { recursive: true });
      writeFileSync(
        join(root, "references", "plain.md"),
        "---\ntitle: Plain\n---\n\nLine one.\nLine two cites [[entities/ada-lovelace]].\n"
      );
      const res = await handler(get("/v1/note?path=references/plain.md&format=markdown", token));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/markdown");
      const text = await res.text();
      expect(text).toContain("<!-- references/plain.md -->");
      expect(text).toContain("Line one.\nLine two cites");
      expect(text).toContain("## Links");
      expect(text.split("\n").length).toBeGreaterThan(5);
    });

    test("needs vault:read", async () => {
      const { handler, token } = setup(["inbox:write"]);
      expect((await handler(get("/v1/note?path=entities/x.md", token))).status).toBe(403);
    });
  });
});

// Issue #86: the hosted half of `bigbrain search` — the one product scan
// (lib/searchCore.ts, #495): the assertion projection, over HTTP for the
// thin CLI and the MCP shim. Every fixture pins BIGBRAIN_ASSERTION_DB into
// its OWN temp vault: no real vault's .state/ is ever touched.
describe("search", () => {
  const get = (path: string, token?: string) =>
    new Request(`http://api.test${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  const q = (query: string, extra = "") => `/v1/search?q=${encodeURIComponent(query)}${extra}`;

  afterEach(() => {
    delete process.env["BIGBRAIN_ASSERTION_DB"];
  });

  /** A native vault: an entity assertion and two dated source insertions
   * that all mention the same subject — enough to pin ranking, filters,
   * and snippets. */
  function searchFixture(scopes: string[] = ["vault:read"]) {
    const s = setup(scopes);
    process.env["BIGBRAIN_ASSERTION_DB"] = join(s.root, ".state", "assertions.db");
    const insert = (over: Partial<SourceInsertion>): SourceInsertion => {
      const source = insertion({
        id: "ins_000000000000000000000000",
        source_id: "src",
        author: { kind: "service", id: "test" },
        title: "untitled",
        body: "",
        envelope: {},
        content_sha256: "sha",
        ...over,
      });
      appendSourceInsertionEvent(s.root, source);
      return source;
    };
    const engine = insert({
      id: "ins_00000000000000000000000a",
      source_id: "r-1",
      title: "Engine notes",
      body: "Notes on the analytical engine and its punch cards.",
      received_at: "2026-08-08T10:00:00.000Z",
      content_sha256: "sha-engine",
    });
    const older = insert({
      id: "ins_00000000000000000000000b",
      source_id: "r-2",
      title: "Older engine notes",
      body: "An earlier analytical engine memo.",
      received_at: "2026-07-01T10:00:00.000Z",
      content_sha256: "sha-older",
    });
    const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
    appendAssertionEvent(s.root, createAssertionEvent({
      text: `[[${ada.id}|Ada Lovelace]] wrote the first algorithm for the analytical engine.`,
      entities: [ada],
      sources: [engine.id],
      author: { kind: "model", id: "test", invocation_id: "run-1" },
      confidence: "direct",
      created_at: "2026-08-08T11:00:00.000Z",
      produced_by: { procedure: "test", version: "v1" },
    }, new Map([[engine.id, engine]])));
    return { ...s, insert, engine, older, entityPath: `projection/entities/${ada.id}.md` };
  }

  test("a vault:read token gets ranked hits, path/title/snippet/score each", async () => {
    const { handler, token, entityPath } = searchFixture();
    const res = await handler(get(q("ada lovelace"), token));
    expect(res.status).toBe(200);
    const { hits } = (await res.json()) as {
      hits: { path: string; title: string; snippet: string; score: number }[];
    };
    // the shared ranking: the entity NAMED for the query comes first
    expect(hits[0]?.path).toBe(entityPath);
    expect(hits[0]?.title).toBe("Ada Lovelace");
    expect(typeof hits[0]?.snippet).toBe("string");
    expect(typeof hits[0]?.score).toBe("number");
  });

  test("reader searches discover openable memory; authenticated gardener searches stay on the record", async () => {
    const { handler, token, root } = searchFixture(["vault:read", "tend"]);
    mkdirSync(join(root, "memory"));
    writeFileSync(join(root, "memory/engine.md"), "# Engine\nThe analytical engine uses punch cards.");
    const res = await handler(get(q("punch cards", "&n=1"), token));
    expect(res.status).toBe(200);
    const { hits } = await res.json() as { hits: { path: string; evidence?: string }[] };
    expect(hits).toMatchObject([{ path: "memory/engine.md", evidence: "memory" }]);
    const note = await handler(get(`/v1/note?path=${hits[0]!.path}`, token));
    expect(note.status).toBe(200);
    expect((await note.json() as { markdown: string }).markdown).toContain("analytical engine");
    const gardener = await handler(get(q("punch cards", "&via=gardener"), token));
    const record = await gardener.json() as { hits: { evidence?: string }[] };
    expect(record.hits.length).toBeGreaterThan(0);
    expect(record.hits.every(h => h.evidence !== "memory")).toBe(true);
  });

  test("sources are searchable directly — a drop is a hit before any assertion cites it", async () => {
    const { handler, token, engine } = searchFixture();
    const { hits } = (await (await handler(get(q("punch cards"), token))).json()) as {
      hits: { path: string }[];
    };
    expect(hits.map((h) => h.path)).toContain(insertionEventRel(engine));
  });

  test("FTS operators and punctuation still return results, never an error", async () => {
    const { handler, token } = searchFixture();
    // the sanitizer keeps only word terms, so MATCH never sees an operator
    const res = await handler(get(q('"analytical engine" AND (punch cards) -- ???'), token));
    expect(res.status).toBe(200);
    const { hits } = (await res.json()) as { hits: { path: string }[] };
    expect(hits.length).toBeGreaterThan(0);
  });

  test("a query that sanitizes down to nothing is a real query: 200, no hits", async () => {
    const { handler, token } = searchFixture();
    const res = await handler(get(q("*** -- ???")), );
    expect(res.status).toBe(401); // no token on this one — see below for the shape
    const authed = await handler(get(q("*** -- ???"), token));
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual({ hits: [], applied_filters: {}, only_agent_records: false });
  });

  test("a missing or blank q → 400, distinct from a search that found nothing", async () => {
    const { handler, token } = searchFixture();
    expect((await handler(get("/v1/search", token))).status).toBe(400);
    expect((await handler(get(q("   "), token))).status).toBe(400);
    const empty = await handler(get(q("quantum tunnelling"), token));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ hits: [], applied_filters: {}, only_agent_records: false });
  });

  test("search returns memory through HTTP, and malformed OR is a query error", async () => {
    const { handler, token, root } = searchFixture();
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "memory/health.md"), "# Health\nGI appointment: Tuesday, 2 PM.");
    const result = await handler(get(q("gastro OR GI appointment"), token));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ hits: [{ path: "memory/health.md", evidence: "memory" }], applied_filters: {}, only_agent_records: false });
    const bad = await handler(get(q("GI OR"), token));
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toContain("both sides");
  });

  describe("filters and hit dates (#349)", () => {
    test("every hit carries a date — the source's own arrival, the entity's newest evidence", async () => {
      const { handler, token, engine, entityPath } = searchFixture();
      const { hits } = (await (await handler(get(q("analytical engine"), token))).json()) as {
        hits: { path: string; date: string }[];
      };
      const byPath = new Map(hits.map((h) => [h.path, h.date]));
      expect(byPath.get(insertionEventRel(engine))).toBe("2026-08-08");
      // the entity answers to its NAME (entity_fts holds labels, not prose);
      // its date is its newest evidence
      const ada = (await (await handler(get(q("ada lovelace"), token))).json()) as {
        hits: { path: string; date: string }[];
      };
      expect(new Map(ada.hits.map((h) => [h.path, h.date])).get(entityPath)).toBe("2026-08-08");
    });

    test("type= narrows to one shape of the record", async () => {
      const { handler, token, entityPath, engine, older } = searchFixture();
      const paths = async (extra: string, query = "analytical engine") =>
        (
          (await (await handler(get(q(query, extra), token))).json()) as {
            hits: { path: string }[];
          }
        ).hits.map((h) => h.path);
      // entity-led: the entity itself plus its cited evidence (the shape the
      // shared scan pins in searchCore.test.ts)
      expect(await paths("&type=entity", "ada")).toEqual([entityPath, insertionEventRel(engine)]);
      const refs = await paths("&type=reference");
      expect(refs).toContain(insertionEventRel(engine));
      expect(refs).toContain(insertionEventRel(older));
      expect(refs).not.toContain(entityPath);
    });

    test("after/before are inclusive date bounds", async () => {
      const { handler, token, engine, older } = searchFixture();
      const paths = async (extra: string) =>
        (
          (await (await handler(get(q("analytical engine", extra), token))).json()) as {
            hits: { path: string }[];
          }
        ).hits.map((h) => h.path);
      const afterHits = await paths("&after=2026-08-08&type=reference");
      expect(afterHits).toContain(insertionEventRel(engine)); // inclusive edge
      expect(afterHits).not.toContain(insertionEventRel(older));
      expect(await paths("&before=2026-07-31&type=reference")).toEqual([insertionEventRel(older)]);
    });

    test("a malformed filter is an instructive 400 — the error names the fix", async () => {
      const { handler, token } = searchFixture();
      const err = async (extra: string) => {
        const res = await handler(get(q("engine", extra), token));
        expect(res.status).toBe(400);
        return ((await res.json()) as { error: string }).error;
      };
      expect(await err("&after=last-week")).toContain("YYYY-MM-DD");
      expect(await err("&before=2026-8-1")).toContain("YYYY-MM-DD");
      expect(await err("&type=meeting")).toContain("type=reference or type=entity");
    });
  });

  test("n clamps: 20 by default, SEARCH_CAP (250, unified with the viewer — #259) at the ceiling", async () => {
    const { handler, token, insert } = searchFixture();
    for (let i = 0; i < 260; i++)
      insert({
        id: `ins_${String(i).padStart(24, "0")}`,
        source_id: `bulk-${i}`,
        title: `Bulk ${i}`,
        body: "A widget note.",
        received_at: "2026-08-10T10:00:00.000Z",
        content_sha256: `sha-bulk-${i}`,
      });
    const count = async (extra: string) =>
      ((await (await handler(get(q("widget", extra), token))).json()) as { hits: unknown[] }).hits
        .length;
    expect(await count("")).toBe(20);
    expect(await count("&n=500")).toBe(250);
    expect(await count("&n=nope")).toBe(20);
    expect(await count("&n=5")).toBe(5);
  });

  test("a projection that cannot be built answers 500 rather than throwing out of the handler", async () => {
    const { handler, token, root } = setup(["vault:read"]);
    writeFileSync(join(root, ".state"), "a file where the projection wants a directory\n");
    const res = await handler(get(q("widget"), token));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("search unavailable");
  });

  test("without vault:read → 403 naming the scope; without a token → 401", async () => {
    const { handler, token } = searchFixture(["inbox:write"]);
    const res = await handler(get(q("ada"), token));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("vault:read");
    expect((await handler(get(q("ada")))).status).toBe(401);
  });

  // The label half (lib/retrieval.ts). An agent that searches and then
  // fetches a hit has made a relevance judgment nobody had to author —
  // which is the only human signal BigBrainBench can grow from usage.
  describe("the retrieval ledger", () => {
    test("a search followed by fetching a hit becomes one label with its rank", async () => {
      const { handler, token, root, engine } = searchFixture();
      await handler(get(q("punch cards"), token));
      await handler(get(`/v1/note?path=${insertionEventRel(engine)}`, token));

      const ls = labels(readLedger(root));
      expect(ls).toHaveLength(1);
      expect(ls[0]!.via).toBe("api");
      expect(ls[0]!.q).toBe("punch cards");
      expect(ls[0]!.used).toEqual([insertionEventRel(engine)]);
      expect(ls[0]!.firstUsedRank).toBeGreaterThan(0);
    });

    test("a search nobody acts on is kept as the negative example", async () => {
      const { handler, token, root } = searchFixture();
      await handler(get(q("analytical engine"), token));
      expect(labels(readLedger(root))[0]!.used).toEqual([]);
    });

    test("a rejected search writes no label — 403 and 400 leave the ledger empty", async () => {
      const denied = searchFixture(["inbox:write"]);
      await denied.handler(get(q("ada"), denied.token));
      expect(readLedger(denied.root)).toEqual([]);

      const ok = searchFixture();
      await ok.handler(get("/v1/search", ok.token));
      expect(readLedger(ok.root)).toEqual([]);
    });

    test("the ledger records the query and paths — never the source's content", async () => {
      const { handler, token, root, engine } = searchFixture();
      await handler(get(q("analytical engine"), token));
      await handler(get(`/v1/note?path=${insertionEventRel(engine)}`, token));
      const raw = readFileSync(join(root, ledgerRel(new Date())), "utf8");
      expect(raw).toContain("analytical engine");
      expect(raw).not.toContain("first algorithm");
      expect(raw).not.toContain("punch cards.");
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe("retired external chat capture", () => {
  test("old plugins cannot land transcripts even when legacy config enables capture", async () => {
    const { root, handler, token } = setup();
    writeFileSync(join(root, "vault.yaml"), "integrations:\n  agent-chat:\n    enabled: true\n");
    const before = readdirSync(root);
    const response = await handler(new Request("http://api.test/v1/session", {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "legacy transcript",
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ skipped: "External chat capture has been retired" });
    expect(readdirSync(root)).toEqual(before);
    expect(readdirSync(join(root, "inbox"))).toEqual([]);
  });
});

// The route table (#264): one list drives both "is this path known" and
// "which handler answers it" — so a route can't be declared to the auth
// gate and forgotten in dispatch, or the reverse. This locks the declared
// surface against the doc comment atop lib/api.ts, then proves every
// entry actually reaches ITS handler rather than falling through to the
// router's generic 404.
describe("the route table (#264)", () => {
  test("matches the doc comment's surface exactly", () => {
    const surface = ROUTES.map((r) => `${r.method} ${r.path}`).sort();
    expect(surface).toEqual(
      [
        "POST /v1/pair",
        "GET /v1/whoami",
        "POST /v1/drop",
        "POST /v1/session",
        "POST /v1/enqueue",
        "POST /v1/observe",
        "GET /v1/status",
        "GET /v1/note",
        "GET /v1/search",
        "GET /v1/memory",
        "GET /v1/gardener/next",
        "POST /v1/gardener/submit",
      ].sort()
    );
  });

  test("every table entry is reachable, and nothing answers outside it", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-api-vault-"));
    mkdirSync(join(root, "inbox"), { recursive: true });
    mkdirSync(join(root, "entities"), { recursive: true });
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "entities", "probe.md"), "---\ntitle: probe\n---\nbody");
    writeFileSync(join(root, "memory", "MEMORY.md"), "probe");
    writeFileSync(join(root, "vault.yaml"), NATIVE_YAML); // #495: search is projection-only
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed"],
      {
        cwd: root,
      }
    );
    const storePath = join(mkdtempSync(join(tmpdir(), "bb-api-store-")), "tokens.json");
    const { token } = mintToken(storePath, root, "audit", ["inbox:write", "vault:read", "tend"], {
      owner: "nick@example.com",
      kind: "person-device",
    });
    const handler = makeApiHandler({ root, storePath, log: () => {} });
    const auth = { Authorization: `Bearer ${token}` };

    // method, path, body,
    // and the ONE status that proves the real handler ran (never the
    // router's bare 404).
    const probes: { method: string; path: string; body?: string; reachable: number[] }[] = [
      { method: "GET", path: "/v1/whoami", reachable: [200] },
      { method: "POST", path: "/v1/drop", body: "", reachable: [400] }, // empty item
      { method: "POST", path: "/v1/session", body: "", reachable: [200] }, // retired upload receipt
      { method: "POST", path: "/v1/enqueue", body: '{"guidance":"probe"}', reachable: [200] },
      { method: "POST", path: "/v1/observe", body: "{}", reachable: [400] }, // empty observation
      { method: "GET", path: "/v1/status", reachable: [200] },
      { method: "GET", path: "/v1/note?path=entities/probe.md", reachable: [200] },
      { method: "GET", path: "/v1/search?q=probe", reachable: [200] },
      { method: "GET", path: "/v1/memory", reachable: [200] },
      { method: "GET", path: "/v1/gardener/next", reachable: [200] },
      { method: "POST", path: "/v1/gardener/submit", body: "{}", reachable: [400] }, // no items
      { method: "POST", path: "/v1/pair", body: "{}", reachable: [400] }, // public; no code in the body
    ];
    expect(probes.length).toBe(ROUTES.length);

    for (const p of probes) {
      const res = await handler(
        new Request(`http://api.test${p.path}`, {
          method: p.method,
          headers: p.body === undefined ? auth : { ...auth, "content-type": "application/json" },
          body: p.body,
        })
      );
      expect(p.reachable).toContain(res.status);
    }

    // And the fallback still holds: a path that names no table entry
    // never reaches a handler, table-driven or otherwise.
    expect((await handler(new Request("http://api.test/v1/nope", { headers: auth }))).status).toBe(
      404
    );
  });
});

// ── the gardener door (#479) ──────────────────────────────────────────────

describe("the gardener door (#479)", () => {
  let gseq = 0;
  const gIns = (): SourceInsertion => {
    gseq += 1;
    const n = String(gseq).padStart(3, "0");
    return insertion({
      id: `ins_${n}${"0".repeat(18)}door`,
      source_id: `door-src-${n}`,
      author: { kind: "service", id: "test" },
      title: `Door item ${n}`,
      body: `Body ${n}: Ada said the Atlas experiment should test sparse probes.`,
      envelope: { id: `door-src-${n}` },
      received_at: `2026-08-20T11:${n.slice(-2)}:00.000Z`,
      content_sha256: `door-sha-${n}`,
    });
  };
  const doorSetup = (scopes: string[] = ["tend"], ...insertions: SourceInsertion[]) => {
    const s = setup(scopes);
    writeFileSync(join(s.root, "vault.yaml"), NATIVE_YAML); // #495: search is projection-only
    for (const event of insertions) appendSourceInsertionEvent(s.root, event);
    return s;
  };
  const next = (token: string | undefined, qs = "") =>
    new Request(`http://api.test/v1/gardener/next${qs}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  const submit = (token: string, body: unknown) =>
    new Request("http://api.test/v1/gardener/submit", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  type Items = { items: { job: { kind: string; insertion_id?: string }; inputs: Record<string, unknown> }[] };

  test("both routes demand the tend scope — a connect-shaped token is refused", async () => {
    const a = gIns();
    const { handler, token } = doorSetup(["inbox:write", "vault:read"], a);
    expect((await handler(next(undefined))).status).toBe(401);
    const refusedNext = await handler(next(token));
    expect(refusedNext.status).toBe(403);
    expect(await refusedNext.json()).toEqual({ error: "missing scope tend" });
    expect((await handler(submit(token, { items: [] }))).status).toBe(403);
  });

  test("next is a pure read with context packs — twice, the same due set", async () => {
    const a = gIns();
    const b = gIns();
    const { handler, token } = doorSetup(["tend"], a, b);
    const res = await handler(next(token, "?kinds=intake"));
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as Items;
    expect(items.map((i) => i.job.insertion_id).sort()).toEqual([a.id, b.id].sort());
    expect(items[0]!.inputs).toHaveProperty("insertion");
    expect(items[0]!.inputs).toHaveProperty("neighborhood");
    const again = (await (await handler(next(token, "?kinds=intake"))).json()) as Items;
    expect(again.items.map((i) => i.job.insertion_id).sort()).toEqual([a.id, b.id].sort());
    const capped = (await (await handler(next(token, "?kinds=intake&limit=1"))).json()) as Items;
    expect(capped.items).toHaveLength(1);
  });

  test("next validates kinds and limit with messages that say what would work", async () => {
    const { handler, token } = doorSetup(["tend"], gIns());
    const badKind = await handler(next(token, "?kinds=editor"));
    expect(badKind.status).toBe(400);
    expect(((await badKind.json()) as { error: string }).error).toContain("intake, staged, memory");
    expect((await handler(next(token, "?limit=0"))).status).toBe(400);
    expect((await handler(next(token, "?kinds=intake&limit=99"))).status).toBe(400);
  });

  test("submit stamps journal/tend/door.json — the hosted vault's last-run trace (#482)", async () => {
    const a = gIns();
    const { handler, token, root } = doorSetup(["tend", "vault:read"], a);
    const res = await handler(
      submit(token, { items: [{ submit: "decline", insertion_ids: [a.id], reason: "trace test" }] })
    );
    expect(res.status).toBe(200);
    const door = JSON.parse(readFileSync(join(root, "journal", "tend", "door.json"), "utf8")) as {
      format: string;
      at: string;
      settled: number;
      by: string;
    };
    expect(door.format).toBe("bigbrain-tend-door/v1");
    expect(door.settled).toBe(1);
    expect(door.by.length).toBeGreaterThan(0);
    // /v1/status now answers for a vault tended only through the door…
    const authGet = (pth: string) =>
      new Request(`http://api.test${pth}`, { headers: { Authorization: `Bearer ${token}` } });
    const status = (await (await handler(authGet("/v1/status"))).json()) as {
      last_run: { run: string; startedAt: string };
    };
    expect(status.last_run.run).toBe("door");
    expect(status.last_run.startedAt).toBe(door.at);
    // …and the stray file beside the month shards breaks nothing: a NEWER
    // journaled run still wins.
    mkdirSync(join(root, "journal", "tend", "2099-01"), { recursive: true });
    writeFileSync(
      join(root, "journal", "tend", "2099-01", "future.json"),
      JSON.stringify({ invocation_id: "future-run", started_at: "2099-01-01T00:00:00.000Z", wall_ms: 5 })
    );
    const after = (await (await handler(authGet("/v1/status"))).json()) as {
      last_run: { run: string };
    };
    expect(after.last_run.run).toBe("future-run");
  });

  test("submit settles per item, dedupes a retry, and a decline is an answer", async () => {
    const a = gIns();
    const b = gIns();
    const { handler, token, root, storePath } = doorSetup(["tend"], a, b);
    const assertion = {
      submit: "assertion",
      text: "[[Ada Lovelace]] wants sparse probes tested.",
      sources: [a.id],
      confidence: "direct",
    };
    const first = await handler(submit(token, { items: [assertion] }));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ appended: 1, deduped: 0, rejected: 0 });
    // idempotent: the same content converges on the prior event
    expect(await (await handler(submit(token, { items: [assertion] }))).json()).toMatchObject({
      appended: 0,
      deduped: 1,
    });
    expect(
      await (
        await handler(
          submit(token, { items: [{ submit: "decline", insertion_ids: [b.id], reason: "junk" }] })
        )
      ).json()
    ).toMatchObject({ appended: 1 });
    // settled work leaves the due set for EVERY caller — the no-leases
    // double-processing answer: a second client simply finds nothing due.
    const second = mintToken(storePath, root, "laptop b", ["tend"]);
    const drained = (await (await handler(next(second.token, "?kinds=intake"))).json()) as Items;
    expect(drained.items).toEqual([]);
  });

  test("host validation rejects per item with the validator's words", async () => {
    const a = gIns();
    const b = gIns();
    const { handler, token } = doorSetup(["tend"], a, b);
    const r = (await (
      await handler(
        submit(token, {
          items: [
            { submit: "assertion", text: "[[Ada Lovelace]] ok.", sources: [a.id], confidence: "maybe" },
            { submit: "assertion", text: "[[ent_00000000000000000000|ghost]] link.", sources: [b.id], confidence: "direct" },
            { submit: "assertion", text: "[[Ada Lovelace]] fine.", sources: [b.id], confidence: "direct" },
          ],
        })
      )
    ).json()) as { results: { index: number; ok: boolean; error?: string }[]; appended: number; rejected: number };
    expect(r.appended).toBe(1);
    expect(r.rejected).toBe(2);
    expect(r.results.map((x) => x.index)).toEqual([0, 1, 2]);
    expect(r.results[0]!.error).toContain("confidence");
    expect(r.results[1]!.error).toContain("unknown projected entity");
    expect(r.results[2]!.ok).toBe(true);
  });

  test("top-level misuse is a 400, never a half-processed batch", async () => {
    const { handler, token } = doorSetup(["tend"], gIns());
    const badJson = await handler(submit(token, "not json {"));
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({ error: "bad JSON body" });
    const noItems = await handler(submit(token, { items: [] }));
    expect(noItems.status).toBe(400);
    expect(((await noItems.json()) as { error: string }).error).toContain("non-empty array");
    // A body that parses but is not an object. This used to reach
    // `body.items` off `null` and answer 400 with the interpreter's own
    // words — "null is not an object (evaluating 'body.items')" — which
    // is the engine's internals on the wire (#639).
    const notObject = await handler(submit(token, "null"));
    expect(notObject.status).toBe(400);
    expect(await notObject.json()).toEqual({ error: "body must be a JSON object" });
    expect((await handler(submit(token, "[]"))).status).toBe(400);
  });

  test("a tend-scoped reader may declare via=gardener; anyone else stays api (#502)", async () => {
    const a = gIns();
    const gardener = doorSetup(["tend", "vault:read"], a);
    const search = (token: string, qs: string) =>
      new Request(`http://api.test/v1/search?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    expect((await gardener.handler(search(gardener.token, "q=sparse&via=gardener"))).status).toBe(200);
    expect(readLedger(gardener.root)).toContainEqual(
      expect.objectContaining({ t: "search", via: "gardener" })
    );
    const reader = doorSetup(["vault:read"], gIns());
    expect((await reader.handler(search(reader.token, "q=sparse&via=gardener"))).status).toBe(200);
    expect(readLedger(reader.root)).toContainEqual(
      expect.objectContaining({ t: "search", via: "api" })
    );
    expect(readLedger(reader.root).some((row) => (row as { via?: string }).via === "gardener")).toBe(false);
  });
});
