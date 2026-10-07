import { MODEL_DEFAULTS } from "../lib/modelDefaults";
/**
 * init.ts — the mechanical first-run backend. The /setup skill (or a person
 * with flags) decides WHAT the vault should be; this writes it: preflight,
 * vault.yaml from vault.example.yaml, the directory skeleton, .env, git
 * wiring, the first commit, and the bin/install.ts handoff. Non-interactive
 * by design — the interview lives in .claude/skills/setup/, and a second
 * readline UI here would just drift from it.
 *
 * The engine (this checkout) and the vault (the target) are separate
 * directories: the vault root comes from BIGBRAIN_VAULT — the `bigbrain`
 * wrapper seeds it from --vault / env / cwd — and all engine artifacts
 * (vault.example.yaml, .env.example, prompts defaults, the scaffold) are
 * read from ENGINE_ROOT.
 *
 * Usage:
 *   bigbrain init --check                   # read-only state report (JSON)
 *   bigbrain init --vault <path> --json     # InitSpec on stdin (the /setup path)
 *   bigbrain init --vault <path> --defaults
 * Flags: --dry-run (report, write nothing) · --no-install
 *        --make-default (point this machine at the new vault even if it
 *        already opens another one — init claims an unset pointer by
 *        itself, but never retargets a machine silently; #604)
 *
 * There is no `--role` any more: the `client` mirror retired on 2026-08-30
 * and the `host` install on 2026-08-31 (#645), which left one kind of vault
 * on one machine. A spec that still carries `role` is accepted and ignored,
 * so an old /setup payload keeps working.
 *
 * Idempotent: everything is guarded, so re-running after a partial failure
 * finishes the job instead of clobbering it. An existing vault.yaml or .env
 * is validated and left alone (the env map still merges into .env).
 * Emits one InitResult JSON line on stdout; the human log goes to stderr.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseDocument, Scalar } from "yaml";
import { loadManifest, type Auth } from "../lib/manifest";
import { VAULT_ROOT } from "../lib/vaultRoot";
import { ENGINE_ROOT, pointerPlan, readPointer, vaultPointer } from "../lib/engine";
import { engineProcessEnv, gitProcessEnv, NO_ENV_FILE } from "../lib/env";
import {
  ensureStoragePlanes,
  scaffoldVault,
} from "../lib/scaffold";
import { ensureDir, writeAtomic } from "../lib/fsx";
import { commitAs } from "../lib/git";
import { writeEnvValues } from "../lib/envFile";
import {
  runPreflight,
  type Check,
} from "../lib/preflight";
import { hookInstalled } from "../lib/hook";
import { hasFlag } from "../lib/cliflags";

const root = VAULT_ROOT;
const log = (msg: string): void => void console.error(`init: ${msg}`);

interface InitSpec {
  auth?: Auth;
  /** vault.yaml integration entries, replacing the example's wholesale
   * (e.g. {"email": {"allowlist": [...]}, "granola": {}}). An entry present
   * here is enabled unless it carries `enabled: false`. */
  integrations?: Record<string, Record<string, unknown>>;
  /** Merged into .env — replaces the key's line (commented or not) or
   * appends. Secrets ride stdin, never shell history. */
  env?: Record<string, string>;
  install?: boolean;
  /** Take over the machine's default-vault pointer even when it already
   * names another vault (the `--make-default` flag). An unset pointer is
   * claimed either way. */
  makeDefault?: boolean;
}

interface InitResult {
  ok: boolean;
  wrote: string[];
  committed: boolean;
  warnings: string[];
  next: string[];
  /** The machine's default-vault pointer after this run: the file, the
   * vault it opens (not always `root` — init leaves someone else's pointer
   * alone), and what it replaced when it did move. */
  pointer?: { path: string; opens: string; changed: boolean; replaced?: string };
  error?: string;
}

const has = (name: string): boolean => hasFlag(process.argv, name);

