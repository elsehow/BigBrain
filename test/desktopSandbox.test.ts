import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, confinement, DEFAULT_HOSTS, workspace } from "../packages/agents/src";
import { hostAgents } from "../lib/agentHost";
import { CodingDesktops } from "../lib/codingDesktops";
import { desktopHosts, enginePorts, hostEntry, sandboxPolicy, saveDesktopHosts, savedDesktopHosts } from "../lib/desktopNetwork";
import { nativeVault } from "./support/vault";

const mac = process.platform === "darwin";
const roots: string[] = [];
const servers: Server[] = [];
afterAll(() => { roots.forEach(r => rmSync(r, { recursive: true, force: true })); servers.forEach(s => s.close()); });
const scratch = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "desktop-sandbox-"))); roots.push(d); return d; };
const vault = () => { const r = nativeVault(); roots.push(r); return r; };
const port = process.env.BIGBRAIN_WEB_PORT;
afterEach(() => { if (port === undefined) delete process.env.BIGBRAIN_WEB_PORT; else process.env.BIGBRAIN_WEB_PORT = port; });
const listen = (body: string) => new Promise<number>(done => {
  const s = createServer((_q, r) => r.end(body)).listen(0, "127.0.0.1", () => done((s.address() as { port: number }).port));
  servers.push(s);
});

describe("the desktop network setting", () => {
  test("takes host names, subdomain wildcards and local ports; never the engine's own", () => {
    expect(["Registry.Example.com.", "*.example.com", "localhost:5432"].map(hostEntry)).toEqual(["registry.example.com", "*.example.com", "localhost:5432"]);
    for (const bad of ["*", "example", "https://example.com", "exa mple.com", "localhost:0", "localhost:70000", `localhost:${enginePorts()[0]}`, "", 7])
      expect(() => hostEntry(bad)).toThrow();
  });

  test("the person's additions are kept beside the defaults, and a saved entry that no longer qualifies grants nothing", () => {
    const root = vault();
    expect(desktopHosts(root)).toEqual(DEFAULT_HOSTS);
    expect(saveDesktopHosts(root, ["pkgs.example.com", "registry.npmjs.org", "pkgs.example.com"])).toEqual(["pkgs.example.com"]);
    expect(desktopHosts(root)).toEqual([...DEFAULT_HOSTS, "pkgs.example.com"]);
    expect(() => saveDesktopHosts(root, ["not a host"])).toThrow("is not a host name");
    writeFileSync(join(root, ".env"), `BIGBRAIN_DESKTOP_HOSTS='["pkgs.example.com","*","localhost:${enginePorts()[0]}"]'\n`);
    expect(savedDesktopHosts(root)).toEqual(["pkgs.example.com"]);
    const desktops = new CodingDesktops(root, { agents: hostAgents(root, workspace(scratch())) });
    expect(desktops.network()).toEqual({ defaults: DEFAULT_HOSTS, hosts: ["pkgs.example.com"] });
    expect(() => desktops.setNetwork(["*"])).toThrow("is not a host name");
    desktops.close();
  });
});

describe("what desktops' commands are kept from", () => {
  test("credential stores, private data and the vault; only its secrets and machinery when the workspace is inside it", () => {
    const root = vault(), ws = scratch();
    const denied = sandboxPolicy(root, ws).deny!();
    for (const p of [canonical(root), join(canonical(root), ".env"), join(canonical(root), ".spool"), join(canonical(root), ".state"),
      join(homedir(), ".ssh"), join(homedir(), ".config", "gh"), join(homedir(), "Library", "Mail"), join(homedir(), "Library", "Application Support", "Google", "Chrome")])
      expect([...denied].map(canonical)).toContain(canonical(p));
    const inside = join(root, "agents");
    mkdirSync(inside);
    const partial = [...sandboxPolicy(root, inside).deny!()];
    expect(partial).not.toContain(canonical(root));
    expect(partial).toContain(join(canonical(root), ".env"));
    expect(sandboxPolicy(root, ws).ports!()).toEqual(enginePorts());
  });

  test.if(mac)("a host's desktop can't read the vault or reach the engine; a local port the person adds it can", async () => {
    const root = vault(), ws = workspace(scratch());
    writeFileSync(join(root, ".env"), "OPENAI_API_KEY='invented-key'\n");
    process.env.BIGBRAIN_WEB_PORT = String(await listen("the viewer"));
    const database = await listen("a database");
    const agents = hostAgents(root, ws, { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    const sh = async (command: string) => (await agents.harbor.run("desk-host", command, ws.root, undefined, confinement(ws, "desk-host", false))).output.trim();
    const curl = (p: number | string) => `(curl -s -m 2 http://127.0.0.1:${p}/ && echo) || echo refused`;
    expect(await sh(`cat '${join(root, ".env")}' 2>/dev/null || echo unreadable; ls '${root}' 2>/dev/null || echo unlistable; ${curl(process.env.BIGBRAIN_WEB_PORT)}; ${curl(database)}`))
      .toBe("unreadable\nunlistable\nrefused\nrefused");
    saveDesktopHosts(root, [`localhost:${database}`]);
    expect(await sh(curl(database))).toBe("a database");
  });
});

describe("Land", () => {
  test("needs the head the person reviewed", () => {
    const root = vault();
    const desktops = new CodingDesktops(root, { agents: hostAgents(root, workspace(scratch())) });
    const made = desktops.create();
    expect(() => desktops.land(made.id, "orrery", "auto", undefined)).toThrow("Review the changes before landing them.");
    expect(() => desktops.land(made.id, "orrery", "auto", "main")).toThrow("Review the changes before landing them.");
    desktops.close();
  });
});
