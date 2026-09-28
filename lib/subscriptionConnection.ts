import { createCatalogRuntime } from "./run/modelCatalogRefresh";
import { availableDefaults } from "./modelDefaults";
/** Browser sign-in owned by Pi. Only public progress crosses the setup API;
 * credentials remain in Pi's local, locked credential store. */
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readEnvValues, writeEnvValues } from "./envFile";
import { loadPi } from "./run/piSession";
import type { AgentModel } from "./modelCatalog";
import { SUBSCRIPTION_PROVIDERS, type SubscriptionProvider, type SubscriptionStatus } from "./providerConnection";
export type { SubscriptionStatus } from "./providerConnection";

export const subscriptionConnected = (root: string, provider: SubscriptionProvider): boolean =>
  readEnvValues(root)[SUBSCRIPTION_PROVIDERS[provider].connectedKey] === "1";
export const subscriptionRuntime = async (root?: string): Promise<ModelRuntime> =>
  createCatalogRuntime(await loadPi(), AbortSignal.timeout(10_000), root);

const AUTH = {
  chatgpt: { origin: "https://auth.openai.com", callback: "http://localhost:1455/auth/callback" },
  anthropic: { origin: "https://claude.ai", callback: "http://localhost:53692/callback" },
} as const;

type LoginRuntime = Pick<ModelRuntime, "login">;
type Attempt = { root: string; state: SubscriptionStatus; abort: AbortController; done: Promise<void>; answer?: (value: string) => void; finishOnly?: boolean };
export class SubscriptionConnection {
  private attempt?: Attempt;
  constructor(readonly provider: SubscriptionProvider, private deps: {
    runtime: () => Promise<LoginRuntime>;
    finish: (root: string, signal: AbortSignal) => Promise<void>;
    connected: (root: string) => boolean;
  }) {}
  status(root: string): SubscriptionStatus {
    if (this.attempt?.root === root) return { ...this.attempt.state };
    const connected = this.deps.connected(root);
    return { connected, phase: connected ? "connected" : "idle" };
  }
  start(root: string): SubscriptionStatus {
    if (this.attempt && !["connected", "error", "idle"].includes(this.attempt.state.phase)) {
      if (this.attempt.root !== root) throw new Error(`Finish or cancel the ${SUBSCRIPTION_PROVIDERS[this.provider].label} connection in the other vault first.`);
      return this.status(root);
    }
    const finishOnly = this.attempt?.root === root && this.attempt.finishOnly;
    const attempt: Attempt = { finishOnly, root, state: { connected: false, phase: "starting" }, abort: new AbortController(), done: Promise.resolve() };
    this.attempt = attempt;
    const timer = setTimeout(() => attempt.abort.abort(new Error("Sign-in timed out. Try again.")), 10 * 60_000);
    timer.unref?.();
    attempt.done = this.run(attempt).catch((error: unknown) => {
      // Provider errors can contain tokens or response bodies. Never relay them.
      const stage = attempt.state.phase;
      // Log only controlled classifications, never exception messages or credentials.
      const code = (error as { code?: unknown })?.code;
      const knownCode = ["EACCES", "EPERM", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"].includes(String(code)) ? String(code) : "unknown";
      console.warn(`[${this.provider}-connect] failed during ${stage}; code=${knownCode}`);
      attempt.state = { connected: false, phase: "error", retrySetup: stage === "finishing", problem: stage === "finishing"
        ? "Signed in, but BigBrain could not finish setup. Retry setup."
        : stage === "starting" ? "Could not start sign-in. Try again."
        : "BigBrain could not complete the browser sign-in. Try again." };
      attempt.finishOnly = stage === "finishing";
    }).finally(() => { clearTimeout(timer); delete attempt.answer; });
    return this.status(root);
  }
  private async run(attempt: Attempt): Promise<void> {
    const signal = attempt.abort.signal;
    if (attempt.finishOnly) {
      attempt.state = { connected: false, phase: "finishing" };
      await this.deps.finish(attempt.root, signal);
      attempt.state = { connected: true, phase: "connected" };
      return;
    }
    const runtime = await this.deps.runtime();
    signal.throwIfAborted();
    const interaction: AuthInteraction = {
      signal,
      notify: event => {
        signal.throwIfAborted();
        if (event.type === "auth_url") {
          const url = new URL(event.url);
          if (url.origin !== AUTH[this.provider].origin || url.username || url.password) throw new Error("Unexpected sign-in host");
          attempt.state = { connected: false, phase: "browser", url: url.href };
        }
      },
      prompt: async (prompt: AuthPrompt) => {
        signal.throwIfAborted();
        if (prompt.type === "select" && prompt.options.some(o => o.id === "browser")) return "browser";
        if (prompt.type !== "manual_code") throw new Error("Unsupported sign-in prompt");
        const cancelled = AbortSignal.any([signal, ...(prompt.signal ? [prompt.signal] : [])]);
        cancelled.throwIfAborted();
        attempt.state.manualCode = true;
        return new Promise<string>((resolve, reject) => {
          const cleanup = () => { cancelled.removeEventListener("abort", abort); delete attempt.answer; delete attempt.state.manualCode; };
          const abort = () => { cleanup(); reject(new Error("Sign-in cancelled")); };
          attempt.answer = value => { cleanup(); resolve(value); };
          cancelled.addEventListener("abort", abort, { once: true });
        });
      },
    };
    await runtime.login(SUBSCRIPTION_PROVIDERS[this.provider].providerId, "oauth", interaction);
    signal.throwIfAborted();
    attempt.state = { connected: false, phase: "finishing" };
    await this.deps.finish(attempt.root, signal);
    attempt.state = { connected: true, phase: "connected" };
  }
  answer(root: string, value: string): void {
    if (this.attempt?.root !== root || !this.attempt.answer) throw new Error("No sign-in is waiting for a callback.");
    // Require the complete callback, including OAuth state; never accept a
    // bare authorization code that bypasses the provider's state check.
    const url = new URL(value);
    if (`${url.origin}${url.pathname}` !== AUTH[this.provider].callback || url.username || url.password ||
        !url.searchParams.get("state") || !url.searchParams.get("code") ||
        (this.attempt.state.url && url.searchParams.get("state") !== new URL(this.attempt.state.url).searchParams.get("state")))
      throw new Error("Paste the complete callback URL from your browser.");
    this.attempt.answer(url.href);
  }
  async cancel(root: string): Promise<void> {
    const attempt = this.attempt;
    if (!attempt || attempt.root !== root) return;
    attempt.abort.abort();
    await attempt.done;
    if (this.attempt === attempt) this.attempt = undefined;
  }
}

function connection(provider: SubscriptionProvider): SubscriptionConnection {
  const spec = SUBSCRIPTION_PROVIDERS[provider];
  return new SubscriptionConnection(provider, {
    runtime: subscriptionRuntime, connected: root => subscriptionConnected(root, provider),
    finish: async (root, signal) => {
      const runtime = await subscriptionRuntime(root);
      if (!runtime.isUsingSubscription(spec.providerId)) throw new Error("Subscription authentication is required.");
      const available = await runtime.getAvailable(spec.providerId, { signal });
      const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai/compat");
      const models = available.map(m => ({ id: m.id, label: m.name, reasoning: getSupportedThinkingLevels(m) }));
      signal.throwIfAborted();
      await saveSubscriptionConnection(provider, root, models, signal);
    },
  });
}
export const subscriptionConnections = { chatgpt: connection("chatgpt"), anthropic: connection("anthropic") };

/** Commit defaults only after authentication and the Pi model catalog succeed. */
export async function saveSubscriptionConnection(provider: SubscriptionProvider, root: string, models: AgentModel[], signal: AbortSignal, discover = async () => {
  const { setupState } = await import("./firstRun");
  return (await import("./modelCatalog")).curationModels(setupState(root));
}): Promise<void> {
  const { readMemoryStamp, writeMemoryStamp } = await import("./memory");
  const spec = SUBSCRIPTION_PROVIDERS[provider];
  availableDefaults(spec.defaultProvider, models);
  signal.throwIfAborted();
  const agents = await discover();
  signal.throwIfAborted();
  // The just-authenticated catalog is authoritative even before the connected
  // flag or OAuth attempt status has been published.
  const connected = agents.filter(a => a.id !== `pi/${spec.providerId}`);
  connected.push({ id: `pi/${spec.providerId}`, billing: "subscription", label: spec.label, ready: true, models });
  (await import("./modelPreferenceRefresh")).refreshModelPreferences(root, connected);
  writeEnvValues(root, { [spec.connectedKey]: "1" });
  const stamp = readMemoryStamp(root);
  if (!stamp.nextRunAt && !stamp.lastRunAt) writeMemoryStamp(root, { ...stamp, nextRunAt: new Date().toISOString() });
}
