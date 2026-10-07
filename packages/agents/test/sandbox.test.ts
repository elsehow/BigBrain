import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedHost, confinement, EgressProxy, Harbor, privateAddress, profileInput, scopeOf, Seatbelt, startWork, takeLease, workspace, type SandboxPolicy } from "../src";

const mac = process.platform === "darwin";
const roots: string[] = [];
const servers: Server[] = [];
afterAll(() => { roots.forEach(r => rmSync(r, { recursive: true, force: true })); servers.forEach(s => s.close()); });
const scratch = (name: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), name))); roots.push(d); return d; };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
const listen = (body: string, host = "127.0.0.1") => new Promise<number>(done => {
  const s = httpServer((_q, r) => r.end(body)).listen(0, host, () => done((s.address() as { port: number }).port));
  servers.push(s);
});

/** A workspace with one invented project, a desktop's worktree of it, and an invented credential store. */
async function scene(policy: Omit<SandboxPolicy, "deny"> & { egress?: EgressProxy } = {}) {
  const root = scratch("sandbox-ws-");
  const ws = workspace(root);
  const home = join(ws.projects, "orrery");
  mkdirSync(join(home, "src"), { recursive: true });
  writeFileSync(join(home, "src", "ratios.ts"), "export const moon = 1.25;\n");
  git(home, "init", "-q", "-b", "main"); git(home, "add", "-A"); git(home, "commit", "-qm", "seed");
  const secrets = scratch("sandbox-keys-");
  writeFileSync(join(secrets, "id_invented"), "not a real key\n");
  const outside = scratch("sandbox-outside-");
  const egress = policy.egress ?? new EgressProxy({ hosts: () => policy.hosts?.() ?? [] });
  const full: SandboxPolicy = { ...policy, deny: () => [secrets], caches: [] };
  // its own scope: another test file's engine sweeping its leftovers never stops these
  const h = new Harbor({ env: { PATH: process.env.PATH, HOME: process.env.HOME, SSH_AUTH_SOCK: "/tmp/invented-agent.sock" }, scope: scopeOf(root), settleMs: 400, waitMs: 4000, graceMs: 500,
    launcher: new Seatbelt(full, egress, { tmp: join(root, "tmp") }) });
  const work = await startWork(ws, "desk-sb", "orrery");
  const sh = async (command: string, cwd = work.path, untrusted = false, desktop = "desk-sb") => {
    const r = await h.run(desktop, command, cwd, undefined, confinement(ws, desktop, untrusted));
    return { ...r, out: r.output.trim() };
  };
  return { ws, home, work, secrets, outside, h, sh, egress };
}

