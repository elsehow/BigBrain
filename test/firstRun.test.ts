/**
 * The desktop app's setup door (lib/firstRun.ts, #575): what a folder the
 * person names would become, which Claude Code is here, and whether this
 * machine's credential has ever existed. Nothing here touches the real
 * home, the real token store, or launchd.
 */
import {setupProgress,saveSetupProgress} from "../lib/setupProgress";
import {setupDone,vaultSetupDone} from "../web/ui/src/lib/setup";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintToken, revokeToken } from "../lib/auth";
import { connectTokenName } from "../lib/connect";
import { agentStatus, claudeAccount, expandPath, inspectFolder, setupRoutes, vaultCreated, type SetupState } from "../lib/firstRun";
import type { ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { dispatch, type Route } from "../lib/httpx";
import { latestUserIdentity } from "../lib/userIdentity";
import { nativeVault } from "./support/vault";

const tmp = (): string => mkdtempSync(join(tmpdir(), "bb-firstrun-"));

describe("inspectFolder", () => {
  test("missing → new; empty → empty; vault.yaml → adopted", () => {
    const home = tmp();
    expect(inspectFolder("~/vault", home, "/nowhere")).toMatchObject({ ok: true, path: join(home, "vault"), kind: "new" });
    mkdirSync(join(home, "empty"));
    expect(inspectFolder("~/empty", home, "/nowhere")).toMatchObject({ ok: true, kind: "empty" });
    mkdirSync(join(home, "empty", ".DS_Store"), { recursive: true }); // Finder droppings do not count
    expect(inspectFolder("~/empty", home, "/nowhere")).toMatchObject({ ok: true, kind: "empty" });
    mkdirSync(join(home, "v"));
    writeFileSync(join(home, "v", "vault.yaml"), "auth: max\n");
    writeFileSync(join(home, "v", "note.md"), "# hi\n");
    expect(inspectFolder("~/v", home, "/nowhere")).toMatchObject({ ok: true, kind: "vault" });
  });

  test("a folder holding something else is reported, with the count", () => {
    const home = tmp();
    mkdirSync(join(home, "Documents", "notes"), { recursive: true });
    for (const n of ["a.md", "b.md", "c.pdf"]) writeFileSync(join(home, "Documents", "notes", n), "");
    const v = inspectFolder("~/Documents/notes", home, "/nowhere");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.problem).toBe("~/Documents/notes is not a valid vault — pick an empty folder or an existing BigBrain vault.");
  });

  test("home, the engine, and a file are refused", () => {
    const home = tmp();
    const engine = join(home, "Projects", "BigBrain");
    mkdirSync(engine, { recursive: true });
    writeFileSync(join(home, "notes.txt"), "");
    expect(inspectFolder("~", home, engine)).toMatchObject({ ok: false, problem: "~ is your home folder — pick a folder inside it." });
    expect(inspectFolder("~/Projects/BigBrain", home, engine)).toMatchObject({ ok: false });
    expect(inspectFolder("~/notes.txt", home, engine)).toMatchObject({ ok: false, problem: "~/notes.txt is a file, not a folder." });
  });

  test("expandPath: ~, ~/x, absolute, and a bare name under home", () => {
    expect(expandPath("~", "/h")).toBe("/h");
    expect(expandPath(" ~/vault ", "/h")).toBe("/h/vault");
    expect(expandPath("/abs/v", "/h")).toBe("/abs/v");
    expect(expandPath("vault", "/h")).toBe("/h/vault");
  });
});

describe("claude", () => {


  test("claudeAccount: the signed-in email from ~/.claude.json, else null", () => {
    const home = tmp();
    expect(claudeAccount(home)).toBeNull();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@example.com" } }));
    expect(claudeAccount(home)).toBe("a@example.com");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
    expect(claudeAccount(home)).toBeNull();
    writeFileSync(join(home, ".claude.json"), "{not json");
    expect(claudeAccount(home)).toBeNull();
  });
});

