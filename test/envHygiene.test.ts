/**
 * Vault credentials stay in the vault's .env. Engine processes start without
 * bun's .env autoload (NO_ENV_FILE) and give their children named variables
 * only, so a key reaches no job, git, client CLI or agent command by
 * inheritance. Every key and password here is invented.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostAgents } from "../lib/agentHost";
import { offMacLauncher } from "./support/launcher";
import { ENGINE_ROOT } from "../lib/engine";
import { CREDENTIAL_ENV, ENGINE_ENV, engineProcessEnv, gitProcessEnv, handoffProcessEnv, NO_ENV_FILE } from "../lib/env";
import { dropAutoloadedEnv, vaultEnvSettings } from "../lib/envFile";
import { optionalJevKey } from "../lib/jevSettings";
import { runClientCli } from "../lib/localClients";
import { refreshPlugin } from "../lib/pluginState";
import { apiKeyPresent, jobEnv } from "../lib/preflight";
import { workspace } from "../packages/agents/src";
import { gitVault, mdVault } from "./support/vault";

const SECRET = "sk-invented-not-a-key";
const CREDENTIALS = ["OPENAI_API_KEY", "GRANOLA_API_KEY__WORK", "BIGBRAIN_IMAP_PASSWORD__ME_EXAMPLE_COM", "VAULT_ONLY_TOKEN"];
const DOTENV = `${CREDENTIALS.map((k) => `${k}='${SECRET}'`).join("\n")}\nBIGBRAIN_WEB_PORT=4999\n`;

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "bb-env-hygiene-"));
  roots.push(dir);
  return dir;
};
const vault = (dotenv = DOTENV): string => {
  const root = mdVault({ files: { "vault.yaml": "integrations: {}\n", ".env": dotenv } });
  roots.push(root);
  return root;
};

/** This process as bun leaves one started in the vault without NO_ENV_FILE. */
async function autoloaded<T>(fn: () => T | Promise<T>, extra: Record<string, string> = {}): Promise<T> {
  const vars = { ...Object.fromEntries(CREDENTIALS.map((k) => [k, SECRET])), ...extra };
  const before = Object.keys(vars).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of before) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** A script that writes the environment it was given to `out`. */
