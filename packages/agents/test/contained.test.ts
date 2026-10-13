/**
 * A contained desktop, end to end, on a real machine (Phase 3a's
 * acceptance): the agent copies a project in, changes and commits it on its
 * own branch, runs its tests, and answers a question about the person's
 * checkout from project_state; the checkout never changes. And the cap on
 * machines running at once. Runs only when asked, like machine.test.ts:
 *
 *   BIGBRAIN_VM_TESTS=qemu|vz bun test packages/agents/test/contained.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as httpsServer, type Server as HttpsServer } from "node:https";
import { Agents, EgressProxy, Harbor, MachineCA, MachineImages, Machines, workspace, type HostMode, type MachineEvent } from "../src";

const BACKEND = process.env.BIGBRAIN_VM_TESTS as "vz" | "qemu" | undefined;
const IMAGE = process.env.BIGBRAIN_MACHINE_IMAGE ?? resolve(import.meta.dir, "../image/out");
const HELPER = BACKEND === "qemu" ? resolve(import.meta.dir, "../image/qemu.sh")
  : process.env.BIGBRAIN_VM_HELPER ?? resolve(import.meta.dir, "../../vm/.build/release/bigbrain-vm");
const enabled = (BACKEND === "vz" || BACKEND === "qemu") && existsSync(join(IMAGE, "rootfs.img"));

const roots: string[] = [];
const scratch = (name: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), name))); roots.push(d); return d; };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=orrery@example.invalid", "-c", "user.name=Orrery", ...args], { cwd, encoding: "utf8" }).trim();

function scene() {
  const ws = workspace(scratch("contained-ws-"));
  const home = join(ws.projects, "orrery");
  mkdirSync(join(home, "src"), { recursive: true });
  writeFileSync(join(home, "src", "ratios.sh"), "moon=1.25\n");
  writeFileSync(join(home, "test.sh"), ". ./src/ratios.sh\n[ \"$moon\" = 1.5 ] && echo pass || { echo fail; exit 1; }\n");
  git(home, "init", "-q", "-b", "main");
  git(home, "config", "user.name", "Orrery Person"); git(home, "config", "user.email", "person@example.invalid");
  git(home, "add", "-A"); git(home, "commit", "-qm", "seed"); git(home, "tag", "v1");
  git(home, "branch", "moons");
  writeFileSync(join(home, "NOTES.md"), "uncommitted thoughts\n");
  return { ws, home };
}

describe.skipIf(!enabled)(`a contained desktop (${BACKEND})`, () => {
  const machinesMade: Machines[] = [];
  const proxy = new EgressProxy({ hosts: () => [] });
  afterAll(async () => {
    await Promise.all(machinesMade.map(m => m.stopAll()));
    proxy.close();
    roots.forEach(r => rmSync(r, { recursive: true, force: true }));
  });
  const machinesFor = (ws: ReturnType<typeof workspace>, running = 3) => {
    const m = new Machines({ ws, images: new MachineImages({ local: IMAGE }), proxy, backend: BACKEND!, helper: HELPER, memoryMiB: () => 1024, cpus: 2, running: () => running });
    machinesMade.push(m);
    return m;
  };

  test("copy, change, commit and test in the machine; answer about the checkout from the host; the checkout never changes", async () => {
    const { ws, home } = scene();
    const before = git(home, "rev-parse", "HEAD") + git(home, "status", "--porcelain") + git(home, "branch", "-a");
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
    const faux = fauxProvider();
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, authPath: join(ws.root, "auth.json") });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey(faux.provider.id, "invented");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("project_state", { project: "orrery" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("orrery is on main, with one uncommitted file, NOTES.md."),
      fauxAssistantMessage([fauxToolCall("open_project", { project: "orrery" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("edit", { path: "orrery/src/ratios.sh", old: "1.25", new: "1.5" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("bash", { command: "sh test.sh && git commit -qam 'Moon ratio 1.5' && git log --format='%an %s' -1 && git branch --show-current", cwd: "orrery" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Fixed and committed on my branch."),
    ]);
    const agents = new Agents(ws, new Harbor({ env: {}, discovery: false }), machinesFor(ws));
    const desktop = await agents.open("desk-c1", { modelRuntime, model: faux.getModel() as never, instructions: "You are a test agent.", contained: true });
    await desktop.send("what state is orrery in?", "in-1");
    // a question about the checkout started no machine
    expect(agents.machines!.state("desk-c1")).toBe("stopped");
    await desktop.send("fix the moon ratio", "in-2");

    const events = agents.events("desk-c1");
    const ends = events.filter(e => e.type === "tool.end").map(e => (e as { label: string; ok: boolean }));
    // each tool's label with its outcome, so a failure says which
    expect(ends.map(e => `${e.ok ? "ok" : "FAILED"} ${e.label}`)).toEqual(ends.map(e => `ok ${e.label}`));
    expect(ends.length).toBe(4);
    expect(ends[0]!.label).toBe("Looked at orrery (main, 1 uncommitted)");
    expect(ends[1]!.label).toMatch(/^Copied orrery at [0-9a-f]{7} \(main\)$/);
    expect(events.some(e => e.type === "machine.started")).toBe(true);
    expect(events.some(e => e.type === "project.opened")).toBe(true);
    const ran = events.filter(e => e.type === "tool.end").at(-1) as { label: string };
    expect(ran.label).toMatch(/^Ran sh test\.sh/);

    // in the copy: the commit, by the person's identity, on desktop/<id>; all of their branches and tags
    const g = await agents.contained!.files("desk-c1");
    let out = "";
    const x = await g.exec(["/bin/bash", "-c", "cd /work/orrery && git log --format='%an|%s' -1 && git branch --show-current && git branch --format='%(refname:short)' | sort | tr '\\n' ' ' && echo && git tag"], { cwd: "/work" }, (_k, d) => { out += d; });
    await x.exit;
    expect(out.trim().split("\n")).toEqual(["Orrery Person|Moon ratio 1.5", "desktop/desk-c1", "desktop/desk-c1 main moons ", "v1"]);

    // the person's checkout: exactly as it was
    expect(git(home, "rev-parse", "HEAD") + git(home, "status", "--porcelain") + git(home, "branch", "-a")).toBe(before);
    expect(readFileSync(join(home, "src", "ratios.sh"), "utf8")).toBe("moon=1.25\n");

    // sync brings the person's newer commit, and leaves the desktop's branch alone
    git(home, "commit", "-qm", "person's later work", "--allow-empty");
    const sync = (await import("../src/containedTools")).containedTools({ ws, desktop: "desk-c1", harbor: agents.contained!, opened() {}, synced() {}, server() {} }).find(t => t.name === "sync_project")!;
    const synced = await sync.run({ project: "orrery" }, new AbortController().signal);
    expect(synced.text).toMatch(/from [0-9a-f]{7} to [0-9a-f]{7}/);
    out = "";
    const y = await g.exec(["/bin/bash", "-c", "cd /work/orrery && git log --format=%s -1 main && git log --format=%s -1 desktop/desk-c1"], { cwd: "/work" }, (_k, d) => { out += d; });
    await y.exit;
    expect(out.trim().split("\n")).toEqual(["person's later work", "Moon ratio 1.5"]);
    await desktop.archive();
  }, 180_000);

  test("review and Land: host git reviews the bundle in its own repo, and only the reviewed commit lands (I7)", async () => {
    const { ws, home } = scene();
    const machines = machinesFor(ws);
    const agents = new Agents(ws, new Harbor({ env: {}, discovery: false }), machines);
    const { openProject } = await import("../src/projects");
    const { saveCopy } = await import("../src/review");
    const g = await agents.contained!.files("desk-l1");
    saveCopy(ws, "desk-l1", await openProject(ws, "desk-l1", g, "orrery"));
    const sh = async (script: string) => { let o = ""; const x = await g.exec(["/bin/bash", "-c", `set -e; cd /work/orrery; ${script}`], { cwd: "/work" }, (_k, d) => { o += d; }); const e = await x.exit; if (e.code) throw new Error(o); return o.trim(); };

    // nothing of its own yet: nothing to review
    expect((await agents.diff("desk-l1", "orrery")).commits).toEqual([]);
    await sh("sed -i s/1.25/1.5/ src/ratios.sh && printf '{}\\n' > package.json && git add -A && git commit -qm 'Moon ratio 1.5'");
    await sh("echo draft > scratch.txt");
    const review = await agents.diff("desk-l1", "orrery") as Awaited<ReturnType<typeof agents.diff>> & { files: string[]; dirty: number };
    expect(review.commits.map(c => c.subject)).toEqual(["Moon ratio 1.5"]);
    expect(review.files.sort()).toEqual(["package.json", "src/ratios.sh"]);
    expect(review.dirty).toBe(1);
    expect(review.patch).toContain("+moon=1.5");
    // the review repo is the host's, borrowing the project's objects
    const repo = join(ws.state, "desk-l1", "review", "orrery.git");
    expect(readFileSync(join(repo, "objects", "info", "alternates"), "utf8").trim()).toBe(join(home, ".git", "objects"));

    // the agent keeps working after the review: that commit must not land
    await sh("echo later >> src/ratios.sh && git commit -qam 'Unreviewed'");
    const unreviewed = await sh("git rev-parse HEAD");
    const landed = await agents.land("desk-l1", "orrery", "branch", review.head);
    expect(landed).toMatchObject({ how: "branch", branch: "desktop/desk-l1" });
    expect(git(home, "rev-parse", "desktop/desk-l1")).toBe(review.head);
    expect(git(home, "log", "--format=%s", "-1", "desktop/desk-l1")).toBe("Moon ratio 1.5");
    expect(() => execFileSync("git", ["cat-file", "-e", unreviewed], { cwd: home, stdio: "ignore" })).toThrow();
    // the person's own branch and files: untouched
    expect(git(home, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(readFileSync(join(home, "src", "ratios.sh"), "utf8")).toBe("moon=1.25\n");
    // a stale review can't land
    await expect(agents.land("desk-l1", "orrery", "branch", "0".repeat(40))).rejects.toThrow(/changed since you reviewed/);

    await agents.discard("desk-l1", "orrery");
    expect(existsSync(repo)).toBe(false);
    expect(await g.stat("/work/orrery").catch(() => "gone")).toBe("gone");
    await machines.stopAll();
  }, 180_000);

  test("previews: a server in the machine is found by its job, reached through a forward, and the forward closes with the job", async () => {
    const { ws } = scene();
    const machines = machinesFor(ws);
    const harbor = new Agents(ws, new Harbor({ env: {}, discovery: false }), machines).contained!;
    const r = await harbor.run("desk-p1", `bun -e "Bun.serve({ port: 5173, hostname: '127.0.0.1', fetch: () => new Response('orrery page') }); console.log('up')"`, "/work");
    expect(r.status).toBe("running");
    if (r.status !== "running") return;
    expect(r.ports).toEqual([5173]);
    const hostPort = r.hostPorts[5173]!;
    expect(hostPort).toBeGreaterThan(0);
    expect(r.note).toContain(`shown at http://127.0.0.1:${hostPort}`);
    for (let i = 0; i < 3; i++) expect(await (await fetch(`http://127.0.0.1:${hostPort}/`)).text()).toBe("orrery page");
    expect((await harbor.servers("desk-p1")).map(s => [s.port, s.hostPort])).toEqual([[5173, hostPort]]);
    await harbor.stopJob(r.job);
    await expect(fetch(`http://127.0.0.1:${hostPort}/`)).rejects.toThrow();
    await machines.stopAll();
  }, 120_000);

  test("egress policy (Phase 4): the machine trusts this install's CA; a read host takes reads, never writes; an upload host takes writes", async () => {
    const web = new MachineCA({ dir: join(scratch("web-ca-"), "ca") }), mine = new MachineCA({ dir: join(scratch("machine-ca-"), "ca") });
    const modes: Record<string, HostMode> = { "registry.example": "read", "uploads.example": "upload" };
    const servers: HttpsServer[] = [];
    const ports: Record<string, number> = {};
    for (const host of Object.keys(modes)) {
      const server = httpsServer(web.leaf(host), (req, res) => { let b = ""; req.on("data", d => { b += d; }); req.on("end", () => res.end(`${req.method} ${req.url} ${b}`)); });
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      servers.push(server); ports[host] = (server.address() as { port: number }).port;
    }
    const policyProxy = new EgressProxy({ hosts: () => Object.keys(modes), mode: (_d, h) => modes[h] ?? "read", ca: mine,
      upstream: host => ({ host: "127.0.0.1", port: ports[host]!, ca: web.cert() }) });
    const { ws } = scene();
    const machines = new Machines({ ws, images: new MachineImages({ local: IMAGE }), proxy: policyProxy, backend: BACKEND!, helper: HELPER, memoryMiB: () => 1024, cpus: 2, ca: () => mine.cert() });
    machinesMade.push(machines);
    const harbor = new Agents(ws, new Harbor({ env: {}, discovery: false }), machines).contained!;
    const run = async (command: string) => { const r = await harbor.run("desk-t1", command, "/work"); return r.status === "exited" ? r.output.trim() : `still running: ${r.output}`; };
    try {
      expect(await run("curl -sS https://registry.example/orrery")).toBe("GET /orrery");
      expect(await run("curl -sS -X POST -d want https://registry.example/invented/orrery.git/git-upload-pack")).toBe("POST /invented/orrery.git/git-upload-pack want");
      expect(await run("curl -sS -o /dev/null -w '%{http_code}' -X POST -d pack https://registry.example/invented/orrery.git/git-receive-pack")).toBe("403");
      expect(await run("curl -sS -X PUT -d '{}' https://uploads.example/orrery")).toBe("PUT /orrery {}");
      // node's tools trust it too, through NODE_EXTRA_CA_CERTS
      expect(await run(`bun -e "console.log(await (await fetch('https://registry.example/from-bun')).text())"`)).toBe("GET /from-bun");
    } finally {
      await machines.stopAll();
      policyProxy.close();
      servers.forEach(s => s.close());
    }
  }, 180_000);

  test("one machine at a time: starting a second stops the idle first, and says so", async () => {
    const { ws } = scene();
    const machines = machinesFor(ws, 1);
    const said: Array<[string, MachineEvent]> = [];
    machines.on((d, e) => said.push([d, e]));
    await machines.files("desk-m1");
    expect(machines.state("desk-m1")).toBe("running");
    await machines.files("desk-m2");
    expect(machines.state("desk-m2")).toBe("running");
    expect(machines.state("desk-m1")).toBe("stopped");
    expect(said.some(([d, e]) => d === "desk-m1" && e.type === "machine.stopped" && /idle longest/.test(e.why))).toBe(true);
    await machines.stopAll();
  }, 120_000);
});
