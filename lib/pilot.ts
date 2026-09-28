import { readWorkPermissions } from "./workPermissions";
/** Shared Pilot vault tools and speech credentials. Reasoning for voice and text
 * lives in PilotChats; realtime handles transcription and playback only. */
import type { IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newestRun } from "./api";
import { ENGINE_ROOT } from "./engine";
import { readEnvValues, writeEnvValues } from "./envFile";
import { errText } from "./errText";
import { json, readBody, type Ctx, type Route } from "./httpx";
import { landDirective } from "./landItem";
import { handleVaultTool, VAULT_TOOLS, VaultToolError, type VaultToolContext } from "./vaultTools";
import { render } from "./prompts";
import { recentSourcePage } from "./sourceFeed";
import { stagedCount } from "./stage";
import { VoiceError } from "./voice";
import { dueIntakeCount } from "./work";
import { integrationCapabilities, integrationToolCall, INTEGRATION_TOOLS, type IntegrationCallOptions } from "./integrationTools";
import { modelDescriptor } from "./modelRegistry";
import { pilotModels } from "./modelCatalog";
import type { PilotState } from "./pilotTypes";

/** The env var the key lives under — `.env.example` documents it. */
export const PILOT_ENV = "OPENAI_API_KEY";
export const PILOT_ENABLED_ENV = "BIGBRAIN_PILOT_ENABLED";
/** The realtime model. Served only at /v1/realtime; function calling yes. */
export const PILOT_MODEL = modelDescriptor("gpt-realtime-2.1")!.id;
export const PILOT_VOICE = "marin";
/** Input transcription — what the transcript segment's `user:` turns are. */
export const PILOT_TRANSCRIBE = "gpt-live-transcribe";
/** How long a minted client secret is good for. The page mints one per
 * conversation; a long-lived one would be a key by another name. */
export const PILOT_SECRET_TTL_S = 600;
const OPENAI_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

/** A door-level refusal with the status it should answer as. */
export class PilotError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ── the key ──────────────────────────────────────────────────────────────────

/** The key, fresh from `.env` — or undefined when none is set. */
export function pilotKey(root: string): string | undefined {
  const v = readEnvValues(root)[PILOT_ENV]?.trim();
  return v || undefined;
}

export function pilotState(root: string): PilotState {
  const values = readEnvValues(root);
  const configured = !!values[PILOT_ENV]?.trim();
  // Existing installations with a key stay enabled until explicitly switched off.
  const enabled = values[PILOT_ENABLED_ENV] === undefined ? configured : values[PILOT_ENABLED_ENV] === "true";
  const status = !configured ? "unconfigured" : enabled ? "ready" : "disabled";
  return { configured, enabled, status, model: PILOT_MODEL, voice: PILOT_VOICE, permissions: readWorkPermissions(root) };
}

/** Set (or with "" remove) the key. One token, printable ASCII, no
 * whitespace — a pasted key with a stray newline is refused rather than
 * written as a value that will never authenticate. Written through
 * lib/envFile.ts, which shell-quotes it (#550). */
export function setPilotKey(root: string, key: unknown): PilotState {
  if (typeof key !== "string") throw new PilotError("key must be a string");
  const k = key.trim();
  if (k && !/^[\x21-\x7e]{20,}$/.test(k))
    throw new PilotError("that does not look like an OpenAI API key (one token, no spaces)");
  writeEnvValues(root, { [PILOT_ENV]: k });
  return pilotState(root);
}

/** Disable voice without discarding the saved key. */
export function setPilotEnabled(root: string, enabled: unknown): PilotState {
  if (typeof enabled !== "boolean") throw new PilotError("enabled must be a boolean");
  writeEnvValues(root, { [PILOT_ENABLED_ENV]: String(enabled) });
  return pilotState(root);
}

// ── the tools ────────────────────────────────────────────────────────────────