// ── --check: the read-only state report the /setup skill branches on ────────
if (has("check")) {
  // init writes .state/init.json last, so its presence means a completed
  // init — the "set up" signal /setup branches on.
  const initialized = existsSync(join(root, ".state", "init.json"));

  let vaultYaml: "missing" | "valid" | "invalid" = "missing";
  let vaultYamlError: string | undefined;
  let auth: Auth = "max";
  let agent: "claude" | "codex" | "pi" = "pi";
  if (existsSync(join(root, "vault.yaml"))) {
    try {
      const m = loadManifest(root);
      auth = m.auth;
      agent = m.curation?.agent ?? "pi";
      vaultYaml = "valid";
    } catch (e) {
      vaultYaml = "invalid";
      vaultYamlError = e instanceof Error ? e.message : String(e);
    }
  }

  const gitIdentity =
    spawnSync("git", ["config", "user.name"], { encoding: "utf8", env: gitProcessEnv() }).status === 0 ||
    spawnSync("git", ["config", "--global", "user.name"], { encoding: "utf8", env: gitProcessEnv() }).status === 0;

  console.log(
    JSON.stringify({
      initialized,
      vaultYaml,
      ...(vaultYamlError ? { vaultYamlError } : {}),
      gitIdentity,
      hookInstalled: hookInstalled(root),
      checks: runPreflight({ auth, agent, root }),
    })
  );
  process.exit(0);
}

// ── assemble the spec: stdin JSON, or flags ──────────────────────────────────
let spec: InitSpec;
if (has("json")) {
  const raw = await Bun.stdin.text();
  if (!raw.trim()) {
    console.error("init: --json expects an InitSpec on stdin");
    process.exit(2);
  }
  try {
    spec = JSON.parse(raw) as InitSpec;
  } catch {
    console.error("init: stdin is not valid JSON");
    process.exit(2);
  }
} else {
  spec = {};
  if (!has("defaults")) {
    console.error(
      "init: pass --defaults to accept vault.example.yaml as-is (or use --json / the /setup interview)"
    );
    process.exit(2);
  }
}

const dryRun = has("dry-run");
const noInstall = has("no-install") || spec.install === false;
const result: InitResult = {
  ok: false,
  wrote: [],
  committed: false,
  warnings: [],
  next: [],
};

function fail(msg: string): never {
  result.error = msg;
  console.log(JSON.stringify(result));
  process.exit(1);
}

