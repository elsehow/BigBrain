import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasScope,
  listTokens,
  mintToken,
  revokeToken,
  saveClientToken,
  touchLastUsed,
  verifyToken,
} from "../lib/auth";

const tmp = () => mkdtempSync(join(tmpdir(), "bb-auth-"));
const storeIn = (dir: string) => join(dir, "tokens.json");

describe("mint + verify", () => {
  test("round-trips", () => {
    const store = storeIn(tmp());
    const { token, record } = mintToken(store, "/vault", "laptop", ["inbox:write"]);
    expect(token).toMatch(/^bb_[0-9a-f]{8}_[A-Za-z0-9_-]+$/);
    const v = verifyToken(store, token);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.record.id).toBe(record.id);
      expect(v.record.name).toBe("laptop");
      expect(v.record.scopes).toEqual(["inbox:write"]);
    }
  });

  test("plaintext secret is not at rest", async () => {
    const store = storeIn(tmp());
    const { token } = mintToken(store, "/vault", "x", ["inbox:write"]);
    // The secret is base64url, whose alphabet INCLUDES `_` — so it is
    // everything after the second separator, rejoined. Indexing split()[2]
    // would check only the fragment before the secret's own first
    // underscore (about half of them), and would be the empty string when
    // the secret starts with one — which `not.toContain` can never satisfy.
    const secret = token.split("_").slice(2).join("_");
    expect(secret).not.toBe("");
    await expect(Bun.file(store).text()).resolves.not.toContain(secret);
  });

  test("wrong secret refuses", () => {
    const store = storeIn(tmp());
    const { token } = mintToken(store, "/vault", "x", ["inbox:write"]);
    const forged = token.slice(0, -4) + (token.endsWith("aaaa") ? "bbbb" : "aaaa");
    expect(verifyToken(store, forged).ok).toBe(false);
  });

  test("unknown id refuses", () => {
    const store = storeIn(tmp());
    mintToken(store, "/vault", "x", ["inbox:write"]);
    expect(verifyToken(store, "bb_00000000_deadbeef").ok).toBe(false);
  });

  test("malformed token refuses", () => {
    const store = storeIn(tmp());
    mintToken(store, "/vault", "x", ["inbox:write"]);
    for (const bad of ["", "garbage", "Bearer bb_x", "bb_zzzz_ok"])
      expect(verifyToken(store, bad).ok).toBe(false);
  });

  test("revoked token refuses, record survives for audit", () => {
    const store = storeIn(tmp());
    const { token, record } = mintToken(store, "/vault", "x", ["inbox:write"]);
    expect(revokeToken(store, record.id)).toBe(true);
    expect(verifyToken(store, token).ok).toBe(false);
    const listed = listTokens(store).find((t) => t.id === record.id);
    expect(listed?.revoked).toBeTruthy();
  });

  test("revoking a nonexistent id reports false", () => {
    const store = storeIn(tmp());
    expect(revokeToken(store, "ffffffff")).toBe(false);
  });
});

describe("fail-closed", () => {
  test("missing store refuses", () => {
    expect(verifyToken(join(tmp(), "nope.json"), "bb_00000000_x").ok).toBe(false);
  });

  test("empty token list refuses", () => {
    const store = storeIn(tmp());
    writeFileSync(store, JSON.stringify({ version: 1, vault: "/v", tokens: [] }));
    expect(verifyToken(store, "bb_00000000_x").ok).toBe(false);
  });

  test("corrupt JSON refuses", () => {
    const store = storeIn(tmp());
    writeFileSync(store, "{not json");
    expect(verifyToken(store, "bb_00000000_x").ok).toBe(false);
  });

  test("wrong shape refuses", () => {
    const store = storeIn(tmp());
    writeFileSync(store, "{}");
    expect(verifyToken(store, "bb_00000000_x").ok).toBe(false);
  });
});

describe("scopes", () => {
  test("exact string match only", () => {
    const store = storeIn(tmp());
    const { record } = mintToken(store, "/vault", "x", ["inbox:write"]);
    expect(hasScope(record, "inbox:write")).toBe(true);
    expect(hasScope(record, "outbox:write")).toBe(false);
    expect(hasScope(record, "inbox")).toBe(false);
  });
});

describe("touchLastUsed", () => {
  test("stamps and throttles", () => {
    const store = storeIn(tmp());
    const { record } = mintToken(store, "/vault", "x", ["inbox:write"]);
    const t0 = new Date("2026-07-13T10:00:00Z");
    touchLastUsed(store, record.id, t0);
    expect(listTokens(store)[0]!.last_used).toBe(t0.toISOString());
    touchLastUsed(store, record.id, new Date(t0.getTime() + 30_000));
    expect(listTokens(store)[0]!.last_used).toBe(t0.toISOString()); // throttled
    const t2 = new Date(t0.getTime() + 61_000);
    touchLastUsed(store, record.id, t2);
    expect(listTokens(store)[0]!.last_used).toBe(t2.toISOString());
  });

  test("cannot resurrect a concurrent revoke", () => {
    const store = storeIn(tmp());
    const { token, record } = mintToken(store, "/vault", "x", ["inbox:write"]);
    expect(verifyToken(store, token).ok).toBe(true);
    revokeToken(store, record.id); // lands between verify and touch
    touchLastUsed(store, record.id);
    expect(listTokens(store)[0]!.revoked).toBeTruthy();
    expect(verifyToken(store, token).ok).toBe(false);
  });
});

describe("store files", () => {
  test("token store is 0600", () => {
    const store = storeIn(tmp());
    mintToken(store, "/vault", "x", ["inbox:write"]);
    expect(statSync(store).mode & 0o777).toBe(0o600);
  });

  // The plugin's bb.sh reads this file in POSIX sh (awk over the shape
  // JSON.stringify(…, null, 2) writes), so the store's CONTENT is the
  // contract, not an accessor.
  test("client tokens round-trip, keyed by url, 0600", () => {
    const path = join(tmp(), "client-tokens.json");
    saveClientToken("https://a.example.com", "bb_aaaaaaaa_secret", "laptop", path);
    saveClientToken("https://b.example.com", "bb_bbbbbbbb_secret", "laptop", path);
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, { token: string }>;
    expect(stored["https://a.example.com"]!.token).toBe("bb_aaaaaaaa_secret");
    expect(stored["https://b.example.com"]!.token).toBe("bb_bbbbbbbb_secret");
    expect(stored["https://c.example.com"]).toBeUndefined();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