describe("agentStatus", () => {
  test("none → null; a connect-minted token for this machine → live; revoked stays, as revoked", () => {
    const root = tmp();
    const store = join(root, "tokens.json");
    expect(agentStatus(root, store, "mac")).toBeNull();
    // a credential that is NOT this machine's connect: invisible here
    mintToken(store, root, "web shell", ["vault:read"], { kind: "agent" });
    expect(agentStatus(root, store, "mac")).toBeNull();
    const { record } = mintToken(store, root, connectTokenName("mac"), ["inbox:write", "vault:read"], { owner: "a@example.com", kind: "agent", via: "connect" });
    expect(agentStatus(root, store, "mac")).toEqual({ name: "claude code on mac", connected: record.created, lastUsed: null, revoked: null });
    revokeToken(store, record.id);
    const after = agentStatus(root, store, "mac");
    expect(after?.name).toBe("claude code on mac");
    expect(after?.revoked).not.toBeNull();
  });
});

describe("vaultCreated", () => {
  test("init's stamp, else null", () => {
    const root = tmp();
    expect(vaultCreated(root)).toBeNull();
    mkdirSync(join(root, ".state"));
    writeFileSync(join(root, ".state", "init.json"), JSON.stringify({ at: "2026-08-27T10:00:00.000Z", role: "host" }));
    expect(vaultCreated(root)).toBe("2026-08-27T10:00:00.000Z");
  });
});

