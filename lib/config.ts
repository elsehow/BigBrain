import { RETIRED_INTEGRATIONS } from "./personas";
/**
 * config.ts — apply edits to the vault's human-edited configuration surface:
 * the integrations map and the two pass models in vault.yaml.
 *
 * This is the one sanctioned write path outside the gardener, because this
 * surface is human-edited by contract and the viewer is just the human's
 * pen. Every apply validates first, writes atomically, and commits as author
 * `config`, so `git log --author=config` is the audit trail of every setting
 * change.
 *
 * Nothing re-reads config ahead of time anywhere in the system — each run
 * loads vault.yaml fresh — so an applied change takes effect on the next run.
 */

import { loadManifest, parseCuration, type CurationConfig, type AgentId } from "./manifest";
import { modelPreference, type ModelPreference, MODEL_ID, readModelChoice, validateModelChoice, type ModelChoice } from "./modelChoice";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseDocument, Scalar, YAMLMap } from "yaml";
import { writeAtomic } from "./fsx";
import { ENGINE_ROOT } from "./engine";
import { commitAs, pokePublish } from "./git";
import { readEnvValues, writeEnvValues } from "./envFile";
import { applyInboxAdd, applyInboxRemove, parseInboxAdd, passwordEnvKey } from "./emailConfig";

/** One edit to an integration's vault.yaml entry. Toggling never removes the
 *  entry — `enabled: false` is set (or cleared), so its config keys survive a
 *  round trip off and back on. Runners check the flag at startup, so a toggle
 *  takes effect on the integration's next poll. */
export interface IntegrationOp {
  name: string;
  enabled?: boolean;
  remember?: string;
  activate?: boolean;
  checkAccess?: boolean;
  readers?: import("./integrationAccess").IntegrationGrant[];
  /** YAML map replacing the entry's opaque config keys wholesale. `enabled`
   *  is the framework's key and may not appear inside it. */
  configYaml?: string;
  /** Credential writes: env var → new value, validated against
   *  INTEGRATION_ENV for this integration. Written to the vault's .env
   *  (gitignored — a credential never enters the history), never to
   *  vault.yaml, and never committed. Secret values are WRITE-ONLY: the
   *  API reports set-ness, never the value. */
  env?: Record<string, string>;
  /** A new source for an integration that has them — email's inboxes
   *  (lib/emailConfig.ts): the add form's fields, secret included. The
   *  secret goes to .env like `env`; the rest to vault.yaml. */
  add?: Record<string, string>;
  /** A source to drop, by id (an inbox's address). Its secret is cleared. */
  remove?: string;
}

// ── integration credentials: env-backed, write-only for secrets ──────────────

export interface EnvField {
  env: string;
  label: string;
  /** Secret fields report set-ness only — the value never leaves the host. */
  secret: boolean;
}

/** The env vars each integration's runner reads. vault.yaml stays free of
 * credentials by construction; this map is what makes the config UI able to
 * SET them without ever being able to read them back. */
export const INTEGRATION_ENV: Record<string, EnvField[]> = {
  granola: [], // Browser OAuth is managed per account.
  "that-tracks": [{ env: "THAT_TRACKS_API_KEY", label: "api key", secret: true }],
};

/** The config UI's view of one integration's credentials: set-ness for
 * every field, the value only for non-secret ones. */
export function envFieldStates(
  root: string,
  name: string
): { env: string; label: string; secret: boolean; set: boolean; value?: string }[] {
  const fields = INTEGRATION_ENV[name] ?? [];
  if (!fields.length) return [];
  const values = readEnvValues(root);
  return fields.map((f) => {
    const v = values[f.env];
    return { ...f, set: Boolean(v), ...(f.secret || !v ? {} : { value: v }) };
  });
}


export type ModelChoicePatch = Omit<ModelChoice, "adapter" | "reasoning"> & { adapter?: string; agent?: AgentId; reasoning?: string | null; preference?: ModelPreference };

export interface ConfigPatch {
  curation?: CurationConfig;
  /** The two passes, spelled as vault.yaml spells them, so the wire, the
   * file and the screen all say one name each (#643). The gardener runs
   * every intake round; the memory pass's model falls back to the
   * gardener's when empty. */
  gardener?: ModelChoicePatch;
  memory?: ModelChoicePatch;
  quick?: ModelChoicePatch;
  integrations?: IntegrationOp[];
}

/** ConfigPatch's own field list, for the unknown-key refusal above. */
const PATCH_KEYS = new Set(["curation", "gardener", "memory", "quick", "integrations"]);

export interface ConfigResult {
  changed: string[]; // vault-relative paths actually modified (empty = no-op)
  committed: boolean;
}

// Integration names are directory names and vault.yaml keys: kebab-case, no
// path tricks.
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// ── integration ops ───────────────────────────────────────────────────────────

