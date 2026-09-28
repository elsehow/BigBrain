import { describe, expect, test } from "bun:test";
import { friendlyImapError, probeInbox } from "../lib/imapProbe";

describe("friendlyImapError — the row's words", () => {
  test("maps the failures a person can act on", () => {
    expect(friendlyImapError(Object.assign(new Error("Command failed"), { authenticationFailed: true }))).toBe("password rejected");
    expect(friendlyImapError(Object.assign(new Error("x"), { responseText: "[AUTHENTICATIONFAILED] Invalid credentials" }))).toBe("password rejected");
    expect(friendlyImapError(Object.assign(new Error("getaddrinfo ENOTFOUND imap.google.com"), { code: "ENOTFOUND" }))).toBe("host not found");
    expect(friendlyImapError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe("connection refused");
    expect(friendlyImapError(new Error("Socket timed out"))).toBe("no answer from host");
    expect(friendlyImapError(new Error("something odd\nsecond line"))).toBe("something odd");
    expect(friendlyImapError("")).toBe("connection failed");
  });
});

describe("probeInbox — one login, bounded", () => {
  test("a host that does not exist answers in the row's words, quickly", async () => {
    const t0 = Date.now();
    await expect(probeInbox({ address: "a@example.com", host: "imap.does-not-exist.invalid", password: "x" }, 5_000)).rejects.toThrow(/host not found|no answer from host/u);
    expect(Date.now() - t0).toBeLessThan(6_000);
  });
});