function envDumper(dir: string, name: string, out: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n/usr/bin/env > '${out}'\nexit 1\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("the supervisor's jobs", () => {
  const probe = (): string => {
    const path = join(scratch(), "probe.ts");
    writeFileSync(path, "console.log(JSON.stringify(process.env));\n");
    return path;
  };

  test("a job sees the vault's settings, never its credentials", async () => {
    const root = vault(), script = probe();
    // The control: started the old way, bun hands the child the vault's .env.
    const loose = Bun.spawnSync([process.execPath, script], { cwd: root, env: { PATH: process.env.PATH } });
    expect(JSON.parse(loose.stdout.toString()).OPENAI_API_KEY).toBe(SECRET);

    const env = await autoloaded(() => {
      const r = Bun.spawnSync([process.execPath, NO_ENV_FILE, script], { cwd: root, env: jobEnv(root, { PORT: "4748" }) });
      return JSON.parse(r.stdout.toString()) as Record<string, string>;
    });
    expect(JSON.stringify(env)).not.toContain(SECRET);
    expect(env).toMatchObject({ BIGBRAIN_VAULT: root, BIGBRAIN_DESKTOP: "1", BIGBRAIN_WEB_PORT: "4999", PORT: "4748" });
  });

  test("model providers' settings in the vault's .env reach a job, and Pi sees them; their secrets do not", () => {
    const adc = join(scratch(), "adc.json");
    writeFileSync(adc, "{}\n");
    const root = vault([
      "GOOGLE_CLOUD_PROJECT=invented-project", "GOOGLE_CLOUD_LOCATION=us-central1", `GOOGLE_APPLICATION_CREDENTIALS=${adc}`,
      "AWS_PROFILE=invented", "AWS_REGION=us-east-1", "OPENAI_BASE_URL=https://models.example.invalid/v1",
      `AWS_SECRET_ACCESS_KEY=${SECRET}`, `AWS_SESSION_TOKEN=${SECRET}`, `AWS_BEARER_TOKEN_BEDROCK=${SECRET}`, `OPENAI_CUSTOM_HEADERS=${SECRET}`,
    ].join("\n") + "\n");
    // pi-ai checks for credential files once its fs import lands, a tick after load.
    const code = `const { getEnvApiKey } = await import(${JSON.stringify(Bun.resolveSync("@earendil-works/pi-ai/compat", import.meta.dir))});
      await new Promise((r) => setTimeout(r, 50));
      console.log(JSON.stringify({ vertex: getEnvApiKey("google-vertex"), bedrock: getEnvApiKey("amazon-bedrock"), env: process.env }));`;
    const r = Bun.spawnSync([process.execPath, NO_ENV_FILE, "-e", code], { cwd: root, env: jobEnv(root) });
    const { vertex, bedrock, env } = JSON.parse(r.stdout.toString()) as { vertex?: string; bedrock?: string; env: Record<string, string> };
    expect({ vertex, bedrock }).toEqual({ vertex: "<authenticated>", bedrock: "<authenticated>" });
    expect(env).toMatchObject({ GOOGLE_CLOUD_PROJECT: "invented-project", AWS_REGION: "us-east-1", OPENAI_BASE_URL: "https://models.example.invalid/v1" });
    expect(JSON.stringify(env)).not.toContain(SECRET);
  });

  test("a variable already in the environment beats the vault's setting, as it did over the autoload", () => {
    const root = vault();
    expect(vaultEnvSettings(root)).toEqual({ BIGBRAIN_WEB_PORT: "4999" });
    const before = process.env.BIGBRAIN_WEB_PORT;
    process.env.BIGBRAIN_WEB_PORT = "4757";
    try {
      expect(jobEnv(root).BIGBRAIN_WEB_PORT).toBe("4757");
    } finally {
      if (before === undefined) delete process.env.BIGBRAIN_WEB_PORT;
      else process.env.BIGBRAIN_WEB_PORT = before;
    }
  });

  test("a process bun did load the file into drops what it named, keeping engine settings", () => {
    const root = vault(`${DOTENV}export lower_case_token=${SECRET}\n# COMMENTED=1\n`);
    const env: Record<string, string | undefined> = {
      ...Object.fromEntries(CREDENTIALS.map((k) => [k, SECRET])),
      lower_case_token: SECRET, COMMENTED: "1", BIGBRAIN_WEB_PORT: "4999", PATH: "/bin",
    };
    dropAutoloadedEnv(env, root);
    expect(env).toEqual({ COMMENTED: "1", BIGBRAIN_WEB_PORT: "4999", PATH: "/bin" });
  });
});

describe("what children inherit", () => {
  test("no allowlist carries a credential, even one this process holds", async () => {
    const envs = await autoloaded(() => [handoffProcessEnv(), gitProcessEnv(), engineProcessEnv()], {
      SSH_AUTH_SOCK: "/tmp/invented-agent.sock", GIT_SSH_COMMAND: "ssh -F /dev/null", ANTHROPIC_API_KEY: SECRET, TYPESAFE_API_KEY: SECRET,
    });
    for (const env of envs) expect(JSON.stringify(env)).not.toContain(SECRET);
    const [handoff, git, engine] = envs;
    expect(handoff!.SSH_AUTH_SOCK).toBeUndefined();
    expect(git).toMatchObject({ SSH_AUTH_SOCK: "/tmp/invented-agent.sock", GIT_SSH_COMMAND: "ssh -F /dev/null" });
    expect(engine).toMatchObject({ SSH_AUTH_SOCK: "/tmp/invented-agent.sock", BIGBRAIN_VAULT: process.env.BIGBRAIN_VAULT! });
  });

  test("every variable lib/env.ts reads is a setting jobs inherit or a credential they never do", () => {
    const src = readFileSync(join(ENGINE_ROOT, "lib", "env.ts"), "utf8");
    const read = [...src.matchAll(/\b(?:str|port)\("([A-Z_]+)"/g)].map((m) => m[1]!);
    expect(read.length).toBeGreaterThan(20);
    const known: readonly string[] = [...ENGINE_ENV, ...CREDENTIAL_ENV];
    expect(read.filter((name) => !known.includes(name))).toEqual([]);
    expect(ENGINE_ENV.filter((name) => (CREDENTIAL_ENV as readonly string[]).includes(name))).toEqual([]);
  });

  // A spawn given no env inherits the environment bun STARTED with, whatever
  // process.env says since, so this one needs a process bun really loaded
  // the vault's .env into.
  test("git runs without them, even from a process bun loaded the vault's .env into", () => {
    const root = gitVault({ files: { ".env": DOTENV } });
    roots.push(root);
    const code = `const { spawnSync } = await import("node:child_process");
      const { gitOut } = await import(${JSON.stringify(join(ENGINE_ROOT, "lib", "git.ts"))});
      const args = ["-c", "alias.environment=!env", "environment"];
      console.log(JSON.stringify({ inherited: spawnSync("git", args, { encoding: "utf8" }).stdout, ours: gitOut(process.cwd(), args) }));`;
    const r = Bun.spawnSync([process.execPath, "-e", code], { cwd: root, env: { PATH: process.env.PATH, HOME: root } });
    const { inherited, ours } = JSON.parse(r.stdout.toString()) as { inherited: string; ours: string };
    expect(inherited).toContain(SECRET); // the control: what git got before
    expect(ours).toContain("HOME=");
    expect(ours).not.toContain(SECRET);
  });

  test("a client's CLI (claude, codex) runs without them", async () => {
    const dir = scratch(), out = join(dir, "env.txt");
    await autoloaded(() => expect(() => runClientCli(envDumper(dir, "codex", out), ["mcp", "add"])).toThrow());
    expect(readFileSync(out, "utf8")).toContain("HOME=");
    expect(readFileSync(out, "utf8")).not.toContain(SECRET);

    // The plugin refresh, against a stale install, with a `claude` that records what it got.
    const bin = join(dir, "bin"), config = join(dir, "claude");
    mkdirSync(bin);
    mkdirSync(join(config, "plugins"), { recursive: true });
    writeFileSync(join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "bigbrain@bigbrain": [{ scope: "user", version: "0.0.1", installPath: "/x" }] } }));
    envDumper(bin, "claude", join(dir, "claude-env.txt"));
    const r = await autoloaded(() => refreshPlugin(ENGINE_ROOT, { configDir: config, path: bin }));
    expect(r.outcome).toBe("failed");
    expect(readFileSync(join(dir, "claude-env.txt"), "utf8")).toContain("HOME=");
    expect(readFileSync(join(dir, "claude-env.txt"), "utf8")).not.toContain(SECRET);
  });

  test("a desktop agent's commands carry none of the vault's names, whatever the login shell exports", async () => {
    const root = vault(), dir = scratch();
    const env = { PATH: process.env.PATH, HOME: dir, OPENAI_API_KEY: SECRET, VAULT_ONLY_TOKEN: SECRET, TYPESAFE_API_KEY: SECRET, LATER_TOKEN: "invented-later", PROJECT_SETTING: "kept" };
    const agents = hostAgents(root, workspace(dir), { env, launcher: offMacLauncher });
    // its own git, cp and gh get git's environment, never this process's
    const own = await autoloaded(() => agents.ws.env?.());
    expect(own).toMatchObject({ HOME: process.env.HOME! });
    expect(JSON.stringify(own)).not.toContain(SECRET);
    const first = await agents.harbor.run("desk-env", "env", dir);
    expect(first.status).toBe("exited");
    expect(first.output).toContain("PROJECT_SETTING=kept");
    expect(first.output).toContain("LATER_TOKEN=invented-later");
    expect(first.output).not.toContain(SECRET);
    // a key saved after the desktop opened is withheld from its next command
    writeFileSync(join(root, ".env"), `${DOTENV}LATER_TOKEN='another-invented'\n`);
    expect((await agents.harbor.run("desk-env", "env", dir)).output).not.toContain("LATER_TOKEN");
  });
});

describe("credentials are read from the vault's .env, not the environment", () => {
  test("the legacy Jev key in the vault's .env still counts", () => {
    const root = vault(`TYPESAFE_API_KEY='example-vault-key'\n`), store = join(scratch(), "shared-connections.json");
    const before = process.env.BIGBRAIN_VAULT;
    process.env.BIGBRAIN_VAULT = root;
    try {
      expect(optionalJevKey(store)).toBe("example-vault-key");
    } finally {
      process.env.BIGBRAIN_VAULT = before;
    }
  });

  test("a key only in this process's environment is not one the gardener can use", async () => {
    const root = vault("");
    expect(await autoloaded(() => apiKeyPresent(root), { ANTHROPIC_API_KEY: SECRET })).toBe(false);
    expect(apiKeyPresent(vault(`ANTHROPIC_API_KEY='${SECRET}'\n`))).toBe(true);
  });
});