/** A Realtime function tool: the MCP tool's wire fields under OpenAI's names. */
export interface PilotTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The three readers, delegated to lib/vaultTools.ts as they are. */
const READER_TOOLS = ["load_memory", "search_vault", "read_note"] as const;

const vaultDef = (name: string) => {
  const t = VAULT_TOOLS.find((d) => d.name === name);
  if (!t) throw new Error(`lib/vaultTools.ts lost the ${name} tool`);
  return t;
};

const RECENT_MAX = 40;

interface OwnTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (root: string, args: Record<string, unknown>) => unknown | Promise<unknown>;
}

const OWN_TOOLS: OwnTool[] = [
  {
    name: "capabilities",
    description: "Check which live services are connected. Vault search is historical; live integration reads require explicit account access. Native agent sessions own execution.",
    parameters: { type: "object", properties: {} },
    handler: async root => ({ integrations: integrationCapabilities(root, { kind: "pilot" }), calendar: { available: false }, agents: await pilotModels(root), hint: "Pilot reads context and writes private scratch. Delegate execution with launch_agent." }),
  },
  {
    name: "drop",
    description: vaultDef("drop").description,
    parameters: vaultDef("drop").inputSchema,
    handler: (root, args) => handleVaultTool({ root, via: "web", clientName: "pilot", source: "pilot" }, "drop", args),
  },
  {
    name: "recent",
    description:
      "What landed most recently — the home feed, newest first: title, who it came from, when, " +
      "its filing state. source=email selects stored emails. type=source means a record, not a system artifact. " +
      "filing_status is curation only: pending NEVER means unread or unanswered. This is NOT a live inbox. " +
      "Each row's `id` is what `directive.about` names.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer", description: `1-${RECENT_MAX} (default 12)` }, source: { type: "string", description: "Connector, e.g. email, granola, pilot" } },
    },
    handler: (root, args) => {
      const n = Math.min(RECENT_MAX, Math.max(1, Math.trunc(Number(args["limit"])) || 12));
      const page = recentSourcePage(root, 0, n, str(args["source"]).trim().toLowerCase());
      return {
        total: page.total,
        scope: "stored_record",
        live_inbox: false,
        recent: page.recent.map((e) => ({
          path: e.path,
          ...(e.title ? { title: e.title } : {}),
          ...(e.from ? { from: e.from } : {}),
          band: e.band,
          when: isoOf(e.modified),
          ...(e.id ? { id: e.id } : {}),
          ...(e.status ? { filing_status: e.status } : {}),
          ...(e.source ? { source: e.source } : {}),
          ...(e.type ? { type: e.type } : {}),
          ...(e.tags?.length ? { tags: e.tags } : {}),
        })),
      };
    },
  },
  {
    name: "status",
    description:
      "The vault's pulse: arrivals due for filing, staged arrivals a poller found that the " +
      "gardener has not judged yet, and the newest gardener run.",
    parameters: { type: "object", properties: {} },
    handler: (root) => ({
      due: { intake: dueIntakeCount(root), staged: stagedCount(root) },
      last_run: newestRun(root),
    }),
  },
  {
    name: "directive",
    description:
      "File a work order about the record for the gardener to settle: a flag, a correction, " +
      "'skip that sender', 'merge these two'. text = the ask, close to the person's words. " +
      "about = ids of what it concerns (a `recent` row's id), when there are any.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        about: { type: "array", items: { type: "string" } },
      },
      required: ["text"],
    },
    handler: (root, args) => {
      const text = str(args["text"]).trim();
      if (!text) throw new PilotError("missing text");
      const about = Array.isArray(args["about"]) ? args["about"].map(String).filter(Boolean) : [];
      const r = landDirective(
        root,
        { refs: about, guidance: text },
        { from: "pilot", via: "web", from_kind: "agent" },
        { idPrefix: "pilot" }
      );
      return { id: r.id, path: r.path };
    },
  },
];

function isoOf(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return "";
  }
}

/** The table the session is minted with — readers first, in the MCP
 * listing's order, then the pilot's own. */