try {
  // ── validate the whole spec before writing anything ───────────────────────
  if (spec.auth !== undefined && spec.auth !== "max" && spec.auth !== "api")
    fail(`auth must be "max" or "api", got ${JSON.stringify(spec.auth)}`);
  if (root === ENGINE_ROOT)
    fail(
      "the engine checkout is not a vault — pass --vault <path> (bigbrain init --vault ~/vault …)"
    );

  // ── preflight ──────────────────────────────────────────────────────────────
  if (!dryRun) ensureDir(root); // the vault dir may not exist yet
  const checks: Check[] = runPreflight({ auth: spec.auth ?? "max", root });
  const failed = checks.filter((c) => !c.ok && c.level === "fail");
  const warned = checks.filter((c) => !c.ok && c.level === "warn");
  for (const c of warned) {
    log(`warning — ${c.detail}${c.fix ? `: ${c.fix}` : ""}`);
    result.warnings.push(`${c.name}: ${c.fix ?? c.detail}`);
  }
  for (const c of failed) log(`FAIL — ${c.detail}${c.fix ? `: ${c.fix}` : ""}`);
  if (failed.length && !dryRun)
    fail(`Setup needs attention. ${failed.map(c => `${c.detail}: ${c.fix ?? "resolve this prerequisite and try again"}`).join(". ")}. Then choose the folder again.`);

  // ── vault.yaml: generate from the example, or validate and leave ──────────
  const yamlPath = join(root, "vault.yaml");
  if (existsSync(yamlPath)) {
    loadManifest(root); // throws with the real reason if it's broken
    log("vault.yaml exists — leaving it");
  } else if (!dryRun) {
    const examplePath = join(ENGINE_ROOT, "vault.example.yaml");
    if (!existsSync(examplePath))
      fail("vault.example.yaml is missing from the engine — this checkout is incomplete");
    const doc = parseDocument(readFileSync(examplePath, "utf8"));

    for (const role of ["gardener", "memory", "quick"] as const) {
      doc.setIn([role, "model"], MODEL_DEFAULTS.anthropic[role].model);
      doc.setIn([role, "adapter"], "pi");
      doc.setIn([role, "provider"], "anthropic");
      doc.setIn([role, "preference"], spec.auth === "api" ? "pinned" : "recommended");
    }

    if (spec.auth) (doc.getIn(["auth"], true) as Scalar).value = spec.auth;

    // Written verbatim since 2026-08-10. A spec naming email used to also
    // scaffold an outbound block so notifications could reach the person;
    // both left the engine, and init no longer invents integrations.
    const integrations = { ...spec.integrations };
    for (const [name, cfg] of Object.entries(integrations)) {
      doc.setIn(["integrations", name], doc.createNode(cfg));
    }

    writeAtomic(yamlPath, doc.toString());
    try {
      loadManifest(root); // the gate: never leave an invalid vault.yaml behind
    } catch (e) {
      unlinkSync(yamlPath);
      fail(
        `generated vault.yaml failed validation (removed): ${e instanceof Error ? e.message : e}`
      );
    }
    result.wrote.push("vault.yaml");
    log("vault.yaml written");
  }

  // ── scaffold: the tracked-but-empty dirs need .gitkeep to survive git ─────
  const manifest = !dryRun || existsSync(yamlPath) ? loadManifest(root) : undefined;
  // inbox/unsorted is the one tracked-but-empty dir a NEW vault still needs
  // (it is a live read tree — lib/noteRead.ts's READ_TREES, the viewer's
  // unsorted bucket). requests/done, journal/triage and journal/deep were
  // scaffolded here until 2026-08-30: reference-era trees no code writes any
  // more, created empty in every fresh vault so that a `.gitkeep` was the
  // only thing in them, forever.
  const keepDirs = ["inbox/unsorted"];
  for (const rel of keepDirs) {
    const dir = join(root, rel);
    if (dryRun) continue;
    if (!existsSync(dir) || !readdirSync(dir).length) {
      writeAtomic(join(dir, ".gitkeep"), ""); // writeAtomic creates the dir
      result.wrote.push(`${rel}/.gitkeep`);
    }
  }
  if (!dryRun) ensureDir(join(root, ".state", "logs"));

  // ── references + .blobs: the storage planes, needed from first install ─────────
  if (!dryRun) result.wrote.push(...ensureStoragePlanes(root));

  // ── the generated files (CLAUDE.md, .claude/, .gitignore) ────────────────
  // Engine-owned, refreshed by every `bigbrain install`. Prompts are NOT
  // seeded: they ship with the engine and a vault reads them from there
  // unless it keeps its own copy (#524).
  if (!dryRun) result.wrote.push(...scaffoldVault(root));

  // ── .env: copy the example once, then merge the spec's keys ───────────────
  const envPath = join(root, ".env");
  if (!dryRun) {
    if (!existsSync(envPath) && existsSync(join(ENGINE_ROOT, ".env.example"))) {
      writeAtomic(envPath, readFileSync(join(ENGINE_ROOT, ".env.example"), "utf8"));
      result.wrote.push(".env");
      log(".env created from .env.example");
    }
    const env = spec.env ?? {};
    if (Object.keys(env).length) {
      for (const key of Object.keys(env))
        if (!/^[A-Z][A-Z0-9_]*$/.test(key))
          fail(`env key ${JSON.stringify(key)} is not a plausible variable name`);
      // The one .env writer (lib/envFile.ts): values land shell-single-quoted,
      // so a dot-sourced file cannot execute them — the #550 injection shape
      // the KEY=value regex that used to live here would reproduce (#635).
      writeEnvValues(root, env);
      if (!result.wrote.includes(".env")) result.wrote.push(".env");
      log(`.env: ${Object.keys(env).join(", ")} set`);
    }
  }

  // ── git wiring ─────────────────────────────────────────────────────────────
  const git = (args: string[]): { status: number; out: string } => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8", env: gitProcessEnv() });
    return { status: r.status ?? 1, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
  };
  if (!dryRun) {
    if (git(["rev-parse", "--git-dir"]).status !== 0) {
      git(["init", "-b", "main"]);
      log("git repository initialized");
    }
    // The vault repo is ONLY the vault: its origin is the user's private
    // backup (bigbrain publish pushes there, fail-soft until it exists).
    // The engine repo's remotes are its own business — `git pull` there.
    if (git(["remote", "get-url", "origin"]).status !== 0)
      result.next.push(
        "optional offsite backup: create a PRIVATE repo and `git remote add origin <url>` (bigbrain publish pushes there; fail-soft until then)"
      );

    // ── the first commit (no-op when nothing staged) ─────────────────────────
    const stage = result.wrote.filter((p) => p !== ".env"); // .env is gitignored
    if (stage.length) {
      result.committed = commitAs(root, "init", "init: vault scaffolded", stage);
      if (result.committed) log("initial commit made (author: init)");
    }
  }

  // ── install handoff ────────────────────────────────────────────────────────
  // `bigbrain install` no longer loads anything (#645): it refreshes the
  // vault's generated files and points `~/.local/bin/bigbrain` at this
  // engine. Worth running here so a vault made from the CLI has a working
  // command; the app supplies its own shim and passes `install: false`.
  //
  // The guard that used to sit here looked up a preflight check named
  // `gui-session`, which preflight calls `scheduler-session` — so it never
  // matched and this branch always ran, which is how a machine that only
  // meant to smoke-test init ended up with launchd jobs. Nothing to guard
  // now.
  if (dryRun || noInstall) {
    result.next.push("run `bigbrain install` to link the command and refresh the scaffold");
  } else {
    const r = spawnSync("bun", [NO_ENV_FILE, join(ENGINE_ROOT, "bin", "install.ts")], {
      cwd: root,
      encoding: "utf8",
      env: { ...engineProcessEnv(), BIGBRAIN_VAULT: root },
    });
    process.stderr.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    if (r.status !== 0)
      fail("bigbrain install failed — its output is on stderr; it is safe to re-run");
  }

  // The machine's default vault. init claims an unset pointer, and one it
  // is told to take; it will not retarget a machine that already opens a
  // different vault, because creating a second vault is routine (a scratch
  // one for a test) and losing the real pointer is not (#604).
  if (!dryRun) {
    const plan = pointerPlan(readPointer(), root, has("make-default") || spec.makeDefault === true);
    result.pointer = { path: vaultPointer(), ...plan };
    if (plan.changed) {
      writeAtomic(vaultPointer(), root + "\n");
      log(
        plan.replaced
          ? `default vault: ${plan.replaced} → ${root} (${vaultPointer()})`
          : `default vault → ${root} (${vaultPointer()})`
      );
    } else if (plan.opens !== root) {
      log(`this machine still opens ${plan.opens} — ${root} is a second vault, not the default`);
      result.next.push(
        `open this vault with \`bigbrain --vault ${root} …\`, or make it the machine's default: ` +
          `bigbrain init --vault ${root} --defaults --make-default`
      );
    }
  }

  if (!hookInstalled(root))
    result.next.push(
      "install the interactive write guard: bigbrain hook --apply (bigbrain hook previews it)"
    );
  const needsKeys = Object.keys(manifest?.integrations ?? {}).filter(
    (n) =>
      (n === "email" || n === "granola") && (manifest!.integrations[n] ?? {})["enabled"] !== false
  );
  if (needsKeys.length && !Object.keys(spec.env ?? {}).length)
    result.next.push(`fill the ${needsKeys.join("/")} credentials in .env (see .env.example)`);

  result.next.push(
    `open BigBrain and connect your subscription in Settings > Models`
  );
  if (!dryRun)
    writeAtomic(
      join(root, ".state", "init.json"),
      JSON.stringify({ at: new Date().toISOString() }) + "\n"
    );
  result.ok = true;
  console.log(JSON.stringify(result));
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
