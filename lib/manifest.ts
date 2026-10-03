import { MODEL_DEFAULTS } from "./modelDefaults";
/**
 * manifest.ts — load vault.yaml, the one file a person edits. THE config
 * reader: nothing else in the engine parses vault.yaml.
 *
 * Side-effect-free at import and explicit about its root, so any module can
 * import it — including the ones that must work with no vault around
 * (lib/api.ts and the first-run door). The vault-resolving constant lives in
 * ./vaultRoot; a `lib/` module should take `root` as an argument rather than
 * reach for it.
 *
 * What a vault configures is now small: where things come from
 * (`integrations`), which credential the headless runner uses (`auth`), and
 * which model each of the two passes runs. Everything else the file used to
 * carry — the retired editor's `triage:`/`deep:` passes, per-pass auth
 * overrides, the worker debounce nothing read — went with #524.
 *
 * Old keys are IGNORED, never fatal (design-principles §5): a vault.yaml
 * written for an older engine keeps loading, and a `queue:` block still
 * names the gardener's model — that was its only surviving key.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { RETIRED_INTEGRATIONS } from "./personas";
import { modelPreference, readModelChoice, type ModelPreference, type ModelChoice } from "./modelChoice";

/** How headless `claude -p` authenticates: `max` strips ANTHROPIC_API_KEY so
 * claude uses the logged-in subscription; `api` requires the key in .env.
 * ONE credential for the whole vault — the per-pass overrides went with the
 * passes (#524). */
export type AgentId = "claude" | "codex" | "pi";
export interface CurationConfig { agent: AgentId; model: string }
/** A named job's provider and model.  Old vaults can omit `agent`; then the
 * old shared `curation` choice remains its provider. */
export type RoleConfig = ModelChoice;
export function parseCuration(raw: unknown): CurationConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("curation must be a mapping");
  const c = raw as Record<string, unknown>;
  if (Object.keys(c).some(k => k !== "agent" && k !== "model")) throw new Error("curation accepts agent and model only");
  if (c.agent !== "claude" && c.agent !== "codex" && c.agent !== "pi") throw new Error("curation agent must be claude, pi, or legacy codex");
  if (typeof c.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(c.model.trim())) throw new Error("curation needs a plausible model id");
  return { agent: c.agent, model: c.model.trim() };
}
export const curationAgent = (manifest: Manifest): AgentId => manifest.curation?.agent ?? "claude";

/** The intake firewall (lib/firewall.ts): a Jev/SystemOne `/v1/systemone`
 * endpoint that every arrival is screened against. Absent means off — an
 * older vault keeps landing exactly as it did (design-principles §5). */
export interface FirewallConfig { url: string; model: string; thresholds: { credential: number } }
/** Tuned on deploy/firewall/eval with local Clef-flash: every credential
 * mail scores ≥ 0.22, every ordinary one ≤ 0.06, and a missed reset link is
 * the costly error — so the threshold sits low in that gap. */
export const FIREWALL_THRESHOLDS = { credential: 0.15 };
export function parseFirewall(raw: unknown): FirewallConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("firewall must be a mapping");
  const f = raw as Record<string, unknown>;
  if (typeof f.url !== "string" || !/^https?:\/\/\S+$/.test(f.url.trim())) throw new Error("firewall needs a url (http:// or https://)");
  const t = f.thresholds ?? {};
  if (typeof t !== "object" || Array.isArray(t)) throw new Error("firewall thresholds must be a mapping");
  const thresholds = { ...FIREWALL_THRESHOLDS };
  for (const [k, v] of Object.entries(t)) {
    // `malicious` was a second question, removed; a vault that set it keeps
    // loading (design-principles §5) — a config error would stop intake.
    if (k === "malicious") continue;
    if (k !== "credential") throw new Error("firewall thresholds accepts credential only");
    if (!(Number(v) > 0 && Number(v) < 1)) throw new Error(`firewall ${k} threshold must be between 0 and 1`);
    thresholds[k] = Number(v);
  }
  const model = f.model === undefined ? "clef-flash" : String(f.model).trim();
  if (!model) throw new Error("firewall model must not be empty");
  return { url: f.url.trim(), model, thresholds };
}

