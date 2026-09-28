/** Scripted inference with the actual Pi session, tools, history and cancellation. */
import * as pi from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { PiSDK } from "../../lib/run/piSession";
export type PiLoader = () => Promise<PiSDK>;
export type Options = pi.CreateAgentSessionOptions;
export interface ModelAnswer {
  content?: AssistantMessage["content"];
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}
export function fakePi(answer: (prompt: string, options: Options) => ModelAnswer | Promise<ModelAnswer>): PiLoader {
  return async () => {
    const credentials = new InMemoryCredentialStore();
    for (const provider of ["anthropic", "openai-codex"]) await credentials.modify(provider, async () => ({ type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 3600_000 }));
    const runtime = await pi.ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
    const get = runtime.getModel.bind(runtime);
    let selected: ReturnType<typeof get>;
    runtime.getModel = (provider, id) => selected = get(provider, id) ?? { ...runtime.getModels(provider)[0]!, id };
    runtime.getAvailable = async () => selected ? [selected] : [];
    let setup: Options;
    runtime.streamSimple = (model, context) => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        try {
          const user = context.messages.findLast(m => m.role === "user");
          const prompt = !user ? "" : typeof user.content === "string" ? user.content : user.content.filter(c => c.type === "text").map(c => c.text).join("\n");
          const result = await answer(prompt, setup);
          const u = result.usage;
          message.content = result.content ?? [{ type: "text", text: result.result ?? "" }];
          message.stopReason = message.content.some(c => c.type === "toolCall") ? "toolUse" : "stop";
          message.usage = { input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, cacheRead: u?.cache_read_input_tokens ?? 0, cacheWrite: u?.cache_creation_input_tokens ?? 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: result.total_cost_usd ?? 0 } };
          stream.push({ type: "done", reason: message.stopReason, message });
        } catch (error) {
          message.stopReason = "error"; message.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: "error", reason: "error", error: message });
        }
      })();
      return stream;
    };
    return { ...pi, ModelRuntime: { create: async () => runtime }, createAgentSession: async (options: Options) => { setup = options; return pi.createAgentSession(options); } } as unknown as PiSDK;
  };
}
