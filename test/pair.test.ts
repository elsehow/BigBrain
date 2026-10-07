/**
 * Browser pairing (lib/pair.ts, #486): the code the app mints, the token
 * the extension gets for it, and what the integrations card can then list.
 * Everything runs against temp dirs — no real token store, no real vault.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeApiHandler } from "../lib/api";
import { listTokens } from "../lib/auth";
import {
  browserTokenName,
  mintPairCode,
  normalizeClient,
  PAIR_MAX_MISSES,
  PAIR_TTL_MS,
  pairFile,
  pendingPair,
  redeemPairCode,
} from "../lib/pair";
import { mdVault } from "./support/vault";

function vault() {
  const root = mdVault({ prefix: "bb-pair-", dirs: ["inbox"] });
  return { root, storePath: join(root, "tokens.json") };
}

describe("the code", () => {
  test("mints as XXXX-XXXX from the unambiguous alphabet, lives ten minutes, replaces itself", () => {
    const { root } = vault();
    const t0 = new Date("2026-08-27T10:00:00Z");
    const a = mintPairCode(root, t0);
    expect(a.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(Date.parse(a.expires) - Date.parse(a.created)).toBe(PAIR_TTL_MS);
    expect(pendingPair(root, t0)?.code).toBe(a.code);
    const b = mintPairCode(root, t0);
    expect(b.code).not.toBe(a.code);
    expect(pendingPair(root, t0)?.code).toBe(b.code);
    // expired: gone, and the file with it
    expect(pendingPair(root, new Date(t0.getTime() + PAIR_TTL_MS))).toBeNull();
    expect(existsSync(pairFile(root))).toBe(false);
  });

  test("nothing pending → null; a wrong code → null; case and the dash do not matter", () => {
    const { root, storePath } = vault();
    const opts = { owner: "a@example.com", storePath, machine: "mac" };
    expect(redeemPairCode(root, "AAAA-AAAA", "chrome", opts)).toBeNull();
    const { code } = mintPairCode(root);
    expect(redeemPairCode(root, "AAAA-AAAA", "chrome", opts)).toBeNull();
    expect(pendingPair(root)).not.toBeNull(); // one miss does not spend it
    const r = redeemPairCode(root, ` ${code.toLowerCase().replace("-", "")} `, "chrome", opts);
    expect(r).not.toBeNull();
    expect(pendingPair(root)).toBeNull(); // a hit does
    expect(redeemPairCode(root, code, "chrome", opts)).toBeNull(); // once
  });

  test("misses count against the code: the tenth spends it, a fresh code starts over", () => {
    const { root, storePath } = vault();
    const opts = { owner: "a@example.com", storePath, machine: "mac" };
    const first = mintPairCode(root);
    for (let i = 1; i < PAIR_MAX_MISSES; i++) expect(redeemPairCode(root, "AAAA-AAAA", "chrome", opts)).toBeNull();
    expect(pendingPair(root)).toEqual(first); // nine misses: still good, and the count stays on disk
    expect(redeemPairCode(root, "AAAA-AAAA", "chrome", opts)).toBeNull();
    expect(pendingPair(root)).toBeNull();
    expect(existsSync(pairFile(root))).toBe(false);
    expect(redeemPairCode(root, first.code, "chrome", opts)).toBeNull(); // the right code, too late
    const fresh = mintPairCode(root);
    for (let i = 1; i < PAIR_MAX_MISSES; i++) redeemPairCode(root, "AAAA-AAAA", "chrome", opts);
    expect(redeemPairCode(root, fresh.code, "chrome", opts)).not.toBeNull();
    expect(listTokens(storePath)).toHaveLength(1);
  });
});

describe("the token", () => {
  test("is a person-device credential in the owner's name, via pair, inbox:write only", () => {
    const { root, storePath } = vault();
    const { code } = mintPairCode(root);
    const r = redeemPairCode(root, code, "Google Chrome", { owner: "a@example.com", storePath, machine: "Mac-mini.local" })!;
    expect(r.record).toMatchObject({
      name: "google chrome on Mac-mini.local",
      owner: "a@example.com",
      kind: "person-device",
      via: "pair",
      scopes: ["inbox:write"],
      revoked: null,
    });
    expect(r.token.startsWith(`bb_${r.record.id}_`)).toBe(true);
    expect(r.superseded).toEqual([]);
  });

  test("the same browser pairing again supersedes its live token; the card lists live browsers newest first", () => {
    const { root, storePath } = vault();
    const opts = { owner: "a@example.com", storePath, machine: "mac" };
    const first = redeemPairCode(root, mintPairCode(root).code, "chrome", opts)!;
    const fx = redeemPairCode(root, mintPairCode(root).code, "firefox", opts)!;
    const again = redeemPairCode(root, mintPairCode(root).code, "chrome", opts)!;
    expect(again.superseded).toEqual([first.record.id]);
    expect(listTokens(storePath).find((t) => t.id === first.record.id)?.revoked).not.toBeNull();
    // the live pair credentials, newest first — what the browsers card lists
    // off /api/tokens (`via: "pair"`, unrevoked)
    expect(
      listTokens(storePath)
        .filter((t) => t.via === "pair" && !t.revoked)
        .sort((a, b) => (a.created < b.created ? 1 : -1))
        .map((t) => t.id)
    ).toEqual([again.record.id, fx.record.id]);
  });

  test("names: the client is folded and bounded, the machine sanitized like connect's", () => {
    expect(normalizeClient("Google Chrome")).toBe("google chrome");
    expect(normalizeClient("  Zen!!  ")).toBe("zen");
    expect(normalizeClient("")).toBe("browser");
    expect(normalizeClient(undefined)).toBe("browser");
    expect(normalizeClient("x".repeat(40))).toHaveLength(20);
    expect(browserTokenName("firefox", "Nick’s MacBook")).toBe("firefox on NicksMacBook");
    expect(browserTokenName("firefox", "")).toBe("firefox");
  });
});

describe("POST /v1/pair", () => {
  const post = (body: unknown) =>
    new Request("http://api.test/v1/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  test("a good code answers a token that works; the code is then spent", async () => {
    const { root, storePath } = vault();
    const handler = makeApiHandler({ root, storePath, log: () => {}, pairOwner: () => "a@example.com" });
    const { code } = mintPairCode(root);
    const res = await handler(post({ code, client: "Chrome" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; name: string; owner: string };
    expect(body.name.startsWith("chrome on ")).toBe(true);
    expect(body.owner).toBe("a@example.com");
    const who = await handler(new Request("http://api.test/v1/whoami", { headers: { Authorization: `Bearer ${body.token}` } }));
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({ name: body.name, kind: "person-device", scopes: ["inbox:write"] });
    expect((await handler(post({ code, client: "Chrome" }))).status).toBe(403);
  }, 10_000);

  test("no body → 400; no code → 400; a wrong code → 403 and nothing minted", async () => {
    const { root, storePath } = vault();
    const handler = makeApiHandler({ root, storePath, log: () => {}, pairOwner: () => "a@example.com" });
    mintPairCode(root);
    expect((await handler(post("not json"))).status).toBe(400);
    // A body that parses but is not an OBJECT. `null` used to reach
    // `body.code` and THROW out of an unauthenticated handler — a 500 the
    // access log never saw, from two bytes anyone who can reach the port
    // could send (#639).
    expect((await handler(post("null"))).status).toBe(400);
    expect(await (await handler(post("null"))).json()).toEqual({
      error: "expected a JSON body {code, client}",
    });
    expect((await handler(post("[]"))).status).toBe(400);
    expect((await handler(post("42"))).status).toBe(400);
    expect((await handler(post({ client: "Chrome" }))).status).toBe(400);
    expect((await handler(post({ code: "AAAA-AAAA", client: "Chrome" }))).status).toBe(403);
    expect(listTokens(storePath)).toEqual([]);
  }, 10_000);

  test("is public — no bearer needed — and the preflight lets a private-network caller in", async () => {
    const { root, storePath } = vault();
    const handler = makeApiHandler({ root, storePath, log: () => {} });
    const pre = await handler(new Request("http://api.test/v1/pair", { method: "OPTIONS" }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Private-Network")).toBe("true");
    // GET has no entry: 404 without ever asking for a token
    expect((await handler(new Request("http://api.test/v1/pair"))).status).toBe(404);
  });
});