function integrationsYamlMap(doc: ReturnType<typeof parseDocument>): YAMLMap {
  const map = doc.getIn(["integrations"], true);
  if (!(map instanceof YAMLMap)) throw new Error("vault.yaml has no integrations map");
  return map;
}

/** Parse an op's configYaml into the plain map of opaque keys, or throw. */
function parseIntegrationConfig(name: string, configYaml: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parse(configYaml) ?? {};
  } catch (e) {
    throw new Error(
      `integration ${name}: config is not valid YAML — ${e instanceof Error ? e.message : e}`
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`integration ${name}: config must be a YAML map of keys (or empty)`);
  const cfg = parsed as Record<string, unknown>;
  if ("enabled" in cfg)
    throw new Error(`integration ${name}: \`enabled\` is the on/off toggle, not a config key`);
  return cfg;
}

/** The whole batch is checked before a single byte is written, so a bad op
 * is a clean no-op. An op may target anything already listed in vault.yaml
 * OR present as integrations/<name>/ code — never an arbitrary new key. */
function validateIntegrationOps(ops: IntegrationOp[], doc: ReturnType<typeof parseDocument>): void {
  if (!doc.has('integrations') && ops.every(o=>o.name==='email'&&o.add))doc.set('integrations',doc.createNode({}));
  const listed = integrationsYamlMap(doc).items.map((p) => String((p.key as Scalar).value));
  for (const o of ops) {
    if (RETIRED_INTEGRATIONS.has(o.name)) throw new Error(`integration ${o.name} has been retired`);
    if (!NAME_RE.test(o.name))
      throw new Error(
        `integration name ${JSON.stringify(o.name)} must be kebab-case (a-z, 0-9, dashes)`
      );
    if (!listed.includes(o.name) && !existsSync(join(ENGINE_ROOT, "integrations", o.name)))
      throw new Error(
        `no such integration ${JSON.stringify(o.name)} — not in vault.yaml and no integrations/${o.name}/`
      );
    if (
      o.enabled === undefined && o.configYaml === undefined && o.env === undefined &&
      o.add === undefined && o.remove === undefined && o.remember === undefined
    )
      throw new Error(`integration ${o.name}: nothing to change`);
    if (o.add !== undefined || o.remove !== undefined) {
      if (o.name !== "email")
        throw new Error(`integration ${o.name} has no sources to add or remove`);
      if (o.add !== undefined) {
        if (typeof o.add !== "object" || o.add === null || Array.isArray(o.add))
          throw new Error("integration email: add must be the form's fields");
        parseInboxAdd(o.add); // throws in the form's own words
      }
      if (o.remove !== undefined && (typeof o.remove !== "string" || !o.remove.trim()))
        throw new Error("integration email: remove names an inbox by address");
    }
    if (o.remember !== undefined && (typeof o.remember !== "string" || !o.remember.trim() || o.remember.length > 8000)) throw new Error("Enter a remembering rule under 8,000 characters.");
    if (o.enabled !== undefined && typeof o.enabled !== "boolean")
      throw new Error(`integration ${o.name}: enabled must be true or false`);
    if (o.configYaml !== undefined) parseIntegrationConfig(o.name, o.configYaml);
    if (o.env !== undefined) {
      const known = new Set((INTEGRATION_ENV[o.name] ?? []).map((f) => f.env));
      for (const [k, v] of Object.entries(o.env)) {
        if (!known.has(k))
          throw new Error(
            `integration ${o.name}: ${JSON.stringify(k)} is not one of its credential fields`
          );
        if (typeof v !== "string" || !v.trim())
          throw new Error(`integration ${o.name}: ${k} needs a non-empty value`);
        if ([...v].some((c) => { const n = c.codePointAt(0) ?? 0; return n < 0x20 || n === 0x7f; }))
          throw new Error(
            `integration ${o.name}: ${k} must not contain control characters or newlines`
          );
      }
    }
  }
}

/** Execute pre-validated integration ops. A pure toggle edits only the
 * `enabled` key, so the entry's other keys and comments stay put; a config
 * save replaces the opaque keys wholesale. Unchanged ops are no-ops. */
