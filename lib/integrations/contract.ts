/** contract.ts — what one integration declares.
 *
 * Every live source BigBrain connects declares, once, in its own file here:
 * its accounts and the credential behind each, the fingerprint that notices a
 * change to either, how the library and Settings describe it, the origin its
 * material carries to agents, and the fixed tools agents may call on it.
 * lib/integrations/index.ts lists them, and everything per-integration that
 * used to be spelled out by name is derived from these declarations: the
 * managed set and account policies (lib/integrationAccess.ts), capabilities,
 * the MCP and Pilot tool lists and the one call path (lib/integrationTools.ts),
 * the provenance a read carries, and the notice a coding desktop shows when a
 * read taints it (lib/codingDesktops.ts).
 *
 * Nothing an integration imports at load may reach back to the registry
 * (lib/integrationAccess.ts, lib/integrationTools.ts, this directory's index):
 * they are built on it, and it must finish loading beneath them. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sha256hex } from "../hash";
import type { HardcoverOptions } from "../hardcover";
import type { InboxClientFactory } from "../liveInbox";
import type { SignInStatus } from "../oauthSignIn";
import type { OriginKind } from "../provenance";
import type { Tally } from "../agentReads";

/** Test seams for providers, and the caller's own cancellation. */
export interface IntegrationCallOptions { signal?: AbortSignal; client?: InboxClientFactory; granola?: { endpoint?: string }; hardcover?: HardcoverOptions }

/** A sign-in the person makes in their own browser (lib/oauthSignIn.ts), as Settings drives it. */
export interface BrowserSignIn {
  /** Returns the URL for the app to open; `onConnected` runs once the sign-in is kept. */
  start(root: string, account: string, onConnected: () => void): Promise<SignInStatus>;
  status(root: string, account: string): SignInStatus | undefined;
  cancel(root: string, account: string): void;
  /** Forgets the account's sign-in. */
  disconnect(root: string, account: string): void;
  /** Who is signed in, as Settings shows it; a change on reconnect resets the account's access. */
  identity(root: string, account: string): unknown;
  /** Kept, but no longer renewable: only signing in again restores it. */
  lapsed?(root: string, account: string): boolean;
}

export interface ToolContext {
  root: string;
  /** The account this call reads, resolved and authorized before `run`. */
  account: string;
  /** Aborts when the caller gives up or its access is withdrawn mid-call. */
  signal: AbortSignal;
  /** Throws unless the caller still holds the access this tool needs: call it before each provider step. */
  authorize: () => void;
  options: IntegrationCallOptions;
}

export interface IntegrationTool {
  /** The name agents call it by, unique across integrations: client permission prompts are per name. */
  name: string;
  description: string;
  /** Strict: a key it doesn't declare is refused, never passed along. */
  input: z.ZodObject;
  /** The JSON Schema clients see, derived from `input`. */
  inputSchema: Record<string, unknown>;
  access: "read" | "write";
  /** What it brings in from outside, as a coding desktop's taint notice names it ("your inbox"). Its results carry the integration's origin. */
  reads?: string;
  /** Runs with arguments `input` has validated. */
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>;
  /** The result as an agent receives it: outside text screened and fenced, what was withheld counted in `tally`. */
  forAgent?(result: unknown, tally: Tally, now?: number): unknown;
}

export interface Integration {
  /** The policy namespace and `integrations.<id>` in vault.yaml. Never renamed. */
  id: string;
  /** What the person calls it. */
  name: string;
  /** Its card in the integration library, and whether this vault has it. */
  library?: { description: string; added(root: string): boolean };
  /** The origin kind its material carries to agents (lib/provenance.ts). */
  origin?: OriginKind;
  credential: {
    kind: "app-password" | "api-key" | "oauth" | "none";
    /** The vault .env variable an account's key lives under. */
    envKey?(account: string): string;
    /** A sign-in BigBrain keeps: whether this account's still holds tokens. A policy is connected only while it does. */
    signedIn?(root: string, account: string): boolean;
    /** How the person signs in, for kind "oauth". */
    signIn?: BrowserSignIn;
  };
  accounts(root: string): string[];
  /** Changes whenever the account's connection or credential does, so a policy checked against an older one lapses. Never the secret itself. */
  fingerprint(root: string, account: string): string;
  /** What live access lets a caller do, as Settings and integration_capabilities say it. Absent: no live access. */
  live?: { read: string; write: string | null };
  /** Whether the provider lets BigBrain change this account at all (a Gmail app-password connection is read-only). */
  writable?(root: string, account: string): boolean;
  /** The account an opaque `ref` from one of its tools names; throws when it isn't one. */
  refAccount?(ref: string): string;
  tools: IntegrationTool[];
}

const SAFE = Number.MAX_SAFE_INTEGER;
/** `input` as plain JSON Schema: no `$schema`, and none of zod's bounds that say only "a safe integer" or "keys are strings". */
function jsonSchema(input: z.ZodObject): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(input, { io: "input", override: ({ jsonSchema: s }) => {
    if (s.type === "integer" && s.minimum === -SAFE && s.maximum === SAFE) { delete s.minimum; delete s.maximum; }
    if (s.type === "object" && s.propertyNames && JSON.stringify(s.propertyNames) === '{"type":"string"}') delete s.propertyNames;
    if (s.additionalProperties && typeof s.additionalProperties === "object" && !Object.keys(s.additionalProperties).length) s.additionalProperties = true;
  } });
  return schema;
}
/** A tool, its input made strict and its schema derived, so what clients see is what is enforced. */
export function tool<S extends z.ZodRawShape>(t: Omit<IntegrationTool, "input" | "inputSchema" | "run"> & { input: z.ZodObject<S>; run(ctx: ToolContext, args: z.output<z.ZodObject<S>>): Promise<unknown> }): IntegrationTool {
  const input = t.input.strict();
  return { ...t, input, inputSchema: jsonSchema(input), run: t.run as IntegrationTool["run"] };
}

/** Where an account's policy lives. */
export const policyPath = (root: string, name: string, account: string): string =>
  join(root, ".spool", "integration-accounts", name, sha256hex(account) + ".json");

/** Accounts added beside an integration's built-in one, each with the person's label. */
export function extraAccounts(root: string, name: string): { id: string; label: string }[] {
  if (name === "email" || name === "rss") return [];
  try { const v = JSON.parse(readFileSync(join(root, ".spool", "integration-accounts", name, "accounts.json"), "utf8")); return Array.isArray(v) ? v.filter(a => typeof a.id === "string" && /^account-[a-f0-9]{16}$/.test(a.id) && typeof a.label === "string") : []; } catch { return []; }
}

/** The built-in account's key is `base`; an added account's is suffixed with its id. */
export const accountEnvKey = (base: string, builtIn: string, account: string): string =>
  account === builtIn ? base : base + "__" + account.replaceAll("-", "_").toUpperCase();