describe.if(mac)("a desktop's sandbox", () => {
  test("writes land in the desktop's own folder and temp folder, never outside", async () => {
    const { work, outside, sh } = await scene();
    const r = await sh(`echo kept > kept.txt && echo $TMPDIR && touch "$TMPDIR/scratch" && cat kept.txt; touch '${outside}/escaped'`);
    expect(r.out).toContain("kept");
    expect(r.out).toContain("Operation not permitted");
    expect(readFileSync(join(work.path, "kept.txt"), "utf8")).toBe("kept\n");
    expect(existsSync(join(outside, "escaped"))).toBe(false);
  });

  test("what the host denies can't be read, nor can other desktops' folders", async () => {
    const { ws, secrets, sh } = await scene();
    mkdirSync(join(ws.desktops, "desk-other"), { recursive: true });
    writeFileSync(join(ws.desktops, "desk-other", "notes.txt"), "another desktop's\n");
    const r = await sh(`cat '${secrets}/id_invented'; cat '${ws.desktops}/desk-other/notes.txt'; ls '${ws.state}'; echo done`);
    expect(r.out).not.toContain("not a real key");
    expect(r.out).not.toContain("another desktop's");
    expect(r.out.match(/Operation not permitted/g)?.length).toBe(3);
  });

  test("a commit in the worktree works, trusted or not; its repo's hooks, config and .git pointers can't be touched", async () => {
    const { home, work, sh } = await scene();
    const commit = (n: string) => `echo ${n} > ${n}.txt && git add ${n}.txt && git -c user.email=a@example.invalid -c user.name=a commit -qm ${n} && git log -1 --format=%s`;
    expect((await sh(commit("trusted"))).out).toEndWith("trusted");
    expect((await sh(commit("untrusted"), work.path, true)).out).toEndWith("untrusted");
    expect(git(home, "log", "-1", "--format=%s", "desktop/desk-sb")).toBe("untrusted");
    const gitdir = join(home, ".git");
    const r = await sh([`echo x >> '${gitdir}/hooks/post-checkout'`, `echo x >> '${gitdir}/config'`, `echo 'gitdir: /tmp/x' > .git`,
      `echo /tmp > '${gitdir}/worktrees/orrery/commondir'`, "git update-ref refs/heads/main HEAD 2>&1 | grep -q 'Operation not permitted' && echo ref-refused"].join("; "), work.path, true);
    expect(r.out.match(/Operation not permitted/g)?.length).toBe(4);
    expect(r.out).toEndWith("ref-refused");
    expect(existsSync(join(gitdir, "hooks", "post-checkout"))).toBe(false);
    expect(readFileSync(join(work.path, ".git"), "utf8")).toStartWith("gitdir: ");
    expect(git(home, "log", "-1", "--format=%s", "main")).toBe("seed");
  });

  test("in place: a trusted desktop commits in a project, an untrusted one can't write there, and nobody moves its .git aside", async () => {
    const { ws, home, sh } = await scene();
    expect((await sh("echo a > a.txt && git add a.txt && git -c user.email=a@example.invalid -c user.name=a commit -qm inplace && git log -1 --format=%s", home)).out).toBe("inplace");
    const r = await sh("echo b > b.txt; mv .git .git-aside; echo x >> .git/hooks/pre-commit; touch ../new-project; echo end", home);
    expect(r.out.match(/Operation not permitted/g)?.length).toBe(3); // b.txt is written; the rest are refused
    expect(existsSync(join(home, ".git", "HEAD"))).toBe(true);
    expect((await sh("echo c > c.txt", home, true)).out).toContain("Operation not permitted");
    // another desktop's lease keeps it out too
    takeLease(ws, "desk-lessee", "orrery");
    expect((await sh("echo d > d.txt", home)).out).toContain("Operation not permitted");
  });

  test("children inherit it: a daemonized child and a job that outlives its command can't write outside", async () => {
    const { outside, sh } = await scene();
    await sh(`(sleep 0.3; touch '${outside}/daemon') > /dev/null 2>&1 & disown; nohup sh -c "sleep 0.3; touch '${outside}/nohup'" > /dev/null 2>&1 &`);
    const job = await sh(`node -e "require('http').createServer((q,s)=>{require('fs').writeFile('${outside}/job', 'x', e => s.end(e ? 'refused' : 'wrote'))}).listen(0,'127.0.0.1')"`);
    expect(job.status).toBe("running");
    const port = job.status === "running" ? job.ports[0]! : 0;
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("refused");
    await Bun.sleep(600);
    expect(["daemon", "nohup", "job"].filter(f => existsSync(join(outside, f)))).toEqual([]);
  });

  test("loopback: its own servers, earlier or in the same command, yes; the host's ports and others' servers, no", async () => {
    const engine = await listen("engine");
    const person = await listen("person");
    const { h, sh } = await scene({ ports: () => [engine] });
    const mine = await sh(`node -e "require('http').createServer((q,s)=>s.end('mine')).listen(0,'127.0.0.1')"`);
    const port = mine.status === "running" ? mine.ports[0]! : 0;
    const other = await sh(`node -e "require('http').createServer((q,s)=>s.end('theirs')).listen(0,'127.0.0.1')"`, undefined, false, "desk-two");
    const theirs = other.status === "running" ? other.ports[0]! : 0;
    const curl = (p: number) => `(curl -s -m 2 http://127.0.0.1:${p}/ && echo) || echo refused`;
    const r = await sh([curl(port), curl(engine), curl(person), curl(theirs),
      `node -e "const s=require('http').createServer((q,r)=>r.end('inline')).listen(0,'127.0.0.1',()=>fetch('http://127.0.0.1:'+s.address().port).then(r=>r.text()).then(t=>{console.log(t);s.close()}))"`].join("; "));
    expect(r.out.split("\n")).toEqual(["mine", "refused", "refused", "refused", "inline"]);
    await h.stopAll();
  });

  test("beyond this machine only through the proxy, to allowlisted hosts", async () => {
    const upstream = await listen("from the registry");
    const egress = new EgressProxy({ hosts: () => ["registry.example.test"], dial: (_host, port) => dialed(connect({ host: "127.0.0.1", port: port === 80 ? upstream : port })) });
    const { sh } = await scene({ egress });
    const r = await sh(["curl -s -m 3 http://registry.example.test/ping", "echo", "curl -s -m 3 -p http://registry.example.test/ping", "echo",
      "curl -s -m 3 -o /dev/null -w '%{http_code}' http://elsewhere.example.test/", "echo",
      "curl -s -m 3 --noproxy '*' http://93.184.215.14/ || echo direct-refused"].join("; "));
    expect(r.out.split("\n")).toEqual(["from the registry", "from the registry", "403", "direct-refused"]);
  });

  test.skipIf(!process.env.BIGBRAIN_TEST_INTERNET)("a real registry, through the proxy", async () => {
    const { sh } = await scene({ hosts: () => ["registry.npmjs.org"] });
    expect((await sh("curl -s -m 10 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/; echo; curl -s -m 5 -o /dev/null -w '%{http_code}' https://example.com/")).out).toBe("200\n000");
  });

  test("no ssh agent, Apple events, Launch Services, keychain or pasteboard", async () => {
    const { sh, outside } = await scene();
    writeFileSync(join(outside, "touch.applescript"), `do shell script "touch ${outside}/osa"\n`);
    const r = await sh([`echo agent=\${SSH_AUTH_SOCK:-none}`, `osascript '${outside}/touch.applescript' >/dev/null 2>&1 || echo osascript-refused`,
      "open -a TextEdit >/dev/null 2>&1 || echo open-refused", "pbpaste >/dev/null 2>&1 || echo pbpaste-refused",
      "security list-keychains >/dev/null 2>&1 || echo keychain-refused", `launchctl submit -l invented.sandbox.probe -- /usr/bin/touch '${outside}/launchd' 2>/dev/null || echo launchctl-refused`].join("; "));
    expect(r.out.split("\n")).toEqual(["agent=none", "osascript-refused", "open-refused", "pbpaste-refused", "keychain-refused", "launchctl-refused"]);
    await Bun.sleep(300);
    expect(["osa", "launchd"].filter(f => existsSync(join(outside, f)))).toEqual([]);
  });

  test("an untrusted desktop's toolchain caches are its own", async () => {
    const { sh } = await scene();
    const r = await sh("echo $npm_config_cache $BUN_INSTALL_CACHE_DIR", undefined, true);
    expect(r.out).toMatch(/\/desk-sb\/cache\/npm \S+\/desk-sb\/cache\/bun$/);
    expect((await sh("echo ${npm_config_cache:-shared}")).out).toBe("shared");
  });
});

