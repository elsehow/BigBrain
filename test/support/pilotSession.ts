/** Scripted provider boundary for application tests. The real Pi SDK owns the
 * agent loop, tools, persistence and cancellation; no provider network is used.
 * Legacy response-shaped fixture scripts are decoded here, never in production. */
import { PilotChats as ProductionPilotChats } from "../../lib/pilotChat";
export { pilotChatTools, pilotInstructions, PILOT_INSTRUCTIONS } from "../../lib/pilotChat";
import * as pi from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { PiSession, type PiSDK } from "../../lib/run/piSession";
import { monitoredSession } from "../../lib/run/monitor";
import type { PilotBackendFactory } from "../../lib/pilotBackend";
import { join } from "node:path";

export function scriptedPilot(script: typeof fetch): PilotBackendFactory {
  return setup => {
    const load = async () => {
      const credentials = new InMemoryCredentialStore(), provider = setup.config.provider!;
      await credentials.modify(provider, async () => provider === "openai-codex" || provider === "anthropic"
        ? { type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 3600_000 }
        : { type: "api_key", key: "fixture" });
      const runtime = await pi.ModelRuntime.create({ credentials, modelsPath: null, modelsStorePath: join(setup.root, "fixture-models.json"), allowModelNetwork: false });
      const base = runtime.getModels(provider).find(m => m.reasoning) ?? runtime.getModels(provider)[0]!;
      const model = { ...base, id: setup.config.model };
      runtime.getModel = () => model;
      runtime.getAvailable = async () => [model];
      runtime.streamSimple = (m, context, options) => {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = { role: "assistant", api: m.api, provider: m.provider, model: m.id,
          content: [], stopReason: "stop", timestamp: Date.now(),
          usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        void (async () => {
          try {
            if (script === globalThis.fetch) throw new Error("Unscripted test model request");
            // Pi folds the prompt and tools into system messages; a provider sends them apart from the input.
            const input = context.messages.filter(v => v.role !== "system").map(v => v.role === "toolResult" ? { type: "function_call_output", call_id: v.toolCallId, output: v.content.filter(c => c.type === "text").map(c => c.text).join("\n") } : v);
            const auth = await runtime.getAuth(m, { signal: options?.signal });
            const response = await script("https://fixture.invalid", { signal: options?.signal, headers: { authorization: `Bearer ${auth?.auth.apiKey}` },
              body: JSON.stringify({ model: m.id, instructions: getCurrentSystemPrompt(context.messages) + "\n" + context.messages.filter(v => v.role === "user").flatMap(v => typeof v.content === "string" ? [v.content] : v.content.filter(c => c.type === "text").map(c => c.text)).join("\n"), input, tools: getCurrentTools(context.messages), reasoning: { effort: setup.config.reasoning } }) });
            if (!response.ok) throw new Error("The model refused the request.");
            const events = (await response.text()).split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5)));
            const completed = events.find(e => e.type === "response.completed");
            if (!completed) throw new Error("The model response was incomplete.");
            message.content = completed.response.output.flatMap((v: any) => v.type === "function_call"
              ? [{ type: "toolCall", id: v.call_id, name: v.name, arguments: JSON.parse(v.arguments) }]
              : v.type === "message" ? (v.content ?? []).filter((c: any) => c.text).map((c: any) => ({ type: "text", text: c.text })) : []);
            message.stopReason = message.content.some(c => c.type === "toolCall") ? "toolUse" : "stop";
            stream.push({ type: "start", partial: message });
            for (const event of events) if (event.type === "response.output_text.delta") stream.push({ type: "text_delta", contentIndex: 0, delta: event.delta, partial: message });
            stream.push({ type: "done", reason: message.stopReason, message });
          } catch (error) {
            message.stopReason = "error"; message.errorMessage = error instanceof Error ? error.message : "Fixture failed";
            stream.push({ type: "error", reason: "error", error: message });
          }
        })();
        return stream;
      };
      return { ...pi, ModelRuntime: { create: async () => runtime } } as unknown as PiSDK;
    };
    return monitoredSession(new PiSession(setup, load, true, async () => []), setup, "pilot");
  };
}

export class PilotChats extends ProductionPilotChats {
  constructor(root: string, options: ConstructorParameters<typeof ProductionPilotChats>[1] & { fetch?: typeof fetch } = {}) {
    const { fetch: script, ...rest } = options;
    super(root, { ...rest, backend: rest.backend ?? scriptedPilot(script ?? globalThis.fetch) });
  }
}