// The four routes both servers mount (#639): bin/desktop.ts's door before a
// vault exists, web/server.ts's viewer once one does. They were written out
// twice, with answers that had drifted; this pins what only the ROOT
// decides between the two mounts.
describe("setupRoutes", () => {
  const state = (): SetupState => ({ vault: null, claude: { installed: false, version: null, account: null, plugin: null }, agent: null }) as unknown as SetupState;
  const mount = (root: string | null): Route[] =>
    setupRoutes({ root, state, onVault: () => {} });

  /** Drive one route and capture what it wrote. */
  const call = (routes: Route[], method: "GET" | "POST", path: string): { code: number; body: unknown } => {
    let code = 0;
    let body: unknown;
    const res = {
      writeHead: (c: number) => {
        code = c;
      },
      end: (b: string) => {
        body = JSON.parse(b);
      },
    } as unknown as ServerResponse;
    dispatch(routes, { url: path, method } as never, res);
    return { code, body };
  };

  /** POST one of the body-taking setup routes, and what it wrote back. */
  const postJson = async (
    routes: Route[],
    path: string,
    body: unknown
  ): Promise<{ code: number; body: unknown }> => {
    let code = 0;
    let answer: unknown;
    const res = {
      writeHead: (c: number) => {
        code = c;
      },
      end: (b: string) => {
        answer = JSON.parse(b);
      },
    } as unknown as ServerResponse;
    const req = Object.assign(new PassThrough(), { url: path, method: "POST" });
    dispatch(routes, req as never, res);
    req.end(JSON.stringify(body));
    await new Promise((r) => setTimeout(r, 10));
    return { code, body: answer };
  };
  const postVault = (routes: Route[], body: unknown) => postJson(routes, "/api/setup/vault", body);

  test("MCP setup pins the current vault and refuses before a vault exists", () => {
    expect(call(mount(null), "GET", "/api/setup/mcp").code).toBe(409);
    const response = call(mount("/local/vault"), "GET", "/api/setup/mcp");
    expect(response.code).toBe(200);
    expect(response.body).toMatchObject({ mcpServers: { bigbrain: { env: { BIGBRAIN_VAULT: "/local/vault" } } } });
    expect(JSON.stringify(response.body)).not.toContain("token");
  });

  test("the same paths, whichever side mounts them", () => {
    const paths = (root: string | null): string[] => mount(root).map((r) => `${r.method} ${r.path}`);
    expect(paths(null).length).toBeGreaterThan(0);
    expect(paths("/tmp/vault")).toEqual(paths(null));
  });

  test("new-vault optional setup resumes durably; existing vaults are not re-enrolled",async()=>{
    const root=nativeVault();expect(setupProgress(root)).toBeUndefined();
    expect((await postJson(mount(root),"/api/setup/progress",{step:"clients"})).code).toBe(400);
    expect(setupProgress(root)).toBeUndefined();
    const routes=setupRoutes({root,state:()=>({...state(),identity:{name:"Fixture",entity_id:"fixture"},anthropic:{connected:true,stage:"connected",models:[]}}),onVault:()=>{}});
    saveSetupProgress(root,"vault");
    expect((await postJson(routes,"/api/setup/progress",{step:"wrong"})).code).toBe(400);
    expect(setupProgress(root)).toBe("vault");
    for(const step of ["providers","clients","integrations","analytics","complete"]){
      expect((await postJson(routes,"/api/setup/progress",{step})).code).toBe(200);
      expect(setupProgress(root)).toBe(step);
    }
    const ready={vault:{path:root,created:null},identity:{name:"Fixture",entity_id:"fixture"},claude:{connected:true,installed:false as const,account:null,plugin:null},agent:null};
    expect(setupDone(ready)).toBe(true);expect(vaultSetupDone({...ready,onboarding:"integrations"})).toBe(true);
    expect(setupDone({...ready,onboarding:"integrations"})).toBe(false);expect(setupDone({...ready,onboarding:"complete"})).toBe(true);
  });

  test("a Pi Claude subscription completes provider setup without native clients", async () => {
    const root = nativeVault();
    const ready: SetupState = { vault: { path: root, created: null }, identity: { name: "Fixture", entity_id: "fixture" },
      claude: { installed: false, account: null, plugin: null }, agent: null,
      anthropic: { connected: true, phase: "connected" } };
    const routes = setupRoutes({ root, state: () => ready, onVault: () => {} });
    expect((await postJson(routes, "/api/setup/progress", { step: "clients" })).code).toBe(200);
    expect(vaultSetupDone(ready)).toBe(true);
    expect(setupDone({ ...ready, onboarding: "complete" })).toBe(true);
  });

  test("the name screen's route writes the declaration — the happy path first run takes", async () => {
    // 0.1.13–0.1.16 shipped this route reading `.name` off the raw body
    // STRING, so "a name is required" answered every name a person typed
    // and first run could not get past step 2 (reported 2026-09-01).
    const root = nativeVault();
    const r = await postJson(mount(root), "/api/setup/identity", { name: "  Ada Lovelace ", email: "ada@example.com" });
    expect(r.code).toBe(200);
    expect(latestUserIdentity(root)?.name).toBe("Ada Lovelace");
    expect(await postJson(mount(root), "/api/setup/identity", "not json at all")).toEqual({
      code: 400,
      body: { error: "a name is required" },
    });
  });

  test("the name screen carries a hosted-era dossier's labels along (#683)", async () => {
    const root = nativeVault();
    mkdirSync(join(root, "entities"), { recursive: true });
    writeFileSync(
      join(root, "entities", "ada-lovelace.md"),
      "---\ntitle: Ada Lovelace\nhuman_user: true\naliases:\n  - Ada\n  - ada@example.org\n---\nbody\n"
    );
    const r = await postJson(mount(root), "/api/setup/identity", { name: "Ada Lovelace", email: "ada@example.com" });
    expect(r.code).toBe(200);
    expect(latestUserIdentity(root)?.aliases).toEqual(["ada@example.com", "Ada", "ada@example.org"]);
  });

  test("the name screen's route refuses without a vault, and without a name", async () => {
    // Both refusals are the door's, not the writer's: there is nowhere to
    // append to, and an empty name would become an entity id of its own.
    expect(await postJson(mount(null), "/api/setup/identity", { name: "Ada" })).toEqual({
      code: 409,
      body: { error: "no vault yet — choose a folder first" },
    });
    expect(await postJson(mount("/tmp/vault"), "/api/setup/identity", { name: "  " })).toEqual({
      code: 400,
      body: { error: "a name is required" },
    });
  });

  test("retired native setup endpoints are inert with or without a vault", () => {
    for (const root of [null, "/tmp/vault"]) for (const path of ["connect", "plugin", "codex/login", "codex/connect"])
      expect(call(mount(root), "POST", `/api/setup/${path}`).code).toBe(410);
  });

  // The door opens carrying a verdict from an engine start that failed,
  // and any new choice makes it stale. A FRESH refusal rides the reply and
  // is gone — the card shows it, the next GET does not.
  test("a refused folder is not remembered; naming one clears what was", async () => {
    let carried: SetupState["pick"] = { path: "/old", problem: "the engine would not start there" };
    const routes = setupRoutes({
      root: null,
      state: () => ({ ...state(), ...(carried ? { pick: carried } : {}) }),
      onChoice: () => {
        carried = undefined;
      },
      onVault: () => {},
    });
    const answer = await postVault(routes, { path: "/etc/hosts" });
    expect((answer.body as { pick?: unknown }).pick).toEqual({
      path: "/etc/hosts",
      problem: "/etc/hosts is a file, not a folder.",
    });
    // The carried verdict is gone, and the fresh one was never stored.
    expect(carried).toBeUndefined();
    expect(call(routes, "GET", "/api/setup").body).not.toHaveProperty("pick");
  });

  test("GET /api/setup answers with whatever the mount says the state is", () => {
    expect(call(mount(null), "GET", "/api/setup").code).toBe(200);
    expect(call(mount(null), "GET", "/api/setup").body).toEqual(state() as unknown as Record<string, unknown>);
  });

  test("a vault pick with no path is a 400, before anything is inspected", async () => {
    expect(await postVault(mount(null), { path: "   " })).toEqual({
      code: 400,
      body: { error: "path is required" },
    });
  });
});

