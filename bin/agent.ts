/**
 * bigbrain agent — run a desktop's agent on your projects from a terminal.
 *
 *   bigbrain agent run [--desktop <id>] [--model <provider>/<model>] "<task>"
 *   bigbrain agent resume <id>
 *   bigbrain agent list
 *   bigbrain agent land <id> <project> [--pr|--branch]
 *   bigbrain agent discard <id> <project>
 *
 * The agent runs in packages/agents: it works in ~/bigbrain/desktops/<id>/,
 * forking a project from ~/bigbrain/projects/ the first time it changes it
 * (docs/design/coding-desktops.md). BigBrain is its host (lib/agentHost.ts):
 * the model from the vault's connections, the vault's read-only tools, and
 * the credentials, which the package never sees.
 *
 * After each turn you can type another message; while the agent works,
 * a message steers it. /land <project> brings committed work home (a pull
 * request when the project is on GitHub, otherwise a branch in your home
 * copy). Ctrl-D (or /done) stops the desktop's processes and leaves its
 * files where they are.
 */
import { createInterface } from "node:readline";
import { Agents, type Desktop, type LandHow, type Stamped } from "../packages/agents/src";
import { agentHost } from "../lib/agentHost";
import { requireVaultRoot } from "../lib/engine";

const dim = (s: string) => process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s;
const say = (s: string) => process.stdout.write(s);

function landHow(args: string[]): LandHow {
  return args.includes("--pr") ? "pr" : args.includes("--branch") ? "branch" : "auto";
}
async function land(agents: Agents, id: string, project: string, how: LandHow): Promise<void> {
  const landed = await agents.land(id, project, how);
  say(landed.how === "pr" ? `Opened ${landed.url} from ${landed.branch}.\n`
    : `Fetched ${landed.branch} into ${landed.home}. Merge it there when you're ready: git merge ${landed.branch}\n`);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
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
      case "tool.start": line(dim(`  … ${e.label}`)); break;
      case "work.started": line(dim(`  ⑂ worktree of ${e.project} → ${e.path} (${e.branch}, ${(e.ms / 1000).toFixed(1)}s)`)); break;
      case "server.started": line(`  ▸ http://127.0.0.1:${e.port}  (job ${e.job}: ${e.command})`); break;
      case "server.exited": line(dim(`  ▪ job ${e.job} exited (${e.code})`)); break;
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
  const desktop = await agents.open(id, await agentHost(requireVaultRoot(), modelFlag));
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
    if (text.startsWith("/land")) {
      const words = text.split(/\s+/).slice(1), project = words.find(w => !w.startsWith("--"));
      if (turn) say("Wait for the turn to finish before landing.\n> ");
      else if (!project) say("Say which project: /land <project> [--pr|--branch]\n> ");
      else await land(agents, id, project, landHow(words)).catch(e => say(`${e instanceof Error ? e.message : e}\n`)).finally(() => say("> "));
      continue;
    }
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
  } else if (sub === "land" && args[0] && args[1]) {
    await land(agents, args[0], args[1], landHow(args));
  } else if (sub === "discard" && args[0] && args[1]) {
    await agents.discard(args[0], args[1]);
    console.log(`Discarded desktop ${args[0]}'s fork of ${args[1]}.`);
  } else {
    console.log(`usage:
  bigbrain agent run [--desktop <id>] [--model <provider>/<model>] "<task>"
  bigbrain agent resume <id>
  bigbrain agent list
  bigbrain agent land <id> <project> [--pr|--branch]
  bigbrain agent discard <id> <project>

Projects live in ${agents.ws.projects}; each desktop works in ${agents.ws.desktops}/<id>/.`);
    process.exitCode = sub ? 1 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
