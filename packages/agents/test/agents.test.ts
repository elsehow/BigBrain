import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agents, AgentsError, desktopFolder, discardFork, forkProject, Harbor, projectState, projectsIn, readFork, workspace, codingTools } from "../src";
import type { ToolContext } from "../src/tools";

const mac = process.platform === "darwin";
const roots: string[] = [];
afterAll(() => roots.forEach(r => rmSync(r, { recursive: true, force: true })));
const sh = (cwd: string, ...args: string[]) => execFileSync(args[0]!, args.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A workspace with one invented project: a git repo with untracked dependencies, a secret and a virtualenv. */
function scene() {
  const root = mkdtempSync(join(tmpdir(), "agents-ws-"));
  roots.push(root);
  const ws = workspace(root);
  const home = join(ws.projects, "orrery");
  mkdirSync(join(home, "src"), { recursive: true });
  writeFileSync(join(home, "src", "ratios.ts"), "export const moon = 1.25;\n");
  writeFileSync(join(home, ".gitignore"), "node_modules/\n.env\n.venv/\n.claude/\n");
  sh(home, "git", "init", "-q", "-b", "main");
  sh(home, "git", "-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", "-A");
  sh(home, "git", "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "seed");
  mkdirSync(join(home, "node_modules", "gearlib"), { recursive: true });
  writeFileSync(join(home, "node_modules", "gearlib", "index.js"), "module.exports = 42;\n");
  writeFileSync(join(home, ".env"), "ORRERY_TOKEN=invented\n");
  mkdirSync(join(home, ".venv", "bin"), { recursive: true });
  writeFileSync(join(home, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
  writeFileSync(join(home, ".venv", "bin", "python3"), "#!/bin/sh\necho python\n");
  writeFileSync(join(home, ".venv", "bin", "gearcheck"), `#!${join(home, ".venv", "bin", "python3")}\nprint("check")\n`);
  chmodSync(join(home, ".venv", "bin", "gearcheck"), 0o755);
  return { ws, home };
}

describe("the workspace", () => {
  test("a desktop's folder links every project it hasn't forked, and stays idempotent", () => {
    const { ws } = scene();
    const folder = desktopFolder(ws, "desk-one");
    expect(lstatSync(join(folder, "orrery")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(folder, "orrery", "src", "ratios.ts"), "utf8")).toContain("1.25");
    desktopFolder(ws, "desk-one");
    expect(projectState(ws, "desk-one", "orrery")).toBe("link");
    expect(() => desktopFolder(ws, "Bad Id")).toThrow(AgentsError);
  });

  test("a command touches the projects in its folder and its paths", () => {
    const names = ["orrery", "tide-tables"];
    expect(projectsIn("npm test", "orrery", names)).toEqual(["orrery"]);
    expect(projectsIn("cd tide-tables && make", "", names)).toEqual(["tide-tables"]);
    expect(projectsIn("cat ./orrery/README.md; ls", "", names)).toEqual(["orrery"]);
    expect(projectsIn("echo orrery-like", "", names)).toEqual([]);
  });
});

describe.if(mac)("forks", () => {
  test("a fork is the whole project, environment included, on its own branch; the home copy is untouched", async () => {
    const { ws, home } = scene();
    sh(home, "git", "worktree", "add", "-q", "-b", "elsewhere", join(home, ".claude", "worktrees", "elsewhere"));
    const fork = await forkProject(ws, "desk-two", "orrery");
    expect(lstatSync(fork.path).isDirectory() && !lstatSync(fork.path).isSymbolicLink()).toBe(true);
    expect(sh(fork.path, "git", "branch", "--show-current")).toBe("desktop/desk-two");
    expect(existsSync(join(fork.path, "node_modules", "gearlib", "index.js"))).toBe(true);
    expect(readFileSync(join(fork.path, ".env"), "utf8")).toContain("invented");
    // other sessions' worktrees don't come along, and neither does git's record of them
    expect(existsSync(join(fork.path, ".claude", "worktrees", "elsewhere"))).toBe(false);
    expect(existsSync(join(fork.path, ".git", "worktrees"))).toBe(false);
    expect(sh(home, "git", "worktree", "list")).toContain("elsewhere");
    // the venv's scripts now name the fork's own interpreter
    expect(readFileSync(join(fork.path, ".venv", "bin", "gearcheck"), "utf8").split("\n")[0]).toBe(`#!${join(fork.path, ".venv", "bin", "python3")}`);
    expect(readFileSync(join(home, ".venv", "bin", "gearcheck"), "utf8")).toContain(join(home, ".venv"));
    // the home copy: same branch, nothing changed
    expect(sh(home, "git", "branch", "--show-current")).toBe("main");
    expect(sh(home, "git", "status", "--porcelain")).toBe("");
    expect(await forkProject(ws, "desk-two", "orrery")).toEqual(fork);
    expect(readFork(ws, "desk-two", "orrery")?.base).toBe(sh(home, "git", "rev-parse", "HEAD"));
  });

  test("discarding a fork puts the link back", async () => {
    const { ws } = scene();
    await forkProject(ws, "desk-three", "orrery");
    discardFork(ws, "desk-three", "orrery");
    expect(projectState(ws, "desk-three", "orrery")).toBe("link");
  });

  test("a project that is itself a linked worktree is refused", async () => {
    const { ws, home } = scene();
    sh(home, "git", "worktree", "add", "-q", "-b", "side", join(ws.projects, "orrery-side"));
    await expect(forkProject(ws, "desk-four", "orrery-side")).rejects.toThrow(/worktree of another repository/);
  });
});

describe.if(mac)("harbor", () => {
  const harbor = new Harbor({ settleMs: 400, waitMs: 4000, graceMs: 500 });
  const server = (port = 0, stubborn = false) =>
    `node -e "${stubborn ? "process.on('SIGTERM',()=>{});" : ""}require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1')"`;

  test("a short command returns its output and exit code", async () => {
    const r = await harbor.run("desk-h", "echo gears; exit 3", tmpdir());
    expect(r.status === "exited" && r.code === 3 && r.output.includes("gears")).toBe(true);
  });

  test("a server returns once it listens, is found by its desktop's tag, and a stubborn one is still stopped", async () => {
    const r = await harbor.run("desk-h", server(0, true), tmpdir());
    expect(r.status).toBe("running");
    const port = r.status === "running" ? r.ports[0]! : 0;
    expect(port).toBeGreaterThan(0);
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
    expect((await harbor.servers("desk-h")).map(s => s.port)).toContain(port);
    expect(await harbor.holder(port)).toBe("desk-h");
    expect(await harbor.stopDesktop("desk-h")).toBeGreaterThan(0);
    expect((await harbor.servers("desk-h")).length).toBe(0);
  });

  test("a fixed-port collision names the desktop holding the port", async () => {
    const { ws } = scene();
    const first = await harbor.run("desk-a", server(0), tmpdir());
    const port = first.status === "running" ? first.ports[0]! : 0;
    const ctx: ToolContext = { ws, desktop: "desk-b", folder: desktopFolder(ws, "desk-b"), harbor, forked() {}, server() {}, homeCopyChanged() {} };
    const bash = codingTools(ctx).find(t => t.name === "bash")!;
    const r = await bash.run({ command: server(port) }, new AbortController().signal);
    expect(r.ok).toBe(false);
    expect(r.text).toContain(`Port ${port} is in use by desktop desk-a`);
    await harbor.stopDesktop("desk-a");
  });
});

describe.if(mac)("a desktop's agent", () => {
  test("its first edit forks the project, the home copy stays as it was, and every step is an event", async () => {
    const { ws, home } = scene();
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } = await import("@earendil-works/pi-ai");
    const faux = fauxProvider();
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, authPath: join(ws.root, "auth.json") });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey(faux.provider.id, "invented");
    faux.setResponses([
      fauxAssistantMessage([fauxText("Fixing the ratio."), fauxToolCall("edit", { path: "orrery/src/ratios.ts", old: "1.25", new: "1.5" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("note", { text: "ratio fixed" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Done: the moon ratio is 1.5 in my copy."),
    ]);
    const noted: unknown[] = [];
    const agents = new Agents(ws, new Harbor({ settleMs: 400 }));
    const desktop = await agents.open("desk-five", {
      modelRuntime, model: faux.getModel() as never, instructions: "You are a test agent.",
      tools: [{ name: "note", description: "Record a note.", parameters: { type: "object", properties: { text: { type: "string" } } },
        execute: async args => { noted.push(args); return { ok: true }; } }],
    });
    await desktop.send("fix the moon ratio", "input-1");
    await desktop.send("fix the moon ratio", "input-1"); // a retry does nothing

    const fork = join(ws.desktops, "desk-five", "orrery");
    expect(readFileSync(join(fork, "src", "ratios.ts"), "utf8")).toContain("1.5");
    expect(readFileSync(join(home, "src", "ratios.ts"), "utf8")).toContain("1.25");
    expect(noted).toEqual([{ text: "ratio fixed" }]);
    const kinds = agents.events("desk-five").map(e => e.type === "tool.end" ? `${e.type}:${e.label}` : e.type);
    expect(kinds).toEqual(["input", "status", "message.done", "tool.start", "project.forked", "tool.end:Edited orrery/src/ratios.ts",
      "tool.start", "tool.end:note", "message.done", "status"]);
    expect((await desktop.changes())[0]).toMatchObject({ project: "orrery", branch: "desktop/desk-five", commits: 0, dirty: 1 });
    await desktop.archive();
    expect(agents.events("desk-five").at(-1)).toMatchObject({ type: "status", status: "archived" });
    expect(existsSync(fork)).toBe(true); // archive keeps files
  });
});
