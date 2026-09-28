import { activationRecord, integrationConnected, integrationActive, integrationAccounts, rememberingRule, integrationFingerprint, integrationCallerChoices, validateIntegrationGrants, saveIntegrationActivation, deactivateIntegration, MANAGED_INTEGRATIONS } from "./integrationAccess";
import { checkIntegrationConnection } from "./integrationProbe";
/**
 * configWrite.ts — the viewer's one write surface, extracted from
 * web/server.ts (#291, the config half of #260's seam list): POST
 * /api/config edits the human-edited configuration surface — the
 * integrations map and the two pass models in vault.yaml — via
 * lib/config.ts, applied and committed (author `config`).
 *
 * configSave answers a plain {status, body}; the server's route stays the
 * HTTP plumbing, and tests drive the whole request → config-file mapping.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { extraAccounts,integrationAccountKey } from "./integrationAccess";
import { RETIRED_INTEGRATIONS } from "./personas";
import { applyConfig, type ConfigPatch, envFieldStates } from "./config";
import { emailConfig, INBOX_ADD, parseInboxAdd } from "./emailConfig";
import { emailSources } from "./emailState";
import { probeInbox, type InboxProbe } from "./imapProbe";
import { CADENCE } from "./desktopSchedule";
import { ENGINE_ROOT } from "./engine";
import type { Manifest } from "./manifest";
import { readEnvValues } from "./envFile";
import { integrationStatus } from "./integrationStatus";
import { ThatTracksClient } from "./thatTracks";

// Integrations the UI hides even when vault.yaml names them — RETIRED ones,
// whose runners the engine no longer ships (email and its dispatcher, gone
// 2026-08-10). A manifest is a user's file; it may name these for a long
// time after an upgrade. Listing them anyway offered a toggle for a thing
// that cannot run, which is how "we deleted email" and "why do I still see
// email" were both true. The canonical list is lib/personas.ts's
// RETIRED_INTEGRATIONS (#265) — one home, no copy to drift from.
const RETIRED = RETIRED_INTEGRATIONS;

/** Every integration the UI should show: vault.yaml entries first (manifest
 * order), then integrations/ dirs not yet listed. `configYaml` is the entry's
 * opaque keys rendered back to YAML — `enabled` is the framework's and rides
 * separately. */
export function integrationsInfo(root: string, manifest: Manifest): unknown[] {
  const codeDir = join(ENGINE_ROOT, "integrations");
  const dirs = existsSync(codeDir)
    ? readdirSync(codeDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => d.name)
        .sort()
    : [];
  const names = [
    ...Object.keys(manifest.integrations),
    ...dirs.filter((d) => !(d in manifest.integrations)),
  ].filter((n) => !RETIRED.has(n) && (n!=="email" || emailConfig(manifest.integrations.email).inboxes.length>0) && (n!=="that-tracks" || !!integrationAccountKey(root,n,n) || extraAccounts(root,n).length>0));
  return names.map((name) => {
    const cfg = (manifest.integrations[name] ?? {}) as Record<string, unknown>;
    const { enabled: _enabled, ...opaque } = cfg;
    return {
      name,
      // The row's KIND, so the shape of a row is data rather than an
      // assumption the UI makes (#109). Everything here is a `poller`: a
      // vault.yaml-declared inbound integration whose code lives in the
      // engine, whose verb is enable/disable, and whose credential WE hold.
      // An agent connection is the mirror image — it runs on the user's
      // machine, holds OUR token, and its verb is revoke — so if the two
      // ever share a screen (the open decision 2 in
      // docs/plans/2026-08-10-claude-code-integration.md) it arrives as a
      // second kind rather than as a reinterpretation of this one.
      kind: "poller",
      enabled: integrationActive(root, name),
      ...(MANAGED_INTEGRATIONS.has(name) ? { activation: { rule: rememberingRule(root, name), accounts: integrationAccounts(root, name), callers: integrationCallerChoices(root), grants: activationRecord(root, name)?.grants ?? [], checkedAt: activationRecord(root, name)?.checkedAt } } : {}),
      configYaml: Object.keys(opaque).length ? stringify(opaque) : "",
      hasCode: dirs.includes(name),
      // It runs on a clock of its own, rather than only when something
      // calls it. Until #645 this asked whether the integration shipped a
      // launchd plist; CADENCE is where a cadence lives now, so a new
      // integration wants a row there as well as a run.ts.
      hasTrigger: name in CADENCE,
      // credential fields: set-ness always, the value only when non-secret —
      // a secret never rides an API response (write-only key UI)
      env: envFieldStates(root, name),
      ...(["granola", "that-tracks"].includes(name) ? {
        status: integrationStatus(root, name, integrationActive(root, name),
          name === "granola" ? integrationConnected(root,name) : envFieldStates(root, name).every(f => f.set)),
      } : {}),
      // an integration that reads several things, each with its own
      // credential, lists them: email's inboxes, the last poll's word per
      // inbox, and the form that adds one (lib/emailConfig.ts)
      ...(name === "email" ? { sources: emailSources(root, emailConfig(cfg)), add: INBOX_ADD } : {}),
    };
  });
}