export type Auth = "max" | "api";

/** The model a vault gets when its vault.yaml names none anywhere. Reached
 * only by a hand-written file: `bigbrain init` always writes one. The most
 * capable default, never the cheapest — economizing the one pass was the
 * discredited move. Deliberately not the gardener recommendation: memory falls
 * back to this too, and an existing file must keep resolving as it always has. */
const DEFAULT_MODEL = "opus";

export interface Manifest {
  /** Absolute path of the vault root (the directory holding vault.yaml). */
  root: string;
  /** The credential both passes run on. */
  auth: Auth;
  curation?: CurationConfig;
  firewall?: FirewallConfig;
  integrations: Record<string, Record<string, unknown>>;
  /** The gardener — the one runner (`bigbrain tend`), draining due intake. */
  gardener: PassConfig;
  /** The memory pass — the second writer, disjoint tree (memory/ only). */
  memory: MemoryConfig;
  /** A disposable, read-only orientation sentence for an entity node. */
  quick: RoleConfig;
  modelPreferences: Record<"gardener" | "memory" | "quick", ModelPreference>;
}

export interface PassConfig extends RoleConfig {
  /** The model this pass runs. */
  model: string;
}

export interface MemoryConfig extends PassConfig {
  /** The scheduled sweep — how often waiting work gets folded in. Never a
   * run on its own: the gate still needs voice or record changes. The ONLY
   * clock the pass has since 2026-09-02; `debounce` (the voice-settle
   * early trigger) is a key the engine no longer reads. */
  interval: string;
  intervalMs: number;
}

/** "5m" | "90s" | "1h" | "7d" → milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(String(s).trim());
  if (!m) throw new Error(`unparseable duration: ${JSON.stringify(s)}`);
  return (
    Number(m[1]) *
    { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"]!
  );
}

function parseAuth(v: unknown, fallback: Auth): Auth {
  if (v === undefined || v === null) return fallback;
  if (v === "max" || v === "api") return v;
  throw new Error(`vault.yaml: auth must be "max" or "api", got ${JSON.stringify(v)}`);
}

/** An integration is enabled when vault.yaml lists it without `enabled: false`.
 * `enabled` is the ONE framework-level key in an otherwise opaque config map —
 * toggling an integration off keeps its configuration in place. Runners call
 * integrationEnabled() at startup and exit quietly when off, so a toggle takes
 * effect on the integration's next poll, with nothing to reload. */
export function integrationEnabledIn(
  integrations: Manifest["integrations"],
  name: string
): boolean {
  if (RETIRED_INTEGRATIONS.has(name) || !(name in integrations)) return false;
  return (integrations[name] ?? {})["enabled"] !== false;
}

/** Convenience form that reads vault.yaml — for runners' startup guard. */
export function integrationEnabled(name: string, root: string): boolean {
  return integrationEnabledIn(loadManifest(root).integrations, name);
}

/** A block that may name a `model`, or nothing at all. */
function blockModel(raw: unknown): string | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const m = (raw as { model?: unknown }).model;
  return m == null ? undefined : String(m);
}

/** The gardener's model. `gardener:` is the block's name since #524; a
 * `queue:` block (its name while the typed work queue existed) and the
 * retired editor's `deep:`/`triage:` blocks are read for their model in that
 * order, so no vault loses the model it configured. */
function blockAgent(raw: unknown): AgentId | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const agent = (raw as { adapter?: unknown; agent?: unknown }).adapter ?? (raw as { agent?: unknown }).agent;
  if (agent === undefined) return undefined;
  if (agent !== "claude" && agent !== "codex" && agent !== "pi") throw new Error("vault.yaml: agent must be claude, pi, or legacy codex");
  return agent;
}

