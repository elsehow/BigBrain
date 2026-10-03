/**
 * bigbrain agent — run a desktop's agent on your projects from a terminal.
 *
 *   bigbrain agent run [--desktop <id>] [--model <provider>/<model>] "<task>"
 *   bigbrain agent resume <id>
 *   bigbrain agent list
 *   bigbrain agent discard <id> <project>
 *
 * The agent runs in packages/agents: it works in ~/bigbrain/desktops/<id>/,
 * forking a project from ~/bigbrain/projects/ the first time it changes it
 * (docs/design/coding-desktops.md). This entry point is the host: it builds
 * the model runtime from the vault's model connections and keeps the
 * credentials; the package never sees them.
 *
 * After each turn you can type another message; while the agent works,
 * a message steers it. Ctrl-D (or /done) stops the desktop's processes and
 * leaves its files where they are.
 */
import { createInterface } from "node:readline";
import { Agents, type Desktop, type Stamped } from "../packages/agents/src";
import { requireVaultRoot } from "../lib/engine";
import { DEFAULT_PILOT_BACKEND } from "../lib/pilotBackendTypes";
import { createCatalogRuntime, exactCatalogModel } from "../lib/run/modelCatalogRefresh";
import { configureVaultModelAuth } from "../lib/run/piModelRuntime";
import { exactModel, loadPi } from "../lib/run/piSession";

const INSTRUCTIONS = `You are an agent on your person's BigBrain desktop, working on their code with them.
Be direct and concise. Read before you change things, run the project's own tests after changing it, and say plainly what you did and what you didn't verify.`;

const dim = (s: string) => process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s;
const say = (s: string) => process.stdout.write(s);

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

async function host(modelFlag?: string) {
  const root = requireVaultRoot();
  const sdk = await loadPi();
  const signal = AbortSignal.timeout(20_000);
  const runtime = await createCatalogRuntime(sdk, signal, root);
  const [provider, id] = modelFlag ? modelFlag.split("/", 2) as [string, string] : [DEFAULT_PILOT_BACKEND.provider!, DEFAULT_PILOT_BACKEND.model];
  const model = await exactCatalogModel(runtime, provider, id, signal);
  if (!model) throw new Error(`No model ${provider}/${id}. Choose one in Settings › Models, or pass --model <provider>/<model>.`);
  const subscription = runtime.isUsingSubscription(provider);
  return {
    modelRuntime: runtime, model, instructions: INSTRUCTIONS,
    thinkingLevel: (DEFAULT_PILOT_BACKEND.reasoning ?? "low") as never,
    // Credentials stay here: each request gets the vault's key or subscription token.
    wrapStream: (stream: Parameters<NonNullable<import("../packages/agents/src").OpenOptions["wrapStream"]>>[0]) =>
      (async (m, context, options) => {
        await configureVaultModelAuth(runtime, root);
        if (m.provider === "anthropic" && (await runtime.checkAuth("anthropic", { signal: options?.signal }))?.type !== "oauth")
          throw new Error("Connect your Claude subscription in Settings › Models. API billing is not used for this connection.");
        let token: string | undefined;
        if (subscription && ["openai-codex", "anthropic"].includes(m.provider))
          token = (await runtime.getAuth(m, { signal: options?.signal, apiKey: options?.apiKey }))?.auth.apiKey;
        return stream(exactModel(m), context, { ...options, ...(token ? { apiKey: token } : {}) });
      }) as typeof stream,
  };
}

/** Print a desktop's events as they happen: text streams; activity is one dim line each. */
function narrate(desktop: Desktop): () => void {
  let midLine = false;
  const line = (s: string) => { if (midLine) say("\n"); midLine = false; say(s + "\n"); };
  return desktop.events.subscribe((e: Stamped) => {
    switch (e.type) {
      case "message.delta": say(e.text); midLine = !e.text.endsWith("\n"); break;
      case "message.done": if (midLine) { say("\n"); midLine = false; } break;
      case "tool.end": line(dim(`  ${e.ok ? "·" : "×"} ${e.label}`)); break;
      case "project.forked": line(dim(`  ⑂ forked ${e.project} → ${e.path} (${e.branch}, ${(e.ms / 1000).toFixed(1)}s)`)); break;
      case "server.started": line(`  ▸ http://127.0.0.1:${e.port}  (job ${e.job}: ${e.command})`); break;
      case "server.exited": line(dim(`  ▪ job ${e.job} exited (${e.code})`)); break;
      case "homecopy.changed": line(`  ! your home copy of ${e.project} changed (${e.files} files differ from its last commit)`); break;
      case "error": line(`  error: ${e.message}`); break;
    }
  });
}

async function summary(desktop: Desktop): Promise<void> {
  const changes = await desktop.changes();
  const servers = await desktop.servers();
  if (!changes.length && !servers.length) return;
  say(dim("\n— desktop " + desktop.id + "\n"));
  for (const c of changes) say(dim(`  ${c.project}: ${c.commits} commit${c.commits === 1 ? "" : "s"} on ${c.branch}, ${c.dirty} uncommitted file${c.dirty === 1 ? "" : "s"}${c.stat ? ` (${c.stat})` : ""}\n`));
  for (const s of servers) say(dim(`  running: http://127.0.0.1:${s.port}${s.command ? `  ${s.command}` : ""}\n`));
}

async function converse(agents: Agents, id: string, modelFlag: string | undefined, first?: string): Promise<void> {
  const desktop = await agents.open(id, await host(modelFlag));
  const stop = narrate(desktop);
  say(dim(`desktop ${id} · folder ${desktop.folder}\n`));
  let turn: Promise<void> | undefined;
  const start = (text: string) => {
    turn = desktop.send(text).finally(async () => { turn = undefined; await summary(desktop); if (process.stdin.isTTY) say("> "); });
  };
  if (first) start(first);
  else say("> ");
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const raw of rl) {
    const text = raw.trim();
    if (!text) continue;
    if (text === "/done") break;
    if (turn) await desktop.steer(text); else start(text);
  }
  if (turn) await turn;
  say(dim("\nStopping this desktop's processes; its files stay.\n"));
  stop();
  await desktop.archive();
}

const args = process.argv.slice(2);
const sub = args.shift();
const agents = new Agents();
try {
  if (sub === "run") {
    const desktop = flag(args, "--desktop") ?? `d-${crypto.randomUUID().slice(0, 6)}`;
    const model = flag(args, "--model");
    const task = args.join(" ").trim();
    if (!task) throw new Error('Say what to do: bigbrain agent run "<task>"');
    await converse(agents, desktop, model, task);
  } else if (sub === "resume" && args[0]) {
    await converse(agents, args[0], flag(args, "--model"));
  } else if (sub === "list") {
    const ids = agents.list();
    if (!ids.length) console.log(`No desktops yet. Projects live in ${agents.ws.projects}.`);
    for (const id of ids) {
      const last = agents.events(id).filter(e => e.type === "input").at(-1);
      console.log(`${id}${last && last.type === "input" ? `  — ${last.text.slice(0, 70)}` : ""}`);
    }
  } else if (sub === "discard" && args[0] && args[1]) {
    await agents.discard(args[0], args[1]);
    console.log(`Discarded desktop ${args[0]}'s fork of ${args[1]}.`);
  } else {
    console.log(`usage:
  bigbrain agent run [--desktop <id>] [--model <provider>/<model>] "<task>"
  bigbrain agent resume <id>
  bigbrain agent list
  bigbrain agent discard <id> <project>

Projects live in ${agents.ws.projects}; each desktop works in ${agents.ws.desktops}/<id>/.`);
    process.exitCode = sub ? 1 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