export function pilotTools(): PilotTool[] {
  return [
    ...READER_TOOLS.map((name) => {
      const t = vaultDef(name);
      return { type: "function" as const, name, description: t.description, parameters: t.inputSchema };
    }),
    ...OWN_TOOLS.map(({ name, description, parameters }) => ({ type: "function" as const, name, description, parameters })),
    ...INTEGRATION_TOOLS.map(({ name, description, inputSchema }) => ({ type: "function" as const, name, description, parameters: inputSchema })),
  ];
}

/** Run one tool call from the page. Refusals (VaultToolError, VoiceError,
 * PilotError) are FOR THE MODEL — the door answers them 400 with the
 * message, and the page hands that back as the call's output so the pilot
 * can say what would work. */
export async function pilotToolCall(root: string, name: unknown, args: unknown, options: IntegrationCallOptions = {}): Promise<unknown> {
  const tool = str(name);
  const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  try {
    if (INTEGRATION_TOOLS.some(t => t.name === tool)) return await integrationToolCall(root, { kind: "pilot" }, tool, a, options);
    if ((READER_TOOLS as readonly string[]).includes(tool)) {
      const ctx: VaultToolContext = { root, via: "web", clientName: "pilot" };
      return await handleVaultTool(ctx, tool, a);
    }
    const own = OWN_TOOLS.find((t) => t.name === tool);
    if (!own) throw new PilotError(`no such tool: ${tool || "(none)"}`);
    return await own.handler(root, a);
  } catch (error) {
    if (error instanceof PilotError) throw error;
    if (error instanceof VaultToolError || error instanceof VoiceError) throw new PilotError(error.message);
    throw error;
  }
}

// ── the session ──────────────────────────────────────────────────────────────

/** The day as the person's clock reads it — the prompt's "today". */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function pilotInstructions(now = new Date()): string {
  const template = readFileSync(join(ENGINE_ROOT, "prompts", "pilot.md"), "utf8");
  return render(template, { today: localDay(now) });
}

/** The realtime session, as the client secret bakes it. Turn detection is
 * OFF: push-to-talk commits the buffer on key-up and asks for the response
 * itself, and the mic track stays muted between presses so an idle open
 * panel costs nothing (web/ui/src/lib/pilot.svelte.ts). */
export function pilotSession(now = new Date(), _root?: string): Record<string, unknown> {
  return {
    type: "realtime",
    model: PILOT_MODEL,
    instructions: pilotInstructions(now),
    tools: [],
    tool_choice: "none",
    audio: {
      input: {
        transcription: { model: PILOT_TRANSCRIBE },
        turn_detection: null,
        noise_reduction: { type: "near_field" },
      },
      output: { voice: PILOT_VOICE },
    },
    output_modalities: ["audio"],
  };
}

export interface PilotSecret {
  /** The ephemeral key (`ek_…`) the page authenticates its WebRTC offer with. */
  value: string;
  /** Unix seconds. */
  expires_at: number;
  model: string;
}

export type MintResult = { ok: true; secret: PilotSecret } | { ok: false; status: number; error: string };

/** Mint one client secret at OpenAI with the session baked in. The real
 * key goes out in this request and nowhere else. OpenAI's refusal of the
 * key answers 401 so settings can say "the key was refused"; any other
 * upstream failure is a 502 with OpenAI's own words. */
