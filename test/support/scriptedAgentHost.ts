/**
 * scriptedAgentHost.ts — a coding desktop's host with a scripted model, for
 * looking at v2 without a model connection or a real vault.
 *
 * Run a dev engine with BIGBRAIN_DEV=1 and BIGBRAIN_AGENT_SCRIPT pointing
 * here (web/desktopRouteManifest.ts honours it only in dev). The agent:
 * - answers any message, streaming its reply;
 * - when asked to "serve", starts `python3 -m http.server` through its shell,
 *   then shows the page beside the chat with show_page;
 * - when asked to "change" something, starts its own worktree of a project
 *   called orrery and commits a note there, so Land has work to bring home.
 */
import type { OpenOptions } from "../../packages/agents/src";

export default async function scriptedHost(): Promise<OpenOptions> {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } = await import("@earendil-works/pi-ai");
  const faux = fauxProvider({ tokensPerSecond: 60 });
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, authPath: "/dev/null/none" });
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey(faux.provider.id, "invented");
  const text = (m: { content: unknown }) => typeof m.content === "string" ? m.content
    : (m.content as Array<{ type: string; text?: string }>).filter(b => b.type === "text").map(b => b.text ?? "").join("");
  const step = (context: { messages: Array<{ role: string; content: unknown }> }) => {
    const last = context.messages.at(-1)!;
    const asked = text([...context.messages].reverse().find(m => m.role === "user")!);
    if (last.role === "toolResult") {
      const worktree = /Your worktree of orrery is (\S+), on branch/.exec(text(last))?.[1];
      if (worktree) return fauxAssistantMessage([fauxToolCall("bash", { cwd: worktree,
        command: "echo 'A note from a desktop.' >> NOTES.md && git add NOTES.md && git -c user.email=agent@example.invalid -c user.name=agent commit -qm 'Add a note' && git log --oneline -1" })], { stopReason: "toolUse" });
      const port = /127\.0\.0\.1:(\d+)/.exec(text(last))?.[1];
      if (port && !context.messages.some(m => m.role === "toolResult" && text(m).includes("views"))) {
        return fauxAssistantMessage([fauxToolCall("show_page", { url: `http://127.0.0.1:${port}/`, title: "Your folder, served" })], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("It's running, and it's beside this chat. Ask me to stop it whenever you like.");
    }
    if (/change/i.test(asked) && last.role === "user") {
      return fauxAssistantMessage([fauxText("Starting my own worktree of orrery for this."), fauxToolCall("start_work", { project: "orrery" })], { stopReason: "toolUse" });
    }
    if (/serve/i.test(asked)) {
      return fauxAssistantMessage([fauxText("Starting a server in your folder."), fauxToolCall("bash", { command: "python3 -m http.server 0 --bind 127.0.0.1" })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(`I'm a scripted agent for trying the desktop. You said: "${asked}". Ask me to serve something to see a page appear beside the chat.`);
  };
  faux.setResponses(Array.from({ length: 200 }, () => step as never));
  return { modelRuntime: runtime, model: faux.getModel() as never, instructions: "You are a scripted test agent.", tools: [] };
}