function parseGardener(raw: Record<string, unknown>, fallbackAgent: AgentId): PassConfig {
  const block = raw["gardener"] ?? raw["queue"] ?? raw["deep"] ?? raw["triage"];
  return readRole(block, fallbackAgent,
    blockModel(raw["gardener"]) ?? blockModel(raw["queue"]) ?? blockModel(raw["deep"]) ?? blockModel(raw["triage"]) ?? DEFAULT_MODEL);
}

function readRole(raw: unknown, fallbackAgent: AgentId, model: string): ModelChoice {
  const block = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return readModelChoice({ ...block, agent: blockAgent(raw) ?? fallbackAgent, model } as Parameters<typeof readModelChoice>[0]);
}

/** Parse vault.yaml's `memory:` block. Model falls back to the gardener's;
 * cadence defaults are production-lean — debounce 30m, interval 1d — and a
 * test vault tightens them in vault.yaml. */
function parseMemoryConfig(raw: unknown, gardener: PassConfig, fallbackAgent: AgentId): MemoryConfig {
  const block =
    raw != null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as { model?: unknown; interval?: unknown })
      : {};
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw)))
    throw new Error("vault.yaml: memory must be a mapping");
  // `debounce` may still sit in the block (a vault.yaml is a file a person
  // keeps); it is ignored, never parsed — design-principles §5.
  const interval = String(block.interval ?? "1d");
  return {
    ...readRole(raw, fallbackAgent, block.model != null ? String(block.model) : gardener.model),
    interval,
    intervalMs: parseDuration(interval),
  };
}

export function loadManifest(root: string): Manifest {
  const raw = (parse(readFileSync(resolve(root, "vault.yaml"), "utf8")) ?? {}) as Record<
    string,
    unknown
  >;

  const curation = parseCuration(raw["curation"]);
  const firewall = parseFirewall(raw["firewall"]);
  const fallbackAgent = curation?.agent ?? "claude";
  const gardener = parseGardener(raw, fallbackAgent);
  const memory = parseMemoryConfig(raw["memory"], gardener, fallbackAgent);
  // A shared curation block remains a legacy fallback only. A role that has
  // its own model is intentionally allowed to differ from it.
  if (curation && blockAgent(raw["gardener"] ?? raw["queue"] ?? raw["deep"] ?? raw["triage"]) === undefined) gardener.model = readModelChoice({ agent: fallbackAgent, model: curation.model }).model;
  if (curation && blockAgent(raw["memory"]) === undefined) memory.model = readModelChoice({ agent: fallbackAgent, model: curation.model }).model;
  const quickRaw = raw["quick"];
  const quick = readRole(quickRaw, fallbackAgent,
    blockModel(quickRaw) ?? (fallbackAgent === "claude" ? MODEL_DEFAULTS.anthropic.quick.model : curation?.model ?? DEFAULT_MODEL));
  if (curation?.agent === "codex") curation.agent = "pi";
  return {
    root,
    auth: parseAuth(raw["auth"], "max"),
    integrations: (raw["integrations"] ?? {}) as Manifest["integrations"],
    gardener,
    memory,
    quick,
    modelPreferences: Object.fromEntries((["gardener", "memory", "quick"] as const).map(role => {
      const block = (role === "gardener" ? raw.gardener ?? raw.queue ?? raw.deep ?? raw.triage : raw[role]) as Record<string, unknown> | undefined;
      const explicit = !!curation || !!block && ["adapter", "agent", "model"].some(key => block[key] !== undefined);
      return [role, modelPreference(block?.preference, explicit ? "pinned" : "recommended")];
    })) as Manifest["modelPreferences"],
    ...(curation ? { curation } : {}),
    ...(firewall ? { firewall } : {}),
  };
}

// RETIRED_INTEGRATIONS / INTERNAL_PERSONAS (#265 addendum) live in
// ./personas and are re-exported here as their one DISCOVERABLE home (bin/
// and web/ already import this file for everything else). They stayed in a
// separate module because this file used to resolve the vault at import
// time, so importing it for a constant cost you a vault; that moved to
// ./vaultRoot and the split is now only about keeping personas.ts free of
// imports. Either home would work.
export { RETIRED_INTEGRATIONS, INTERNAL_PERSONAS } from "./personas";