describe("no sandbox, no shell", () => {
  const job = (root: string) => ({ command: `touch '${root}/ran'`, env: {}, busy: [], confine: { desktop: "desk-x", write: [root], worktrees: [], untrusted: false } });
  const egress = { port: async () => 1 };

  test("off macOS, a command is refused, never run bare", async () => {
    const root = scratch("sandbox-off-");
    await expect(new Seatbelt({}, egress, { platform: "linux", tmp: join(root, "tmp") }).launch(job(root))).rejects.toThrow("only on macOS");
    await expect(new Harbor({ env: {}, launcher: new Seatbelt({}, egress, { platform: "linux" }) }).run("desk-x", `touch '${root}/ran'`, root)).rejects.toThrow("did not run");
    expect(existsSync(join(root, "ran"))).toBe(false);
  });

  test("a missing sandbox-exec, or a profile it refuses, refuses the command", async () => {
    const root = scratch("sandbox-broken-");
    await expect(new Seatbelt({}, egress, { exec: join(root, "missing"), platform: "darwin", tmp: join(root, "tmp") }).launch(job(root))).rejects.toThrow("is missing");
    if (!mac) return;
    await expect(new Seatbelt({}, egress, { exec: "/usr/bin/false", tmp: join(root, "tmp") }).launch(job(root))).rejects.toThrow("The sandbox could not start");
    const h = new Harbor({ env: { PATH: process.env.PATH }, launcher: new Seatbelt({}, egress, { exec: "/usr/bin/false", tmp: join(root, "tmp") }) });
    await expect(h.run("desk-x", `touch '${root}/ran'`, root)).rejects.toThrow("did not run");
    expect(existsSync(join(root, "ran"))).toBe(false);
  });
});

