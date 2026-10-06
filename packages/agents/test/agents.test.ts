import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agents, AgentsError, codingTools, commandEnv, discardWork, Harbor, landWork, loginEnv, releaseLeases, scopeOf, startWork, workspace, type ToolContext } from "../src";

const mac = process.platform === "darwin";
const roots: string[] = [];
afterAll(() => roots.forEach(r => rmSync(r, { recursive: true, force: true })));
const sh = (cwd: string, ...args: string[]) => execFileSync(args[0]!, args.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (cwd: string, ...args: string[]) => sh(cwd, "git", "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args);
const harbor = () => new Harbor({ env: process.env, settleMs: 400, waitMs: 4000, graceMs: 500 });
const tool = (ctx: ToolContext, name: string) => codingTools(ctx).find(t => t.name === name)!;
const ctxFor = (ws: ReturnType<typeof workspace>, desktop: string, h = harbor()): ToolContext => ({ ws, desktop, harbor: h, started() {}, server() {} });
const signal = () => new AbortController().signal;

/** A workspace with one invented project in a lived-in state: a tag, another
 * session's worktree, a stash, an uncommitted edit, and ignored dependencies
 * (nested too), a secret and a virtualenv. */
function scene() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agents-ws-")));
  roots.push(root);
  const ws = workspace(root);
  const home = join(ws.projects, "orrery");
  mkdirSync(join(home, "src"), { recursive: true });
  writeFileSync(join(home, "src", "ratios.ts"), "export const moon = 1.25;\n");
  writeFileSync(join(home, ".gitignore"), "node_modules/\n.env\n.venv/\n.claude/\n");
  git(home, "init", "-q", "-b", "main");
  git(home, "add", "-A"); git(home, "commit", "-q", "-m", "seed"); git(home, "tag", "v1");
  git(home, "worktree", "add", "-q", "-b", "side", join(home, ".claude", "worktrees", "side"));
  writeFileSync(join(home, "src", "ratios.ts"), "export const moon = 1.3;\n"); git(home, "stash", "-q");
  writeFileSync(join(home, "src", "ratios.ts"), "export const moon = 1.4;\n");
  for (const dir of ["node_modules/gearlib", "web/node_modules/viewlib"]) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, "node_modules", "gearlib", "index.js"), "module.exports = 42;\n");
  writeFileSync(join(home, "web", "node_modules", "viewlib", "index.js"), "module.exports = 7;\n");
  writeFileSync(join(home, ".env"), "ORRERY_TOKEN=invented\n");
  mkdirSync(join(home, ".venv", "bin"), { recursive: true });
  writeFileSync(join(home, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
  writeFileSync(join(home, ".venv", "bin", "python3"), "#!/bin/sh\necho python\n");
  writeFileSync(join(home, ".venv", "bin", "gearcheck"), `#!${join(home, ".venv", "bin", "python3")}\nprint("check")\n`);
  chmodSync(join(home, ".venv", "bin", "gearcheck"), 0o755);
  return { ws, home };
}

describe("fidelity: the agent sees exactly what the person sees", () => {
  test("git answers through the agent's shell match the person's checkout, and the first command is quick", async () => {
    const { ws, home } = scene();
    const bash = tool(ctxFor(ws, "desk-fid"), "bash");
    for (const command of ["git worktree list --porcelain", "git stash list", "git status --porcelain", "git rev-parse --abbrev-ref HEAD", "git tag", "git branch -a", "git log -1 --format=%H"]) {
      const t0 = Date.now();
      const via = (await bash.run({ command, cwd: "projects/orrery" }, signal())).text.replace(/\n\[exit 0\]$/, "").trim();
      expect({ command, ms: Date.now() - t0 < 2000, out: via }).toEqual({ command, ms: true, out: sh(home, ...command.split(" ")) });
    }
  });
});

describe("the agent's world", () => {
  test("paths stay inside projects/ and the desktop's own worktrees", async () => {
    const { ws } = scene();
    const read = tool(ctxFor(ws, "desk-paths"), "read");
    expect((await read.run({ path: "projects/orrery/src/ratios.ts" }, signal())).text).toContain("1.4");
    await expect(read.run({ path: "/etc/hosts" }, signal())).rejects.toThrow(AgentsError);
    await expect(read.run({ path: "desktops/someone-else/orrery/x" }, signal())).rejects.toThrow(/outside your world/);
    // the host may say what a path it knows is instead
    const hinted = tool({ ...ctxFor(ws, "desk-paths"), elsewhere: p => p.startsWith("notes/") ? `${p} is the host's: use read_note.` : undefined }, "read");
    await expect(hinted.run({ path: "notes/gears.md" }, signal())).rejects.toThrow("notes/gears.md is the host's: use read_note.");
    await expect(hinted.run({ path: "/etc/hosts" }, signal())).rejects.toThrow(/outside your world/);
  });

  test("editing in place takes the project's lease; another desktop is told to start its own worktree", async () => {
    const { ws, home } = scene();
    const editA = tool(ctxFor(ws, "desk-a"), "edit"), editB = tool(ctxFor(ws, "desk-b"), "edit");
    await editA.run({ path: "projects/orrery/src/ratios.ts", old: "1.4", new: "1.45" }, signal());
    expect(readFileSync(join(home, "src", "ratios.ts"), "utf8")).toContain("1.45");
    await expect(editB.run({ path: "projects/orrery/src/ratios.ts", old: "1.45", new: "1.5" }, signal())).rejects.toThrow(/desk-a is editing orrery in place.*start_work/);
    releaseLeases(ws, "desk-a");
    await editB.run({ path: "projects/orrery/src/ratios.ts", old: "1.45", new: "1.5" }, signal());
  });
});

describe("worktrees on request", () => {
  test("start_work: a worktree of the same repo, its dependencies brought, the person's checkout untouched", async () => {
    const { ws, home } = scene();
    const before = sh(home, "git", "status", "--porcelain");
    const t0 = Date.now();
    const work = await startWork(ws, "desk-w", "orrery");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(work.path).toBe(join(ws.desktops, "desk-w", "orrery"));
    expect(sh(work.path, "git", "branch", "--show-current")).toBe("desktop/desk-w");
    // one repo: the person sees the desktop's branch and worktree; the worktree sees theirs
    expect(sh(home, "git", "branch", "--list", "desktop/desk-w")).toContain("desktop/desk-w");
    expect(sh(home, "git", "worktree", "list")).toContain(work.path);
    expect(sh(work.path, "git", "worktree", "list")).toContain(".claude/worktrees/side");
    expect(sh(work.path, "git", "stash", "list")).toBe(sh(home, "git", "stash", "list"));
    // what git ignores but the project needs, nested included
    expect(work.cloned.sort()).toEqual([".env", ".venv", "node_modules", "web/node_modules"]);
    expect(readFileSync(join(work.path, "web", "node_modules", "viewlib", "index.js"), "utf8")).toContain("7");
    if (mac) expect(readFileSync(join(work.path, ".venv", "bin", "gearcheck"), "utf8").split("\n")[0]).toBe(`#!${join(work.path, ".venv", "bin", "python3")}`);
    // the person's checkout: same branch, same uncommitted work
    expect(sh(home, "git", "branch", "--show-current")).toBe("main");
    expect(sh(home, "git", "status", "--porcelain")).toBe(before);
    expect(await startWork(ws, "desk-w", "orrery")).toEqual(work);
  });

  test("land: as a branch it is already home; as a PR it is pushed and opened; empty or uncommitted work is refused", async () => {
    const { ws, home } = scene();
    await expect(landWork(ws, "desk-l", "orrery")).rejects.toThrow(/no work of its own/);
    const work = await startWork(ws, "desk-l", "orrery");
    await expect(landWork(ws, "desk-l", "orrery")).rejects.toThrow(/no commits/);
    writeFileSync(join(work.path, "src", "ratios.ts"), "export const moon = 1.5;\n");
    await expect(landWork(ws, "desk-l", "orrery")).rejects.toThrow(/1 uncommitted file/);
    git(work.path, "commit", "-q", "-am", "Fix the moon ratio");
    expect(await landWork(ws, "desk-l", "orrery", "branch")).toEqual({ how: "branch", branch: "desktop/desk-l", home });
    expect(sh(home, "git", "log", "-1", "--format=%s", "desktop/desk-l")).toBe("Fix the moon ratio");

    const origin = join(ws.root, "origin.git");
    sh(ws.root, "git", "init", "-q", "--bare", origin);
    sh(home, "git", "remote", "add", "origin", origin);
    const bin = join(ws.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), "#!/bin/sh\necho https://example.invalid/orrery/pull/7\n");
    chmodSync(join(bin, "gh"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      expect(await landWork(ws, "desk-l", "orrery", "pr")).toEqual({ how: "pr", branch: "desktop/desk-l", url: "https://example.invalid/orrery/pull/7" });
    } finally { process.env.PATH = path; }
    expect(sh(ws.root, "git", "--git-dir", origin, "rev-parse", "desktop/desk-l")).toBe(sh(work.path, "git", "rev-parse", "HEAD"));
  });

  test("discard removes the worktree and its branch", async () => {
    const { ws, home } = scene();
    const work = await startWork(ws, "desk-d", "orrery");
    await discardWork(ws, "desk-d", "orrery");
    expect(existsSync(work.path)).toBe(false);
    expect(sh(home, "git", "branch", "--list", "desktop/desk-d")).toBe("");
  });
});

describe.if(mac)("harbor", () => {
  const h = harbor();
  const server = (port = 0, stubborn = false) =>
    `node -e "${stubborn ? "process.on('SIGTERM',()=>{});" : ""}require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1')"`;

  test("commands carry the desktop's tag and none of the host's own BigBrain settings", async () => {
    const env = commandEnv({ PATH: "/bin", BIGBRAIN_DESKTOP: "1", BIGBRAIN_VAULT: "/somewhere/vault", HOME: "/home/x" }, "desk-env");
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/x", BIGBRAIN_AGENT_DESKTOP: "desk-env" });
    const r = await new Harbor({ env: { PATH: process.env.PATH, BIGBRAIN_DESKTOP: "1" } }).run("desk-env", "echo app=$BIGBRAIN_DESKTOP tag=$BIGBRAIN_AGENT_DESKTOP", tmpdir());
    expect(r.output.trim()).toBe("app= tag=desk-env");
  });

  test("a short command returns its output and exit code", async () => {
    const r = await h.run("desk-h", "echo gears; exit 3", tmpdir());
    expect(r.status === "exited" && r.code === 3 && r.output.includes("gears")).toBe(true);
  });

  test("a server returns once it listens, is found by its desktop's tag, and a stubborn one is still stopped", async () => {
    const r = await h.run("desk-h", server(0, true), tmpdir());
    expect(r.status).toBe("running");
    const port = r.status === "running" ? r.ports[0]! : 0;
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
    expect((await h.servers("desk-h")).map(s => s.port)).toContain(port);
    expect(await h.holder(port)).toBe("desk-h");
    expect(await h.stopDesktop("desk-h")).toBeGreaterThan(0);
    expect((await h.servers("desk-h")).length).toBe(0);
  });

  test("discovery works with an app's thin PATH, which lacks /usr/sbin where lsof lives", async () => {
    const path = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try { expect(Array.isArray(await h.servers("desk-thin"))).toBe(true); }
    finally { process.env.PATH = path; }
  });

  test("two engines on one machine never sweep each other's processes", async () => {
    const a = new Harbor({ env: process.env, scope: scopeOf("/workspace/a"), settleMs: 400, graceMs: 500 });
    const b = new Harbor({ env: process.env, scope: scopeOf("/workspace/b"), settleMs: 400, graceMs: 500 });
    const r = await a.run("desk-same", server(0), tmpdir());
    const port = r.status === "running" ? r.ports[0]! : 0;
    expect(port).toBeGreaterThan(0);
    // b restarts and sweeps; it stops only its own workspace's processes
    expect(await b.stopAll()).toBe(0);
    expect(await b.stopDesktop("desk-same")).toBe(0);
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
    expect((await a.servers("desk-same")).map(x => x.port)).toContain(port);
    expect(await a.stopAll()).toBeGreaterThan(0);
  });

  test("a fixed-port collision names the desktop holding the port", async () => {
    const { ws } = scene();
    const first = await h.run("desk-a", server(0), tmpdir());
    const port = first.status === "running" ? first.ports[0]! : 0;
    const r = await tool(ctxFor(ws, "desk-b", h), "bash").run({ command: server(port) }, signal());
    expect(r.ok).toBe(false);
    expect(r.text).toContain(`Port ${port} is in use by desktop desk-a`);
    await h.stopDesktop("desk-a");
  });

  test("the base environment is the person's login shell's", async () => {
    const fake = join(mkdtempSync(join(tmpdir(), "shell-")), "fakesh");
    roots.push(join(fake, ".."));
    writeFileSync(fake, "#!/bin/sh\nprintf 'PATH=/opt/tools/bin\\0ORRERY_HOME=/opt/orrery\\0'\n");
    chmodSync(fake, 0o755);
    const shell = process.env.SHELL;
    process.env.SHELL = fake;
    try { expect(await loginEnv()).toMatchObject({ PATH: "/opt/tools/bin", ORRERY_HOME: "/opt/orrery" }); }
    finally { process.env.SHELL = shell; }
  });
});

describe("a desktop's agent", () => {
  test("it answers a question in place, then starts its own worktree for a change; every step is an event", async () => {
    const { ws, home } = scene();
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
    const faux = fauxProvider();
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, authPath: join(ws.root, "auth.json") });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey(faux.provider.id, "invented");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "git worktree list", cwd: "projects/orrery" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("orrery has one other worktree, side."),
      fauxAssistantMessage([fauxToolCall("start_work", { project: "orrery" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("edit", { path: "desktops/desk-five/orrery/src/ratios.ts", old: "1.25", new: "1.5" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Done, in my own worktree."),
    ]);
    const agents = new Agents(ws, harbor());
    const desktop = await agents.open("desk-five", { modelRuntime, model: faux.getModel() as never, instructions: "You are a test agent." });
    await desktop.send("which worktrees does orrery have?", "in-1");
    expect(agents.events("desk-five").some(e => e.type === "work.started")).toBe(false);
    await desktop.send("fix the moon ratio", "in-2");

    expect(readFileSync(join(ws.desktops, "desk-five", "orrery", "src", "ratios.ts"), "utf8")).toContain("1.5");
    expect(readFileSync(join(home, "src", "ratios.ts"), "utf8")).toContain("1.4");
    const kinds = agents.events("desk-five").map(e => e.type === "tool.end" ? `end:${e.label}` : e.type === "tool.start" ? `start:${e.label}` : e.type);
    expect(kinds).toEqual([
      "input", "status", "start:Running git worktree list", "end:Ran git worktree list", "message.done", "status",
      "input", "status", "start:Starting work on orrery", "work.started", "end:Started work on orrery in desktops/desk-five/orrery",
      "start:Editing desktops/desk-five/orrery/src/ratios.ts", "end:Edited desktops/desk-five/orrery/src/ratios.ts", "message.done", "status",
    ]);
    expect((await desktop.changes())[0]).toMatchObject({ project: "orrery", branch: "desktop/desk-five", commits: 0, dirty: 1 });
    await desktop.archive();
    expect(existsSync(join(ws.desktops, "desk-five", "orrery"))).toBe(true); // archive keeps files
  });
});
