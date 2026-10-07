/**
 * env.ts — every environment variable the engine reads, named once.
 *
 * vault.yaml is the config a person edits (lib/manifest.ts). This is the
 * other configuration surface: the process environment, set by the launchd
 * plists, the `bigbrain` CLI for its children, the desktop supervisor, and
 * whoever is typing. It was read at 21 scattered call sites with no schema,
 * which is how "4747" came to be written in three files and "4748" in three
 * more — nothing could tell you what the engine was configurable BY.
 *
 * Readers are FUNCTIONS, never constants: bin/desktop.ts sets BIGBRAIN_VAULT
 * and BIGBRAIN_SUPERVISOR_PID for its children at runtime, and a constant
 * would capture the value before it.
 *
 * This module imports NOTHING, so anything may import it.
 */

const str = (name: string): string | undefined => {
  const v = process.env[name];
  return v?.trim() ? v.trim() : undefined;
};

/** A bare `PORT=` in the vault's .env reaches EVERY server the vault starts
 * (the supervisor passes the file's settings on, vaultEnvSettings), which is
 * why each has its own knob and this fallback is last. */
const port = (name: string, fallback: number): number =>
  Number(str(name) ?? str("PORT") ?? fallback);

// ── where the vault is ───────────────────────────────────────────────────────

/** Explicit vault, ahead of the cwd walk-up and the pointer file — see
 * lib/engine.ts's discoverVaultRoot for the full order. */
export const vaultOverride = (): string | undefined => str("BIGBRAIN_VAULT");
/** The SHARED vault bin/shared.ts serves — explicit only, never discovered
 * (docs/shared-vault.md): serving a vault to others is not an accident. */
export const sharedVaultOverride = (): string | undefined => str("BIGBRAIN_SHARED_VAULT");
export const pilotDevContextRoot = (): string | undefined => str("BIGBRAIN_PILOT_CONTEXT_ROOT");
export const pilotDevPort = (): number => Number(str("BIGBRAIN_PILOT_DEV_PORT") ?? 5220);
export const pilotDevUiPort = (): number => Number(str("BIGBRAIN_PILOT_UI_PORT") ?? 5221);

// ── ports ────────────────────────────────────────────────────────────────────

/** The web viewer (web/server.ts). Also the default in web/ui/vite.config.ts's
 * dev proxy, which cannot import this module — test/env.test.ts asserts the
 * two agree. */
export const webPort = (): number => port("BIGBRAIN_WEB_PORT", 4747);

/** The intake API (bin/api.ts) — the door the plugin and extension use. */
export const apiPort = (): number => port("BIGBRAIN_API_PORT", 4748);

/** The shared-vault server (bin/shared.ts) — a member-authenticated door
 * over ONE shared vault, loopback by default (docs/shared-vault.md). */
export const sharedPort = (): number => port("BIGBRAIN_SHARED_PORT", 4749);

// ── who is running ───────────────────────────────────────────────────────────

/** Set by bin/desktop.ts for everything it spawns: this process is running
 * inside the app, not from a shell or a scheduled job. */
export const isDesktop = (): boolean => Boolean(str("BIGBRAIN_DESKTOP"));

/** The app's supervisor pid, so a child can die with its parent
 * (lib/parentWatch.ts). */