describe("the profile's parts", () => {
  test("a folder holding the home folder or a denied path is never writable", () => {
    const root = scratch("sandbox-parts-");
    const denied = join(root, "keys");
    mkdirSync(denied);
    const p = profileInput({ desktop: "desk-x", write: [root, join(root, "ok"), process.env.HOME ?? "/Users", "/"], worktrees: [], untrusted: false }, { deny: [denied], tmp: join(root, "ok", "tmp"), caches: [], ports: [] });
    expect(p.write).toEqual([join(root, "ok"), join(root, "ok", "tmp")]);
  });
});

describe("the egress proxy", () => {
  test("names: exact, or a wildcard's subdomains; addresses: never this machine or a private network", () => {
    expect([allowedHost("registry.npmjs.org", ["registry.npmjs.org"]), allowedHost("REGISTRY.npmjs.org.", ["registry.npmjs.org"]),
      allowedHost("a.example.com", ["*.example.com"]), allowedHost("example.com", ["*.example.com"]), allowedHost("evilexample.com", ["*.example.com"])])
      .toEqual([true, true, true, false, false]);
    expect(["127.0.0.1", "10.1.2.3", "192.168.1.5", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0", "100.64.0.1"].filter(a => !privateAddress(a))).toEqual([]);
    expect(["93.184.215.14", "2606:4700::1111"].filter(privateAddress)).toEqual([]);
  });

  test("refuses hosts off the allowlist, other ports, and allowlisted names that resolve to this machine", async () => {
    const proxy = new EgressProxy({ hosts: () => ["localhost", "registry.example.test"] });
    const port = await proxy.port();
    expect(await raw(port, "CONNECT elsewhere.example.test:443 HTTP/1.1\r\nHost: elsewhere.example.test:443\r\n\r\n")).toStartWith("HTTP/1.1 403");
    expect(await raw(port, "CONNECT registry.example.test:22 HTTP/1.1\r\n\r\n")).toContain("only ports 80 and 443");
    expect(await raw(port, "CONNECT localhost:443 HTTP/1.1\r\n\r\n")).toContain("resolves to this machine or a private network");
    expect(await raw(port, "GET http://localhost/ HTTP/1.1\r\nHost: localhost\r\n\r\n")).toContain("resolves to this machine or a private network");
    proxy.close();
  });

  test("tunnels CONNECT and forwards plain HTTP, one request per connection", async () => {
    const upstream = await listen("pong");
    const proxy = new EgressProxy({ hosts: () => ["registry.example.test"], dial: () => dialed(connect({ host: "127.0.0.1", port: upstream })) });
    const port = await proxy.port();
    expect(await raw(port, "GET http://registry.example.test/ping HTTP/1.1\r\nHost: registry.example.test\r\nProxy-Connection: keep-alive\r\n\r\n")).toMatch(/^HTTP\/1\.1 200[\s\S]*pong$/);
    const tunnel = await raw(port, "CONNECT registry.example.test:443 HTTP/1.1\r\n\r\nGET /ping HTTP/1.1\r\nHost: registry.example.test\r\nConnection: close\r\n\r\n");
    expect(tunnel).toStartWith("HTTP/1.1 200 Connection Established\r\n\r\nHTTP/1.1 200");
    expect(tunnel).toEndWith("pong");
    proxy.close();
  });
});

const dialed = (s: Socket) => new Promise<Socket>((done, fail) => { s.once("connect", () => done(s)); s.once("error", fail); });

/** Send raw bytes to the proxy and read until it closes. */
function raw(port: number, request: string): Promise<string> {
  return new Promise((done, fail) => {
    const s = connect({ host: "127.0.0.1", port }, () => s.write(request));
    let out = "";
    s.on("data", d => { out += d.toString(); });
    s.on("close", () => done(out));
    s.on("error", fail);
    setTimeout(() => s.destroy(), 3000);
  });
}
