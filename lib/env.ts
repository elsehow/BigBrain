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
 * (bun autoloads .env with cwd = vault), which is why each has its own knob
 * and this fallback is last. */
const port = (name: string, fallback: number): number =>
  Number(str(name) ?? str("PORT") ?? fallback);

// ── where the vault is ───────────────────────────────────────────────────────

/** Explicit vault, ahead of the cwd walk-up and the pointer file — see
 * lib/engine.ts's discoverVaultRoot for the full order. */
export const vaultOverride = (): string | undefined => str("BIGBRAIN_VAULT");
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

// ── test and diagnostic hooks ────────────────────────────────────────────────

/** Point the assertion projection at another SQLite file — how a bench or a
 * verification run reads a live vault without touching its projection. */
export const assertionDb = (): string | undefined => str("BIGBRAIN_ASSERTION_DB");

/** Suppress the retrieval log (a test reading a vault shouldn't write to it). */
export const noRetrievalLog = (): boolean => Boolean(str("BIGBRAIN_NO_RETRIEVAL_LOG"));

/** A handoff worker gets authentication and OS basics, not the viewer's
 * OpenAI key, mail passwords, or gardener role. MCP reads its own config. */
export function handoffProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]) {
    const value = str(name);
    if (value) env[name] = value;
  }
  return env;
}

/** Public ingestion settings; consent remains a separate installation preference. */
export const posthogToken = (): string | undefined => str("BIGBRAIN_POSTHOG_TOKEN");
export const posthogRegion = (): string | undefined => str("BIGBRAIN_POSTHOG_REGION");

/** Optional authenticated identity for live integration reads over local MCP. */
export const mcpIntegrationToken = (): string | undefined => str("BIGBRAIN_MCP_TOKEN");