function applyIntegrationOps(
  doc: ReturnType<typeof parseDocument>,
  ops: IntegrationOp[]
): { dirty: boolean; summary: string[] } {
  const map = integrationsYamlMap(doc);
  const out = { dirty: false, summary: [] as string[] };
  for (const o of ops) {
    // sources first: an add on an unlisted integration creates its entry,
    // which the toggle logic below then reads as listed
    if (o.add !== undefined) {
      const r = applyInboxAdd(doc, parseInboxAdd(o.add));
      if (r.changed) out.dirty = true;
      out.summary.push(r.summary);
    }
    if (o.remove !== undefined) {
      const r = applyInboxRemove(doc, o.remove);
      if (r.changed) out.dirty = true;
      out.summary.push(r.summary);
    }
    if (o.remember !== undefined) {
      if (!(map.get(o.name, true) instanceof YAMLMap)) map.set(o.name, doc.createNode({ enabled: false }));
      doc.setIn(["integrations", o.name, "remember"], o.remember.trim());
      out.dirty = true; out.summary.push(`integration ${o.name} remembering rule updated`);
    }
    if (o.enabled === undefined && o.configYaml === undefined) continue;
    const entry = map.get(o.name, true);
    const wasListed = map.has(o.name);
    const current = (entry instanceof YAMLMap ? entry.toJSON() : {}) as Record<string, unknown>;
    const wasEnabled = wasListed && current["enabled"] !== false;
    const enabled = o.enabled ?? wasEnabled;

    if (o.configYaml !== undefined) {
      const cfg = parseIntegrationConfig(o.name, o.configYaml);
      const { enabled: _e, ...opaque } = current;
      const cfgChanged = JSON.stringify(cfg) !== JSON.stringify(opaque);
      if (!cfgChanged && enabled === wasEnabled && wasListed) continue;
      const node = doc.createNode(enabled ? cfg : { ...cfg, enabled: false }) as YAMLMap;
      if (!node.items.length) node.flow = true; // an empty entry reads best as `name: {}`
      map.set(o.name, node);
      out.dirty = true;
      if (cfgChanged) out.summary.push(`integration ${o.name} configured`);
      if (enabled !== wasEnabled || !wasListed)
        out.summary.push(`integration ${o.name} ${enabled ? "on" : "off"}`);
    } else {
      if (enabled === wasEnabled && wasListed) continue;
      if (!(entry instanceof YAMLMap)) {
        // unlisted, or a bare `name:` entry — write the smallest honest map
        const node = doc.createNode(enabled ? {} : { enabled: false }) as YAMLMap;
        if (!node.items.length) node.flow = true;
        map.set(o.name, node);
      } else if (enabled) entry.delete("enabled");
      else doc.setIn(["integrations", o.name, "enabled"], false);
      out.dirty = true;
      out.summary.push(`integration ${o.name} ${enabled ? "on" : "off"}`);
    }
  }
  return out;
}

// ── the apply ────────────────────────────────────────────────────────────────

/** Set a pass's `model`, preferring the block the vault already uses. The
 * gardener's block is `gardener:` since #524, but a vault written before
 * that names it `queue:` and loadManifest still reads it — so an edit lands
 * where the value already lives rather than growing a second block the
 * reader would have to prefer between. */
function setPassModel(
  doc: ReturnType<typeof parseDocument>,
  blocks: readonly string[],
  model: string
): boolean {
  const where = blocks.find((b) => doc.hasIn([b, "model"])) ?? blocks[0]!;
  const node = doc.getIn([where, "model"], true) as Scalar | undefined;
  if (node && String(node.value) === model) return false;
  if (node) node.value = model; // in place: the key keeps its comment
  else doc.setIn([where, "model"], model);
  return true;
}

function setRole(doc: ReturnType<typeof parseDocument>, blocks: readonly string[], choice: ModelChoice): boolean {
  const where = blocks.find(b => doc.hasIn([b])) ?? blocks[0]!;
  let changed = setPassModel(doc, [where], choice.model);
  // A user edit writes the canonical choice, retaining unrelated keys/comments.
  for (const key of ["adapter", "provider", "reasoning"] as const) {
    const value = choice[key];
    if (value === undefined) {
      if (doc.hasIn([where, key])) { doc.deleteIn([where, key]); changed = true; }
    } else if (doc.getIn([where, key]) !== value) { doc.setIn([where, key], value); changed = true; }
  }
  if (doc.hasIn([where, "agent"])) { doc.deleteIn([where, "agent"]); changed = true; }
  return changed;
}

/** Validate and apply a patch, committing whatever actually changed.
 * Unchanged values are no-ops, so callers may send the full form.
 * Everything is validated before anything is written: a rejected patch
 * leaves the vault untouched. */
