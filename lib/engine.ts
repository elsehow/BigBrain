/**
 * engine.ts — where am I (the code), and where is the vault (the content)?
 *
 * The engine (this checkout: bin/, lib/, web/, integrations/) and a vault
 * (vault.yaml + the content trees) are SEPARATE directories. Code locates
 * itself via ENGINE_ROOT; it finds the vault by discovery:
 *
 *   1. BIGBRAIN_VAULT env var — explicit always wins. Set by the
 *      supervisor for its children, and by the `bigbrain` CLI for its own.
 *   2. Walk up from cwd to the nearest directory containing vault.yaml —
 *      "I'm standing in a vault" (interactive sessions, sandboxes).
 *   3. The pointer file ~/.config/bigbrain/vault (one line, absolute path;
 *      written by init) — the machine's default vault.
 *
 * This module is the layer below lib/manifest.ts and must import nothing
 * from it.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { supervisorPid } from "./parentWatch";
import { vaultOverride, vaultPointerOverride } from "./env";

/** The engine checkout's root — lib/ sits one level below it. */
export const ENGINE_ROOT = resolve(import.meta.dir, "..");

/** What this engine is, for whoever asks over the viewer port
 * (`GET /api/engine`): its root, and the `BUNDLE` stamp the desktop build
 * writes (`engine <commit>` / `built <when>`) when it is a bundled copy.
 * The desktop shell asks before attaching to an engine already answering
 * on its ports — an older app's engine or a CLI install is not the one it
 * shipped with, and it says so instead of showing it.
 *
 * `supervisor`: the pid of bin/desktop.ts (this process for the setup door,
 * the parent supervisor for its viewer child)
 * (BIGBRAIN_SUPERVISOR_PID, lib/parentWatch.ts), or null under a job
 * manager. The shell checks that pid is alive before attaching: the same
 * engine answering with a dead supervisor behind it is an orphan of an
 * earlier app (#597), to be cleared, not shown. */
export function engineIdentity(): { engine: string; bundle: string | null; supervisor: number | null } {
  let bundle: string | null = null;
  try {
    bundle = readFileSync(join(ENGINE_ROOT, "BUNDLE"), "utf8").trim() || null;
  } catch {
    /* a checkout: no stamp */
  }
  return { engine: ENGINE_ROOT, bundle, supervisor: supervisorPid() };
}

/** The per-user config dir (`~/.config/bigbrain`): the vault pointer, token
 * stores, integration secrets. */
export function configDir(): string {
  return join(homedir(), ".config", "bigbrain");
}

/** The machine's default-vault pointer: one line, an absolute path. */
export function vaultPointer(): string {
  return vaultPointerOverride() ?? join(configDir(), "vault");
}

/** The machine's default-vault pointer's contents: an absolute path, or
 * "" when there is no pointer or it cannot be read. */
export function readPointer(): string {
  try {
    return readFileSync(vaultPointer(), "utf8").trim();
  } catch {
    return ""; // absent or unreadable = no pointer
  }
}

/** What the default-vault pointer should say after `bigbrain init` builds a
 * vault at `root`, given what it says now.
 *
 * init claims an UNSET pointer — the first vault on a machine is the
 * machine's vault — and one the caller asked for (`--make-default`). It
 * leaves a pointer naming a different vault alone: creating a second vault
 * must not silently retarget the app. #604 lost the real pointer to a
 * scratch vault made for a test, and the app then found no vault and
 * reopened the setup door on every launch.
 *
 * `opens` is what the machine will open afterwards, which is NOT `root`
 * when init declines to take a pointer someone else set. */
export function pointerPlan(
  previous: string,
  root: string,
  asked: boolean
): { opens: string; changed: boolean; replaced?: string } {
  const prev = previous.trim();
  if (prev === root) return { opens: root, changed: false };
  if (!prev) return { opens: root, changed: true };
  return asked ? { opens: root, changed: true, replaced: prev } : { opens: prev, changed: false };
}

/** Env → walk-up → pointer; null when nothing matches. The result is not
 * checked for a vault.yaml: init legitimately targets a not-yet-vault, and
 * loadManifest gives the real error for a wrong path. */
export function discoverVaultRoot(cwd: string = process.cwd()): string | null {
  const env = vaultOverride();
  if (env) return resolve(env);

  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "vault.yaml"))) return dir;
    if (dirname(dir) === dir) break;
  }

  const p = readPointer();
  return p && isAbsolute(p) ? p : null;
}

/** discoverVaultRoot() or one loud error naming every mechanism. */
export function requireVaultRoot(): string {
  const root = discoverVaultRoot();
  if (root) return root;
  throw new Error(
    "no vault found — set BIGBRAIN_VAULT, run from inside a vault (a directory tree containing vault.yaml), " +
      `or create ${vaultPointer()} pointing at one. No vault yet? \`bigbrain init --vault <path>\` creates it.`
  );
}
