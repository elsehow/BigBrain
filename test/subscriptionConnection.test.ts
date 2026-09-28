import { expect, test } from "bun:test";
import { SUBSCRIPTION_PROVIDERS, type SubscriptionProvider } from "../lib/providerConnection";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { SubscriptionConnection, saveSubscriptionConnection, subscriptionConnected } from "../lib/subscriptionConnection";
import { gitVault } from "./support/vault";
import { readEnvValues, writeEnvValues } from "../lib/envFile";
import { loadManifest } from "../lib/manifest";
import { applyConfig } from "../lib/config";
import { rmSync } from "node:fs";
import { readMemoryStamp } from "../lib/memory";

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const providers = ["chatgpt", "anthropic"] as const;
const authOrigin = (provider: SubscriptionProvider) => provider === "chatgpt" ? "https://auth.openai.com" : "https://claude.ai";
const callbackUrl = (provider: SubscriptionProvider) => provider === "chatgpt" ? "http://localhost:1455/auth/callback" : "http://localhost:53692/callback";
function fixture(provider: SubscriptionProvider) {
  let interaction!: AuthInteraction, complete!: () => void, calls = 0, finishes = 0;
  const connection = new SubscriptionConnection(provider, {
    connected: () => false,
    runtime: async () => ({ login: async (_provider, _type, i) => {
      expect(_provider).toBe(SUBSCRIPTION_PROVIDERS[provider].providerId);
      expect(_type).toBe("oauth");
      calls++; interaction = i;
      expect(await i.prompt({ type: "select", message: "Login method", options: [{ id: "browser", label: "Browser" }] })).toBe("browser");
      i.notify({ type: "auth_url", url: `${authOrigin(provider)}/oauth/authorize?state=fixture` });
      await new Promise<void>((resolve, reject) => {
        complete = resolve;
        i.signal!.addEventListener("abort", () => reject(new Error("secret must not reach browser")), { once: true });
      });
      return { type: "oauth" as const, access: "secret-access", refresh: "secret-refresh", expires: Date.now() + 3600_000 };
    } }),
    finish: async (_root, signal) => { signal.throwIfAborted(); finishes++; },
  });
  return { connection, interaction: () => interaction, complete: () => complete(), calls: () => calls, finishes: () => finishes };
}
test.each(providers)("one browser flow survives repeat clicks and exposes no credentials (%s)", async provider => {
  const f = fixture(provider);
  expect(f.connection.start("vault").phase).toBe("starting");
  await tick();
  expect(f.connection.start("vault").phase).toBe("browser");
  expect(f.calls()).toBe(1);
  expect(() => f.connection.start("other-vault")).toThrow("other vault");
  expect(f.connection.status("other-vault").url).toBeUndefined();
  f.complete(); await tick();
  expect(f.finishes()).toBe(1);
  expect(f.connection.status("vault")).toEqual({ phase: "connected", connected: true });
  expect(JSON.stringify(f.connection.status("vault"))).not.toContain("secret");
});
test.each(providers)("cancelling sign-in prevents setup changes and permits a new attempt (%s)", async provider => {
  const f = fixture(provider); f.connection.start("vault"); await tick();
  await f.connection.cancel("other-vault");
  expect(f.connection.status("vault").phase).toBe("browser");
  await f.connection.cancel("vault");
  expect(f.finishes()).toBe(0);
  expect(f.connection.status("vault")).toEqual({ phase: "idle", connected: false });
  f.connection.start("vault"); await tick(); f.complete(); await tick();
  expect(f.calls()).toBe(2); expect(f.finishes()).toBe(1);
});
test.each(providers)("callback fallback requires the full URL and state, and is cancelled by browser success (%s)", async provider => {
  const f = fixture(provider); f.connection.start("vault"); await tick();
  const abort = new AbortController();
  const prompt = f.interaction().prompt({ type: "manual_code", message: "Paste callback", signal: abort.signal });
  expect(() => f.connection.answer("vault", "bare-code")).toThrow();
  expect(() => f.connection.answer("vault", `${callbackUrl(provider)}?code=fixture`)).toThrow();
  expect(() => f.connection.answer("other", `${callbackUrl(provider)}?code=fixture&state=fixture`)).toThrow();
  const url = `${callbackUrl(provider)}?code=fixture&state=fixture`;
  expect(() => f.connection.answer("vault", `${callbackUrl(provider)}?code=fixture&state=wrong`)).toThrow();
  const other = callbackUrl(provider === "chatgpt" ? "anthropic" : "chatgpt");
  expect(() => f.connection.answer("vault", `${other}?code=fixture&state=fixture`)).toThrow();
  f.connection.answer("vault", url); expect(await prompt).toBe(url);
  const next = f.interaction().prompt({ type: "manual_code", message: "Paste callback", signal: abort.signal });
  abort.abort(); await expect(next).rejects.toThrow("cancelled");
  expect(f.connection.status("vault").manualCode).toBeUndefined();
  f.complete(); await tick();
});
test.each(providers)("errors and unexpected OAuth hosts are never returned verbatim (%s)", async provider => {
  for (const fail of ["provider", "host", "finish"]) {
    const connection = new SubscriptionConnection(provider, { connected: () => false,
      runtime: async () => ({ login: async (_p, _t, i) => {
        if (fail === "provider") throw new Error("secret-refresh-token");
        i.notify({ type: "auth_url", url: fail === "host" ? "https://example.com/steal" : `${authOrigin(provider)}/oauth/authorize` });
        return { type: "oauth", access: "secret", refresh: "secret", expires: 123 };
      } }), finish: async () => { throw new Error("secret-access-token"); },
    });
    connection.start("vault"); await tick();
    expect(connection.status("vault").phase).toBe("error");
    expect(JSON.stringify(connection.status("vault"))).not.toMatch(/secret|example.com/);
  }
});
test("connection recommends models; reconnect preserves manually pinned selections", async () => {
  const root = gitVault({ files: { "vault.yaml": "auth: max\n" } });
  try {
    const models = [{ id: "model-other", label: "Other" }, { id: "model-default", label: "Default", isDefault: true }];
    await saveSubscriptionConnection("chatgpt", root, models, new AbortController().signal, async () => []);
    expect(subscriptionConnected(root, "chatgpt")).toBe(true);
    const firstSweep = readMemoryStamp(root).nextRunAt;
    expect(firstSweep).toBeString();
    expect(loadManifest(root).gardener).toEqual({ adapter: "pi", provider: "openai-codex", model: "model-default" });
    expect(JSON.parse(readEnvValues(root).BIGBRAIN_PILOT_BACKEND!)).toEqual({ adapter: "pi", provider: "openai-codex", model: "model-default" });
    applyConfig({ gardener: { adapter: "pi", provider: "anthropic", model: "claude-sonnet-5" } }, root);
    writeEnvValues(root, { BIGBRAIN_PILOT_BACKEND: JSON.stringify({ adapter: "pi", provider: "anthropic", model: "claude-sonnet-5" }), BIGBRAIN_PILOT_MODEL_PREFERENCE: "pinned" });
    await saveSubscriptionConnection("chatgpt", root, models, new AbortController().signal, async () => []);
    expect(readMemoryStamp(root).nextRunAt).toBe(firstSweep);
    expect(loadManifest(root).gardener).toEqual({ adapter: "pi", provider: "anthropic", model: "claude-sonnet-5" });
    expect(JSON.parse(readEnvValues(root).BIGBRAIN_PILOT_BACKEND!).provider).toBe("anthropic");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("no common model or cancellation leaves setup unfinished", async () => {
  const root = gitVault({ files: { "vault.yaml": "auth: max\n" } });
  try {
    const models = [{ id: "model", label: "Model" }];
    await expect(saveSubscriptionConnection("chatgpt", root, [], new AbortController().signal, async () => [])).rejects.toThrow("No ChatGPT model");
    await expect(saveSubscriptionConnection("chatgpt", root, models, AbortSignal.abort(), async () => [])).rejects.toThrow();
    expect(subscriptionConnected(root, "chatgpt")).toBe(false);
    expect(loadManifest(root).curation).toBeUndefined();
    expect(readEnvValues(root).BIGBRAIN_PILOT_BACKEND).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("connecting ChatGPT preserves legacy explicit Claude choices", async () => {
  const root = gitVault({ files: { "vault.yaml": "auth: max\ngardener: { agent: claude, model: sonnet }\nmemory: { agent: claude, model: opus }\nquick: { agent: claude, model: haiku }\n" } });
  try {
    writeEnvValues(root, { BIGBRAIN_CLAUDE_CONNECTED: "1" });
    const models = [{ id: "model-default", label: "Default", isDefault: true }];
    await saveSubscriptionConnection("chatgpt", root, models, new AbortController().signal, async () => [{ id: "claude", label: "Claude", ready: true, models: [{ id: "opus", label: "Opus" }, { id: "haiku", label: "Haiku" }] }]);
    expect(loadManifest(root).gardener).toEqual({ adapter: "pi", provider: "anthropic", model: "claude-sonnet-5" });
    expect(loadManifest(root).memory.model).toBe("claude-opus-5");
    expect(loadManifest(root).quick.model).toBe("claude-haiku-4-5");
    expect(loadManifest(root).curation).toBeUndefined();
    expect(subscriptionConnected(root, "chatgpt")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each(providers)("retrying setup after successful login does not repeat OAuth (%s)", async provider => {
  let logins = 0, finishes = 0;
  const connection = new SubscriptionConnection(provider, { connected: () => false,
    runtime: async () => ({ login: async () => {
      logins++;
      return { type: "oauth" as const, access: "secret", refresh: "secret", expires: 123 };
    } }),
    finish: async () => { if (++finishes === 1) throw Error("private failure"); },
  });
  connection.start("vault"); await tick();
  expect(connection.status("vault")).toMatchObject({ phase: "error", retrySetup: true });
  expect(connection.status("vault").problem).toContain("Signed in");
  connection.start("vault"); await tick();
  expect(connection.status("vault")).toEqual({ phase: "connected", connected: true });
  expect(logins).toBe(1);
  expect(finishes).toBe(2);
});


test("connecting Claude configures native Pi models for every recommended role without a CLI", async () => {
  const root = gitVault({ files: { "vault.yaml": "auth: max\n" } });
  try {
    const models = [{ id: "claude-opus-5", label: "Opus" }, { id: "claude-haiku-4-5", label: "Haiku" }];
    await saveSubscriptionConnection("anthropic", root, models, new AbortController().signal, async () => []);
    expect(subscriptionConnected(root, "anthropic")).toBe(true);
    expect(subscriptionConnected(root, "chatgpt")).toBe(false);
    expect(readEnvValues(root).BIGBRAIN_CLAUDE_CONNECTED).toBeUndefined();
    for (const role of ["gardener", "memory", "quick"] as const)
      expect(loadManifest(root)[role]).toMatchObject({ adapter: "pi", provider: "anthropic", model: role === "quick" ? "claude-haiku-4-5" : "claude-opus-5" });
    expect(JSON.parse(readEnvValues(root).BIGBRAIN_PILOT_BACKEND!)).toEqual({ adapter: "pi", provider: "anthropic", model: "claude-opus-5" });
    expect(readMemoryStamp(root).nextRunAt).toBeString();
    applyConfig({ gardener: { adapter: "pi", provider: "anthropic", model: "claude-sonnet-5" } }, root);
    await saveSubscriptionConnection("anthropic", root, models, new AbortController().signal, async () => []);
    expect(loadManifest(root).gardener).toEqual({ adapter: "pi", provider: "anthropic", model: "claude-sonnet-5" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