export async function mintPilotSecret(
  root: string,
  opts: { fetch?: typeof fetch; now?: Date } = {}
): Promise<MintResult> {
  const key = pilotKey(root);
  if (!key) return { ok: false, status: 409, error: "no OpenAI key — add one in settings › vault › pilot" };
  if (!pilotState(root).enabled) return { ok: false, status: 409, error: "pilot is off — enable it in settings › vault › pilot" };
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(OPENAI_SECRETS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: PILOT_SECRET_TTL_S },
        session: pilotSession(opts.now, root),
      }),
    });
  } catch (error) {
    return { ok: false, status: 502, error: `could not reach OpenAI: ${errText(error)}` };
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: unknown } };
      if (typeof j.error?.message === "string") detail = j.error.message;
    } catch {
      /* not JSON — the slice stands */
    }
    const refused = res.status === 401 || res.status === 403;
    return {
      ok: false,
      status: refused ? 401 : 502,
      error: refused ? "OpenAI key rejected" : `OpenAI ${res.status}: ${detail}`,
    };
  }
  let j: { value?: unknown; expires_at?: unknown };
  try {
    j = JSON.parse(text) as typeof j;
  } catch {
    return { ok: false, status: 502, error: "OpenAI answered with something other than JSON" };
  }
  if (typeof j.value !== "string" || !j.value)
    return { ok: false, status: 502, error: "OpenAI answered without a client secret" };
  return {
    ok: true,
    secret: { value: j.value, expires_at: typeof j.expires_at === "number" ? j.expires_at : 0, model: PILOT_MODEL },
  };
}

// ── the routes ───────────────────────────────────────────────────────────────

/** Small JSON bodies only — a key, a tool call's arguments. */
const BODY_CAP = 256 * 1024;

export async function bodyJson<T>(req: IncomingMessage): Promise<T> {
  const text = await readBody(req, BODY_CAP);
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PilotError("body is not JSON");
  }
}

/** Run an async handler and answer its refusals: PilotError as its status,
 * anything else as a 500 with the message — never an unhandled rejection
 * out of a route. */
export function answer(ctx: Ctx, work: () => Promise<void>): void {
  work().catch((error: unknown) => {
    if (error instanceof PilotError) return json(ctx.res, error.status, { error: error.message });
    if (error instanceof Error && /too large/.test(error.message)) return json(ctx.res, 413, { error: error.message });
    json(ctx.res, 500, { error: errText(error) });
  });
}

/**
 *   GET  /api/pilot          {configured, enabled, model, voice} — voice availability
 *   POST /api/pilot/enabled  {enabled} → toggle voice, retaining the key
 *   POST /api/pilot/key      {key} → the same state; "" removes the key
 *   POST /api/pilot/secret   → {value, expires_at, model} — one per conversation
 *
 * Not desktop-gated:
 * a plain browser at the viewer's loopback origin is the dev loop and the
 * fallback while the app's microphone permission lags a release.
 */
export function pilotRoutes(root: string, deps: { fetch?: typeof fetch; now?: () => Date; setPermissions: (value: unknown) => Promise<void> }): Route[] {
  return [
    { method: "POST", path: "/api/pilot/permissions", handler: ctx => answer(ctx, async () => {
      try { await deps.setPermissions(await bodyJson<unknown>(ctx.req)); } catch (error) { throw new PilotError(errText(error), 400); }
      json(ctx.res, 200, pilotState(root));
    }) },
    { method: "GET", path: "/api/pilot", handler: ({ res }) => json(res, 200, pilotState(root)) },
    { method: "POST", path: "/api/pilot/key", handler: ctx => answer(ctx, async () => {
      const { key } = await bodyJson<{ key?: unknown }>(ctx.req); json(ctx.res, 200, setPilotKey(root, key ?? ""));
    }) },
    { method: "POST", path: "/api/pilot/enabled", handler: ctx => answer(ctx, async () => {
      const { enabled } = await bodyJson<{ enabled?: unknown }>(ctx.req); json(ctx.res, 200, setPilotEnabled(root, enabled));
    }) },
    { method: "POST", path: "/api/pilot/secret", handler: ctx => answer(ctx, async () => {
      const r = await mintPilotSecret(root, { ...(deps.fetch ? { fetch: deps.fetch } : {}), now: deps.now?.() ?? new Date() });
      if (r.ok) json(ctx.res, 200, r.secret); else json(ctx.res, r.status, { error: r.error });
    }) },
  ];
}
