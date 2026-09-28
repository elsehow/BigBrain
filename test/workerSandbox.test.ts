import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerSandbox, shellQuote, workerEnvironment, type WorkerScope } from "../lib/worker/sandbox";
import { workerTools, currentWorkerSignal } from "../lib/worker/tools";
const roots: string[] = [], executors: WorkerSandbox[] = [];
afterEach(() => { for (const s of executors.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function fixture(mode: WorkerScope["mode"] = "work") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bb-worker-test-"))); roots.push(root);
  for (const name of ["project", "scratch", "reference"]) mkdirSync(join(root, name));
  writeFileSync(join(root, "outside.txt"), "outside sentinel"); writeFileSync(join(root, "reference", "note.txt"), "reference sentinel");
  writeFileSync(join(root, "project", ".env"), "SECRET=synthetic");
  const scope = { project: join(root, "project"), scratch: join(root, "scratch"), references: [join(root, "reference")], mode, domains: [] };
  const executor = new WorkerSandbox(scope); executors.push(executor);
  const run = (command: string) => executor.run(command, AbortSignal.timeout(10_000));
  return { root, scope, executor, run };
}
test("worker environment carries no ambient credentials, shell startup hooks, or user config", () => {
  process.env.BIGBRAIN_TEST_SECRET = "synthetic";
  try { expect(workerEnvironment("/scratch")).toMatchObject({ HOME: "/scratch", TMPDIR: "/scratch", PATH: expect.any(String), LANG: "en_US.UTF-8", TERM: "dumb" }); }
  finally { expect(workerEnvironment("/scratch").BIGBRAIN_TEST_SECRET).toBeUndefined(); delete process.env.BIGBRAIN_TEST_SECRET; }
});
// Both platform CI jobs run actual containment, with no unsandboxed fallback.
const mac = ["darwin", "linux"].includes(process.platform) ? test : test.skip;
mac("actual sandbox permits project edits and blocks outside files, credentials, references writes and network", async () => {
  const f = fixture(); await f.executor.start();
  expect((await f.run("echo changed > result.txt; cat result.txt")).stdout).toBe("changed\n");
  expect((await f.run(`cat ${shellQuote(join(f.scope.references[0]!, "note.txt"))}`)).stdout).toBe("reference sentinel");
  symlinkSync(join(f.root, "outside.txt"), join(f.scope.project, "escape.txt"));
  for (const path of [join(f.root, "outside.txt"), join(f.scope.project, "escape.txt"), join(f.scope.project, ".env")])
    expect((await f.run(`cat ${shellQuote(path)}`)).exitCode, path).not.toBe(0);
  for (const path of [join(f.scope.project, ".env"), join(f.scope.references[0]!, "note.txt")])
    expect((await f.run(`echo forbidden > ${shellQuote(path)}`)).exitCode, path).not.toBe(0);
  await f.run(`echo forbidden > ${shellQuote(join(f.root, "outside.txt"))}`);
  expect(readFileSync(join(f.root, "outside.txt"), "utf8")).toBe("outside sentinel");
  // Linux provides a private temporary filesystem: a new /tmp file can exist
  // there without granting any write to the host temporary directory.
  const temporary = join(realpathSync(tmpdir()), `bb-outside-${crypto.randomUUID()}`);
  await f.run(`echo ephemeral > ${shellQuote(temporary)}`);
  expect(existsSync(temporary)).toBe(false);
  expect((await f.run("curl --max-time 3 -sS https://example.com")).exitCode).not.toBe(0);
  expect((await f.run(`curl --max-time 2 -sS http://127.0.0.1:4747`)).exitCode).not.toBe(0);
  expect(readFileSync(join(f.root, "outside.txt"), "utf8")).toBe("outside sentinel");
});
mac("Pi read/write/edit/find tools all use the sandbox; read mode writes scratch only", async () => {
  const f = fixture("read"), tools = workerTools(f.scope, f.executor);
  const call = (name: string, args: Record<string, unknown>) => currentWorkerSignal.run(AbortSignal.timeout(10_000), () => tools.find(t => t.name === name)!.call(args));
  expect(tools.map(t => t.name)).not.toContain("bash");
  await expect(call("write", { path: "forbidden.txt", content: "blocked" })).rejects.toThrow();
  const path = join(f.scope.scratch, "draft.txt");
  await call("write", { path, content: "Before\n" });
  await call("edit", { path, edits: [{ oldText: "Before", newText: "After" }] });
  expect(JSON.stringify(await call("read", { path }))).toContain("After");
  await expect(call("read", { path: join(f.root, "outside.txt") })).rejects.toThrow();
  expect(JSON.stringify(await call("find", { path: f.scope.scratch, pattern: "*.txt" }))).toContain("draft.txt");
  expect(existsSync(join(f.scope.project, "forbidden.txt"))).toBe(false);
});
mac("cancellation stops descendants; concurrent workers do not inherit each other's roots", async () => {
  const a = fixture(), b = fixture(); await Promise.all([a.executor.start(), b.executor.start()]);
  expect((await a.run(`cat ${shellQuote(join(b.root, "reference", "note.txt"))}`)).exitCode).not.toBe(0);
  const controller = new AbortController();
  const pending = a.executor.run("(sleep 1; echo escaped > late.txt) & wait", controller.signal);
  await Bun.sleep(100); controller.abort(); await pending.catch(() => {});
  await Bun.sleep(1200);
  expect(existsSync(join(a.scope.project, "late.txt"))).toBe(false);
  expect((await b.run("echo independent")).stdout).toBe("independent\n");
});

mac("preexisting hard links fail closed before commands can run", async () => {
  const f = fixture(); linkSync(join(f.root, "outside.txt"), join(f.scope.project, "alias.txt"));
  await expect(f.executor.start()).rejects.toThrow("hard-linked");
  await expect(f.run("echo never")).rejects.toThrow();
});

mac("a real Pi session completes a bounded editing task through the sandboxed built-ins", async () => {
  const { PiSession } = await import("../lib/run/piSession");
  const { fakePi } = await import("./support/pi");
  const f = fixture(), tools = workerTools(f.scope, f.executor);
  const calls = [
    { name: "write", arguments: { path: "hello.txt", content: "Hello" } },
    { name: "edit", arguments: { path: "hello.txt", edits: [{ oldText: "Hello", newText: "Updated" }] } },
    { name: "bash", arguments: { command: "test \"$(cat hello.txt)\" = Updated" } },
  ];
  const client = new PiSession({ root: f.root, config: { adapter: "pi", provider: "anthropic", model: "claude-sonnet-5" },
    instructions: "Complete the synthetic editing task.", tools: tools.map(t => ({ name: t.name, description: t.description, parameters: t.inputSchema })), state: { through: 0 }, save() {} },
    fakePi(() => { const call = calls.shift(); return call ? { content: [{ type: "toolCall", id: crypto.randomUUID(), ...call }] } : { result: "Verified" }; }));
  const signal = AbortSignal.timeout(10_000);
  try {
    expect(await client.turn({ signal, input: () => "Update and verify hello.txt", messages: [], reference: () => "", connected() {}, delta() {},
      tool: (name, args) => currentWorkerSignal.run(signal, () => tools.find(t => t.name === name)!.call(args)) })).toBe("Verified");
    expect(readFileSync(join(f.scope.project, "hello.txt"), "utf8")).toBe("Updated");
  } finally { client.close(); }
});

mac("a command cannot hard-link a reference into its writable project", async () => {
  const f = fixture(); await f.executor.start();
  await f.run(`ln ${shellQuote(join(f.scope.references[0]!, "note.txt"))} linked.txt && echo forbidden > linked.txt`);
  expect(readFileSync(join(f.scope.references[0]!, "note.txt"), "utf8")).toBe("reference sentinel");
});

mac("explicit credentials reach only their worker; public network still denies local addresses", async()=>{
 const f=fixture(),other=fixture();
 const executor=new WorkerSandbox({...f.scope,network:'public'},{GH_TOKEN:'synthetic-credential'});executors.push(executor);
 const run=(command:string)=>executor.run(command,AbortSignal.timeout(15_000));
 expect((await run('test "$GH_TOKEN" = synthetic-credential && echo connected')).stdout).toBe('connected\n');
 expect((await other.run('test -z "$GH_TOKEN" && echo isolated')).stdout).toBe('isolated\n');
 for(const address of ['http://127.0.0.1:4747','http://10.0.0.1','http://[::1]:4747']) expect((await run(`curl --max-time 2 -sS ${shellQuote(address)}`)).exitCode).not.toBe(0);
 if (process.env.BIGBRAIN_TEST_PUBLIC_NETWORK === '1') { const publicResult=await run('curl --max-time 10 -sSf https://example.com >/dev/null');expect(publicResult.exitCode,publicResult.stderr).toBe(0); }
});
