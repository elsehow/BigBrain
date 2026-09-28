import { anthropicQuota, type AnthropicQuota } from "./anthropicQuota";
/** Pi supplies the agent loop and provider auth. BigBrain supplies every tool,
 * including sandboxed execution; Pi's unrestricted built-ins never run here. */
import { createCatalogRuntime, exactCatalogModel } from "./modelCatalogRefresh";
import { configureVaultModelAuth } from "./piModelRuntime";
import { connectionProblem, resolveModel, type ModelExecution } from "../modelResolution";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { ModelSessionSetup } from "./session";
import type { ModelSession, ModelSessionTurn } from "./session";
import { sessionRuntimeDirectory, sessionImages } from "./sessionResources";
import { usageSample } from "./monitor";
import { chatgptAccount, chatgptAccountHash, readChatgptQuota, type QuotaReader } from "./chatgptQuota";

export type PiSDK = typeof import("@earendil-works/pi-coding-agent");
export const loadPi = () => import("@earendil-works/pi-coding-agent");
export class PiSession implements ModelSession {
  transport: "subscription" | "api" = "api";
  execution?: ModelExecution;
  accountId?: string;
  private quotaToken?: string;
  private quotaProvider?: string;
  broken = false;
  private ready?: Promise<boolean>;
  private session?: AgentSession;
  private active?: ModelSessionTurn;
  private fresh = true;
  private unsubscribe?: () => void;
  private controller = new AbortController();
  get sessionId(): string | undefined { return this.session?.sessionId; }
  constructor(private setup: ModelSessionSetup, private load: () => Promise<PiSDK> = loadPi, private requireText = true, private readQuota: QuotaReader = readChatgptQuota, private claudeQuota: AnthropicQuota = anthropicQuota) {}
  prepare(): Promise<boolean> {
    return this.ready ??= this.start().catch(error => { this.close(); throw error; });
  }
  private async start(): Promise<boolean> {
    const sdk = await this.load();
    if (this.broken) return false;
    const provider = this.setup.config.provider!;
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)]);
    const runtime = await createCatalogRuntime(sdk, signal);
    await configureVaultModelAuth(runtime, this.setup.root);
    const model = await exactCatalogModel(runtime, provider, this.setup.config.model, signal);
    if (!model) throw new Error(runtime.getProvider(provider) ? "Choose an available model from Settings > Models." : connectionProblem(this.setup.config));
    this.transport = runtime.isUsingSubscription(provider) ? "subscription" : "api";
    if (provider === "anthropic" && this.transport !== "subscription")
      throw new Error("Connect your Claude subscription in Settings > Models. API billing is not used for this connection.");
    const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai/compat");
    this.execution = resolveModel(this.setup.config, this.setup.role ?? "pilot", {
      available: !!model && (await runtime.getAvailable(provider, { signal })).some(m => m.id === model.id),
      transport: this.transport, reasoning: model ? getSupportedThinkingLevels(model) : [],
      modelCapabilities: (model as (typeof model & { capabilities?: Partial<import("../modelChoice").ModelCapabilities> }))?.capabilities,
    });
    if (this.setup.output?.maxBudgetUsd !== undefined && !this.execution.capabilities.budget)
      throw new Error("Pi cannot enforce a hard API dollar budget. Use a subscription or a runtime with budget support.");
    if (this.setup.output?.maxTokens && model.api === "openai-codex-responses")
      throw new Error("ChatGPT subscription transport cannot enforce a hard output-token limit. Use maxCharacters for a host-enforced output bound.");
    const cwd = sessionRuntimeDirectory(this.setup);
    const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, enableAnalytics: false, enableInstallTelemetry: false });
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: this.setup.instructions });
    await resourceLoader.reload();
    if (this.broken) return false;
    const saved = this.setup.state.piSession;
    if (saved && (dirname(resolve(saved)) !== resolve(cwd) || !existsSync(saved)))
      throw new Error("The saved Pi conversation is unavailable. Select the backend again in a new Pilot session.");
    this.fresh = !saved;
    const sessionManager = saved ? sdk.SessionManager.open(saved, cwd, cwd) : sdk.SessionManager.create(cwd, cwd);
    const customTools: NonNullable<CreateAgentSessionOptions["customTools"]> = this.setup.tools.map(t => ({
      name: t.name, label: t.name, description: t.description,
      parameters: t.parameters as NonNullable<CreateAgentSessionOptions["customTools"]>[number]["parameters"],
      executionMode: "sequential",
      execute: async (_id, input, signal) => {
        signal?.throwIfAborted();
        const active = this.active;
        if (!active || this.broken) throw new Error("Pilot tool call has no active turn.");
        active.signal.throwIfAborted();
        this.saveSession();
        const result = await active.tool(t.name, input as Record<string, unknown>);
        active.signal.throwIfAborted();
        return { content: [{ type: "text", text: JSON.stringify(result) ?? "null" }], details: {} };
      },
    }));
    const result = await sdk.createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime, model,
      // Quick should start answering immediately; Pi clamps this default to the
      // model's supported levels. Explicit saved reasoning always wins.
      thinkingLevel: (this.setup.config.reasoning ?? (this.setup.role === "quick" ? "off" : undefined)) as CreateAgentSessionOptions["thinkingLevel"],
      resourceLoader, settingsManager, sessionManager, tools: customTools.map(t => t.name), customTools });
    if (this.broken) { result.session.dispose(); return false; }
    if (result.modelFallbackMessage || result.session.model?.id !== model.id || result.session.model?.provider !== provider) {
      result.session.dispose(); throw new Error("Pi could not apply the selected model; no fallback was used.");
    }
    this.session = result.session;
    const maxTokens = this.setup.output?.maxTokens ?? (model.api === "openai-codex-responses" ? undefined : this.setup.output?.maxTokensHint);
    const stream = this.session.agent.streamFunction;
    this.session.agent.streamFunction = async (model, context, options) => {
      const active = this.active;
      await configureVaultModelAuth(runtime, this.setup.root);
      const started = performance.now();
      if (model.provider === "anthropic" && (await runtime.checkAuth("anthropic", { signal: options?.signal }))?.type !== "oauth")
        throw new Error("Reconnect your Claude subscription in Settings > Models. API billing is not used for this connection.");
      let token: string | undefined;
      if (this.transport === "subscription" && ["openai-codex", "anthropic"].includes(model.provider)) {
        const auth = await runtime.getAuth(model, { signal: options?.signal, apiKey: options?.apiKey });
        token = auth?.auth.apiKey;
        if (model.provider === "anthropic") this.accountId = token ? await this.claudeQuota.account(token, options?.signal ?? this.controller.signal) : undefined;
        else { const account = chatgptAccount(token); this.accountId = account ? chatgptAccountHash(account) : undefined; }
        this.quotaToken = this.accountId ? token : undefined;
        this.quotaProvider = model.provider;
      }
      const accountId = this.accountId ?? null;
      const id = crypto.randomUUID();
      const response = await stream(model, context, { ...options, ...(token ? { apiKey: token } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}) });
      // The stream result resolves once per request, including errors/aborts
      // and SDK compaction requests. Message events can repeat or omit those.
      void response.result().then(message => {
        active?.event?.("apiRequest", { durationMs: performance.now() - started });
        active?.observe?.({ ...usageSample(id, message.model ?? model.id, message.usage, "pi"), accountId });
      }).catch(() => {});
      return response;
    };
    return true;
  }
  async turn(args: ModelSessionTurn): Promise<string | null> {
    if (this.active) throw new Error("Pilot is already working.");
    this.active = args;
    let text = "", failure: string | undefined;
    const abort = () => { void this.session?.abort().catch(() => this.close()); };
    args.signal.addEventListener("abort", abort, { once: true });
    try {
      args.signal.throwIfAborted();
      if (!await this.prepare() || !this.session || this.broken) return null;
      args.signal.throwIfAborted();
      const session = this.session;
      this.unsubscribe = session.subscribe(event => {
        if (!args.signal.aborted && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") args.delta(event.assistantMessageEvent.delta);
        if (event.type === "message_end" && event.message.role === "assistant") {
          this.saveSession();
          const message = event.message;
          if (args.signal.aborted) return;
          if (message.stopReason === "error" || message.stopReason === "aborted") failure = message.errorMessage ?? "Pi could not complete the turn.";
          const content = message.content.filter(b => b.type === "text").map(b => b.text).join("");
          if (content) { text = content; args.event?.("assistantMessage", { id: crypto.randomUUID(), text: content }); }
          args.event?.("usage", message.usage);
        }
      });
      const input = args.input(this.fresh);
      const images = sessionImages(args.images?.(this.fresh)).map(i => ({ type: "image" as const, mimeType: i.mime, data: i.data }));
      args.connected(); args.event?.("ready", { fresh: this.fresh }); args.dispatched?.(); args.event?.("dispatch");
      await session.prompt(input, { images, expandPromptTemplates: false });
      args.signal.throwIfAborted();
      if (failure) throw new Error(failure);
      if (!text && (this.setup.requireText ?? this.requireText)) throw new Error("Pilot completed without an answer.");
      return text;
    } finally {
      const token = this.quotaToken;
      this.quotaToken = undefined;
      if (token && !args.signal.aborted) {
        // Observations must never change the success/failure of model work.
        try { for (const sample of await (this.quotaProvider === "anthropic" ? this.claudeQuota.read(token, args.signal) : this.readQuota(token, args.signal))) args.observe?.(sample); } catch { /* unavailable */ }
      }
      this.unsubscribe?.(); this.unsubscribe = undefined;
      this.saveSession();
      this.active = undefined;
      args.signal.removeEventListener("abort", abort);
    }
  }
  private saveSession(): void {
    const file = this.session?.sessionFile;
    if (file && existsSync(file)) { this.setup.state.piSession = file; this.fresh = false; this.setup.save(); }
  }
  close(): void {
    this.broken = true;
    this.controller.abort();
    this.unsubscribe?.();
    const session = this.session;
    if (session) void session.abort().finally(() => session.dispose()).catch(() => {});
  }
}