export const supervisorPidEnv = (): number | undefined => {
  const n = Number(str("BIGBRAIN_SUPERVISOR_PID"));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Development mode: `--watch` on the app's children, and the bundled plugin
 * is not installed over the developer's own. */
export const isDev = (): boolean => Boolean(str("BIGBRAIN_DEV"));

// ── coding desktops (packages/agents) ────────────────────────────────────────

/** The workspace desktops' agents work in: projects/ and desktops/. Absent:
 * the package's default, ~/bigbrain. */
export const agentWorkspace = (): string | undefined => str("BIGBRAIN_WORKSPACE");

/** Dev only: a module whose default export hosts a scripted agent
 * (test/support/scriptedAgentHost.ts), for looking at v2 without a model. */
export const agentScript = (): string | undefined => (isDev() ? str("BIGBRAIN_AGENT_SCRIPT") : undefined);

/** Which role the caller runs as — the write guard's signal that a session
 * is the gardener rather than an interactive human. */
export const role = (): string | undefined => str("BIGBRAIN_ROLE");
/** App-issued worker identity for attributing MCP output receipts. */
export const workSessionId = (): string | undefined => str("BIGBRAIN_WORK_ID");

/** The vault owner's email, when the machine account isn't it. */
export const ownerEmail = (): string | undefined => str("BIGBRAIN_OWNER_EMAIL");

// ── credentials and stores ───────────────────────────────────────────────────

/** Override for the intake token store (lib/auth.ts). Minting as the wrong
 * user through this has broken auth for a whole tenant before — see
 * docs/self-host.md. */
export const tokenStore = (): string | undefined => str("BIGBRAIN_TOKENS");

/** Override for the client-token store (lib/auth.ts). */
export const clientTokenStore = (): string | undefined => str("BIGBRAIN_CLIENT_TOKENS");

/** Override for a shared vault's member store (lib/sharedMembers.ts) —
 * members and their credentials live OUTSIDE the vault, like drop tokens. */
export const sharedMemberStore = (): string | undefined => str("BIGBRAIN_SHARED_MEMBERS");

/** The shared door's public origin (`https://vault.example.com`). Setting it
 * — or `serve --public-url` — is what turns on the Claude connector
 * (docs/shared-vault-connector.md); unset, the door has no public surface. */
export const sharedPublicUrl = (): string | undefined => str("BIGBRAIN_SHARED_PUBLIC_URL");

/** The connector's "Sign in with Google" OAuth client. Both or neither. */
export const sharedGoogleClientId = (): string | undefined => str("BIGBRAIN_SHARED_GOOGLE_CLIENT_ID");
export const sharedGoogleClientSecret = (): string | undefined => str("BIGBRAIN_SHARED_GOOGLE_CLIENT_SECRET");

// ── test and diagnostic hooks ────────────────────────────────────────────────

/** Point the assertion projection at another SQLite file — how a bench or a
 * verification run reads a live vault without touching its projection. */
export const assertionDb = (): string | undefined => str("BIGBRAIN_ASSERTION_DB");

/** Suppress the retrieval log (a test reading a vault shouldn't write to it). */
export const noRetrievalLog = (): boolean => Boolean(str("BIGBRAIN_NO_RETRIEVAL_LOG"));

/** How many test files bin/test-parallel.ts runs at once; 0 = one per CPU. */
export const testJobs = (): number => Number(str("BIGBRAIN_TEST_JOBS") ?? 0);

// ── what a child inherits ────────────────────────────────────────────────────

/** Every bun process the engine starts runs with this flag. Bun otherwise
 * loads `<cwd>/.env` into process.env, and with cwd = the vault that file
 * holds provider keys and mail passwords; from process.env they would reach
 * every child. Credentials are read from the file when needed
 * (lib/envFile.ts readEnvValues); engine settings kept there are passed on
 * explicitly (vaultEnvSettings). */
export const NO_ENV_FILE = "--no-env-file";

/** The engine's own settings: the names the readers above take, plus the
 * runtime's. The supervisor and the CLI pass these to their children; the
 * credentials among the readers (CREDENTIAL_ENV) never. */
export const ENGINE_ENV = [
  "BIGBRAIN_VAULT", "BIGBRAIN_SHARED_VAULT", "BIGBRAIN_PILOT_CONTEXT_ROOT", "BIGBRAIN_PILOT_DEV_PORT", "BIGBRAIN_PILOT_UI_PORT",
  "PORT", "BIGBRAIN_WEB_PORT", "BIGBRAIN_API_PORT", "BIGBRAIN_SHARED_PORT",
  "BIGBRAIN_DESKTOP", "BIGBRAIN_SUPERVISOR_PID", "BIGBRAIN_DEV", "BIGBRAIN_WORKSPACE", "BIGBRAIN_AGENT_SCRIPT",
  "BIGBRAIN_ROLE", "BIGBRAIN_WORK_ID", "BIGBRAIN_OWNER_EMAIL",
  "BIGBRAIN_TOKENS", "BIGBRAIN_CLIENT_TOKENS", "BIGBRAIN_SHARED_MEMBERS", "BIGBRAIN_SHARED_PUBLIC_URL", "BIGBRAIN_SHARED_GOOGLE_CLIENT_ID",
  "BIGBRAIN_ASSERTION_DB", "BIGBRAIN_NO_RETRIEVAL_LOG", "BIGBRAIN_TEST_JOBS",
  "BIGBRAIN_POSTHOG_TOKEN", "BIGBRAIN_POSTHOG_REGION", "BIGBRAIN_SHARED_CONNECTIONS", "BIGBRAIN_FIREWALL_URL",
  "NODE_ENV", "PI_OFFLINE",
] as const;

/** Model providers' settings that Pi and the SDKs under it read from the
 * environment: where a model runs, which project or region bills it. None is a
 * credential. Keys reach Pi's runtime directly (lib/run/piModelRuntime.ts);
 * secrets kept in the vault's .env beside these (AWS_SECRET_ACCESS_KEY,
 * AWS_SESSION_TOKEN, AWS_BEARER_TOKEN_BEDROCK, *_CUSTOM_HEADERS) stay there. */
export const MODEL_ENV = [
  "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "ANTHROPIC_BASE_URL",
  "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS",
  "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_BEDROCK_BASE_URL", "AWS_BEDROCK_SKIP_AUTH", "AWS_BEDROCK_FORCE_HTTP1", "AWS_BEDROCK_FORCE_CACHE",
  "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID", "PI_CACHE_RETENTION",
] as const;

/** The settings a vault's .env may carry for the engine's processes. */
export const SETTINGS_ENV: readonly string[] = [...ENGINE_ENV, ...MODEL_ENV];

/** Credentials BigBrain manages, wherever they turn up. Per-account copies
 * carry a `__<ACCOUNT>` suffix (lib/integrationAccess.ts, lib/emailConfig.ts). */
export const CREDENTIAL_ENV = [
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GRANOLA_API_KEY", "THAT_TRACKS_API_KEY", "TYPESAFE_API_KEY",
  "BIGBRAIN_IMAP_PASSWORD", "BIGBRAIN_MCP_TOKEN", "BIGBRAIN_SHARED_GOOGLE_CLIENT_SECRET",
] as const;
export const isCredentialEnv = (name: string): boolean =>
  CREDENTIAL_ENV.some((c) => name === c || name.startsWith(`${c}__`));

/** OS basics, network trust, and where tools keep their own config. */
const BASICS = [
  "HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
];

const pick = (names: readonly string[], prefixes: readonly string[] = []): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v?.trim() && (names.includes(k) || prefixes.some((p) => k.startsWith(p))) && !isCredentialEnv(k)) env[k] = v;
  return env;
};