export function applyConfig(patch: ConfigPatch, root: string): ConfigResult {
  const changed: string[] = [];
  const summary: string[] = [];

  // A key this engine does not know is an ERROR, not something to ignore.
  // Silently dropping it means a save that reports success and changes
  // nothing — which is exactly what a browser tab still holding the
  // pre-#643 bundle would do against this engine, sending the old `model`
  // and `memoryModel` spellings. Better a visible refusal and a reload.
  const unknown = Object.keys(patch).filter((k) => !PATCH_KEYS.has(k));
  if (unknown.length)
    throw new Error(
      `this engine has no setting called ${unknown.map((k) => JSON.stringify(k)).join(", ")} — reload the page and try again`
    );

  const curation = parseCuration(patch.curation);
  // validate the pure parts first — no partial writes on a bad patch
  const models: [string, string | undefined, string[]][] = [
    ["gardener", patch.gardener?.model, ["gardener", "queue"]],
    ["memory", patch.memory?.model, ["memory"]],
    ["quick", patch.quick?.model, ["quick"]],
  ];
  for (const [label, raw] of models) {
    if (raw === undefined || !raw.trim()) continue;
    if (!MODEL_ID.test(raw.trim()))
      throw new Error(`${label} model ${JSON.stringify(raw.trim())} is not a plausible model id`);
  }
  const roles = ["gardener", "memory", "quick"] as const;
  const normalized: Partial<Record<typeof roles[number], ModelChoice>> = {};
  const manifest = roles.some(role => patch[role]?.model.trim()) ? loadManifest(root) : undefined;
  for (const name of roles) {
    const role = patch[name];
    if (!role?.model.trim()) continue;
    modelPreference(role.preference, "pinned");
    const previous = manifest![name];
    const identity = role.adapter !== undefined || role.agent !== undefined ? role : { ...previous, ...role };
    const decode = role.adapter === undefined ? readModelChoice : validateModelChoice;
    const choice = decode({ ...identity, model: role.model.trim(), reasoning: role.reasoning ?? undefined });
    if (role.reasoning === undefined && choice.adapter === previous.adapter && choice.provider === previous.provider && previous.reasoning)
      choice.reasoning = previous.reasoning;
    normalized[name] = choice;
  }

  const integrationOps = patch.integrations ?? [];
  const touchesYaml =
    !!curation || models.some(([, raw]) => raw !== undefined && raw.trim()) || integrationOps.length > 0;
  const yamlPath = join(root, "vault.yaml");
  const doc = touchesYaml ? parseDocument(readFileSync(yamlPath, "utf8")) : null;
  if (integrationOps.length) validateIntegrationOps(integrationOps, doc!);

  // Surgical edits via the yaml document API: mutating nodes in place keeps
  // every comment in the file — vault.yaml is prose as much as data.
  let yamlDirty = false;
  if (curation && JSON.stringify(doc!.toJS().curation) !== JSON.stringify(curation)) {
    doc!.set("curation", curation);
    yamlDirty = true;
    summary.push(`curation → ${curation.agent}/${curation.model}`);
  }
  for (const [label, role, blocks] of [["gardener", patch.gardener, ["gardener", "queue"]], ["memory", patch.memory, ["memory"]], ["quick", patch.quick, ["quick"]]] as const) {
    if (!role?.model.trim()) continue;
    const where = blocks.find(b => doc!.hasIn([b])) ?? blocks[0]!;
    const preference = modelPreference(role.preference, "pinned");
    const preferenceChanged = doc!.getIn([where, "preference"]) !== preference;
    if (preferenceChanged) doc!.setIn([where, "preference"], preference);
    if (setRole(doc!, blocks, normalized[label]!) || preferenceChanged) {
      yamlDirty = true;
      const choice = normalized[label]!;
      summary.push(`${label} → ${[choice.adapter, choice.provider, choice.model].filter(Boolean).join("/")}`);
    }
  }

  if (integrationOps.length) {
    const r = applyIntegrationOps(doc!, integrationOps);
    yamlDirty = yamlDirty || r.dirty;
    summary.push(...r.summary);
    // credential writes land in .env — never in vault.yaml, never in a commit
    const envUpdates: Record<string, string> = {};
    for (const o of integrationOps) {
      for (const [k, v] of Object.entries(o.env ?? {})) {
        envUpdates[k] = v.trim();
        summary.push(`integration ${o.name}: ${k} set`);
      }
      // an inbox's app password rides with its add; a removed inbox's is
      // cleared. Neither value ever reaches the summary (it is the commit
      // message) — only the address does.
      if (o.add !== undefined) {
        const a = parseInboxAdd(o.add);
        envUpdates[passwordEnvKey(a.address)] = a.password;
        summary.push(`integration email: password for ${a.address} set`);
      }
      if (o.remove !== undefined) envUpdates[passwordEnvKey(o.remove)] = "";
    }
    if (Object.keys(envUpdates).length) {
      writeEnvValues(root, envUpdates);
      changed.push(".env");
    }
  }

  if (yamlDirty) {
    writeAtomic(yamlPath, doc!.toString());
    changed.push("vault.yaml");
  }

  if (!changed.length) return { changed, committed: false };
  // .env is gitignored by design — report it as changed, commit everything else
  const commitPaths = changed.filter((p) => p !== ".env");
  const committed = commitPaths.length
    ? commitAs(root, "config", `config: ${summary.join("; ")}`, commitPaths)
    : false;
  if (committed) pokePublish(root);
  return { changed, committed };
}