/** Apply one POST /api/config body: parse and apply. Answers what the route
 * should send — every failure is a 400 with a JSON error, same as the
 * handler this replaces. */
export async function configSave(
  root: string,
  body: string,
  probe: InboxProbe = probeInbox,
  probeTracks: (key: string) => Promise<unknown> = key => new ThatTracksClient(key).identity()
): Promise<{ status: number; body: string }> {
  try {
    const patch = JSON.parse(body) as ConfigPatch;
    const activationChecks = new Map<string, { fingerprint: string; prior: string; grants: import("./integrationAccess").IntegrationGrant[] }>();
    const ops = patch.integrations ?? [];
    if (!Array.isArray(ops) || new Set(ops.map(o => o.name)).size !== ops.length) throw new Error("Choose each integration only once per save.");
    for (const op of ops) {
      if (op.checkAccess) {
        if (ops.length !== 1 || Object.keys(patch).length !== 1 || Object.keys(op).some(k => !["name", "checkAccess"].includes(k))) throw new Error("Check account access separately from configuration changes.");
        await checkIntegrationConnection(root, op.name, probe, probeTracks);
        return { status: 200, body: JSON.stringify({ changed: [], committed: false, accessChecked: true }) };
      }
      if (op.enabled === true && MANAGED_INTEGRATIONS.has(op.name)) {
        if (op.activate !== true || typeof op.remember !== "string" || !op.remember.trim() || op.remember.length > 8000) throw new Error("Confirm account access and a remembering rule before activating.");
        if (op.env || op.add || op.remove || op.configYaml !== undefined) throw new Error("Save account settings before activating.");
        const grants = validateIntegrationGrants(root, op.name, op.readers);
        const fingerprint = integrationFingerprint(root, op.name);
        const prior = JSON.stringify(activationRecord(root, op.name) ?? null);
        await checkIntegrationConnection(root, op.name, probe, probeTracks);
        if (fingerprint !== integrationFingerprint(root, op.name)) throw new Error("Account settings changed during the access check. Try again.");
        activationChecks.set(op.name, { fingerprint, prior, grants });
      } else if (op.readers !== undefined || op.activate !== undefined) throw new Error("Update tool access through the activation form.");
    }
    // An inbox is added only if it logs in: the first live add (2026-09-04)
    // saved a mistyped host and the row could only say so a poll later.
    // The probe's words are the form's error; nothing is written on a
    // failure. Parsed here too, so a malformed form fails before the probe.
    for (const op of patch.integrations ?? [])
      if (op.add !== undefined && op.name === "email") {
        const a = parseInboxAdd(op.add);
        await probe({ address: a.address, host: a.host, password: a.password });
      }
    for (const op of patch.integrations ?? []) {
      if (op.name !== "that-tracks" || (!op.env?.THAT_TRACKS_API_KEY)) continue;
      const key = op.env?.THAT_TRACKS_API_KEY ?? readEnvValues(root).THAT_TRACKS_API_KEY;
      if (typeof key !== "string" || !key.trim()) throw new Error("Add a That Tracks API key to connect");
      await probeTracks(key.trim());
    }
    for (const [name, check] of activationChecks) if (check.fingerprint !== integrationFingerprint(root, name) || check.prior !== JSON.stringify(activationRecord(root, name) ?? null)) throw new Error("Account settings changed during the access check. Try again.");
    const result = applyConfig(patch, root);
    for (const op of ops) if (op.enabled === false && MANAGED_INTEGRATIONS.has(op.name)) deactivateIntegration(root, op.name);
    for (const [name, check] of activationChecks) saveIntegrationActivation(root, name, check.grants, check.fingerprint);
    return { status: 200, body: JSON.stringify(result) };
  } catch (e) {
    return {
      status: 400,
      body: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
    };
  }
}
