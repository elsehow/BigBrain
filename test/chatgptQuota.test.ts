import { expect, test } from "bun:test";
import { chatgptAccount, chatgptAccountHash, quotaWindows, readChatgptQuota } from "../lib/run/chatgptQuota";
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.signature`;
const bucket = { primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 1800000000 }, secondary_window: { used_percent: 35, limit_window_seconds: 604800, reset_at: 1800100000 } };

test("quota uses exactly Pi's account, forbids redirects, and records no credentials", async () => {
  const samples = await readChatgptQuota(token, new AbortController().signal, (async (url, options) => {
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(options!.headers).toEqual({ Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": "fixture-account" });
    expect(options!.redirect).toBe("error");
    return Response.json({ rate_limit: bucket });
  }) as typeof fetch);
  expect(samples.map(s => [s.window, s.used])).toEqual([["five_hour", .2], ["seven_day", .35]]);
  expect(samples.every(s => s.accountId === chatgptAccountHash("fixture-account") && !!s.at)).toBe(true);
  expect(JSON.stringify(samples)).not.toContain("fixture-account");
  expect(JSON.stringify(samples)).not.toContain(token);
});
test("optional quota fails closed on bad auth, malformed data, oversize responses, or cancellation", async () => {
  for (const result of [new Response(null, { status: 401 }), new Response("invalid"), new Response("x".repeat(65537))])
    expect(await readChatgptQuota(token, new AbortController().signal, (async () => result) as typeof fetch)).toEqual([]);
  expect(await readChatgptQuota(token, AbortSignal.abort(), (() => { throw new Error("must not fetch"); }) as unknown as typeof fetch)).toEqual([]);
  expect(await readChatgptQuota(token, new AbortController().signal, (async () => { throw new Error("unavailable"); }) as unknown as typeof fetch)).toEqual([]);
});
test("unknown identity performs no access; multi-bucket windows and invalid observations are explicit", async () => {
  for (const value of [undefined, "not-a-jwt", "a.e30.b"]) expect(chatgptAccount(value)).toBeUndefined();
  expect(await readChatgptQuota("fixture", new AbortController().signal, (() => { throw new Error("must not fetch"); }) as unknown as typeof fetch)).toEqual([]);
  expect(quotaWindows({ rate_limit: bucket, additional_rate_limits: [{ metered_feature: "other", rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 3600, reset_at: 1800000000 } } }] }).map(q => q.window)).toEqual(["five_hour", "seven_day", "other_60_minutes"]);
  for (const used_percent of [-1, 101, NaN, "20"])
    expect(quotaWindows({ rate_limit: { primary_window: { used_percent, reset_at: 1800000000 } } })).toEqual([]);
});