describe("joining a server from first run", () => {
  /** POST a route whose answer waits on the network, and wait for it. */
  const post = async (routes: Route[], path: string, body: unknown): Promise<{ code: number; body: Record<string, unknown> }> => {
    let code = 0, answer: Record<string, unknown> | undefined;
    const res = { writeHead: (c: number) => { code = c; }, end: (b: string) => { answer = JSON.parse(b); } } as unknown as ServerResponse;
    const req = Object.assign(new PassThrough(), { url: path, method: "POST" });
    dispatch(routes, req as never, res);
    req.end(JSON.stringify(body));
    for (let i = 0; i < 200 && answer === undefined; i++) await new Promise((r) => setTimeout(r, 10));
    return { code, body: answer! };
  };
  test("with no vault: a bad link makes nothing; a good one makes a vault quietly, connects, and lands as a reader", async () => {
    const home = tmp(), saved = { HOME: process.env.HOME, store: process.env.BIGBRAIN_SHARED_CONNECTIONS };
    const { SharedVault } = await import("../lib/sharedVault");
    const { makeSharedApiHandler } = await import("../lib/sharedVaultApi");
    const { initMemberStore } = await import("../lib/sharedMembers");
    const { createMemberInvite } = await import("../lib/sharedInvites");
    const { readConnections } = await import("../lib/sharedConnections");
    const { setupState } = await import("../lib/firstRun");
    const shared = join(home, "server"), members = join(home, "members.json");
    mkdirSync(shared);
    writeFileSync(join(shared, ".shared-identity.json"), JSON.stringify({ id: "garden", name: "Garden club" }));
    initMemberStore(members, shared, { handle: "owner", display: "Example Owner" });
    const handler = makeSharedApiHandler({ root: shared, storePath: members, vault: new SharedVault(shared), log: () => {} });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => handler(r) });
    process.env.HOME = home;
    process.env.BIGBRAIN_SHARED_CONNECTIONS = join(home, "connections.json");
    try {
      const vault = join(home, "vault"), endpoint = `http://127.0.0.1:${server.port}`;
      let opened: string | undefined;
      const routes = setupRoutes({ root: null, state: () => setupState(null, { suggested: vault }), onVault: (v) => { opened = v.path; } });
      const bad = await post(routes, "/api/setup/join", { invite: `${endpoint}/invite#${"x".repeat(43)}` });
      expect(bad.code).toBe(400);
      expect(existsSync(vault)).toBe(false);
      const { secret } = createMemberInvite(members, "Ines Example", "read", new Date());
      const ok = await post(routes, "/api/setup/join", { invite: `${endpoint}/invite#${secret}` });
      expect(ok.code).toBe(200);
      expect(ok.body.joined).toMatchObject({ name: "Garden club" });
      expect(opened).toBe(vault);
      expect(existsSync(join(vault, "vault.yaml"))).toBe(true);
      expect(setupProgress(vault)).toBe("reader");
      expect(readConnections(join(home, "connections.json")).map((c) => c.name)).toEqual(["Garden club"]);
      expect(setupDone(ok.body as unknown as SetupState)).toBe(true);
      expect(vaultSetupDone(ok.body as unknown as SetupState)).toBe(false);
    } finally {
      server.stop(true);
      process.env.HOME = saved.HOME;
      if (saved.store === undefined) delete process.env.BIGBRAIN_SHARED_CONNECTIONS; else process.env.BIGBRAIN_SHARED_CONNECTIONS = saved.store;
    }
  });
});