/** A handoff worker, or an external CLI (claude, codex), gets OS basics: not
 * the viewer's OpenAI key, mail passwords, or gardener role. MCP reads its
 * own config. */
export const handoffProcessEnv = (): Record<string, string> => pick(BASICS);

/** What `git` runs with: its own settings, and the ssh agent a push
 * authenticates through. */
export const gitProcessEnv = (): Record<string, string> => pick([...BASICS, "SSH_AUTH_SOCK"], ["GIT_"]);

/** What an engine child (a job, publish, init) inherits: everything git
 * gets, the engine's settings, and Pi's and the model providers' (the model
 * runtime runs in-process). */
export const engineProcessEnv = (): Record<string, string> =>
  pick([...BASICS, "SSH_AUTH_SOCK", ...SETTINGS_ENV], ["GIT_", "PI_"]);

/** Public ingestion settings; consent remains a separate installation preference. */
export const posthogToken = (): string | undefined => str("BIGBRAIN_POSTHOG_TOKEN");
export const posthogRegion = (): string | undefined => str("BIGBRAIN_POSTHOG_REGION");

/** Optional authenticated identity for live integration reads over local MCP. */
export const mcpIntegrationToken = (): string | undefined => str("BIGBRAIN_MCP_TOKEN");

/** Local remote-vault credentials. This store must live outside vault content. */
export const sharedConnectionsStore = (): string | undefined => str("BIGBRAIN_SHARED_CONNECTIONS");

/** A stand-in for Jev's endpoint under the intake firewall (lib/firewall.ts):
 * tests point it at a fake. Unset, the firewall asks Jev itself. */
export const firewallUrl = (): string | undefined => str("BIGBRAIN_FIREWALL_URL");
