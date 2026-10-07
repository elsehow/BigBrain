/**
 * envFile.ts — the vault's credential file: a tolerant KEY=value store the
 * config UI writes and integration runners read.
 *
 * Split out of config.ts because these primitives are security-critical and
 * deserve their own focused tests. A credential written here is only as
 * trustworthy as whoever typed it; historically the integration's unit file
 * `.`-sourced this file in `/bin/sh`, which turned a value like
 * `GRANOLA_API_KEY=x$(cmd)` into command execution as the box user (#550).
 * Two defenses live here so any consumer is safe:
 *   - writeEnvValues shell-single-quotes every value, so even a dot-sourced
 *     file cannot execute it; readEnvValues reverses exactly that encoding.
 *   - runners now read the value through readEnvValues (no shell) rather than
 *     relying on the unit to source the file into the environment.
 * Keeping both means the escaping is belt to the no-shell suspenders.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_ENV } from "./env";
import { writeAtomic } from "./fsx";

/** Where integration credentials live: `<vault>/.env` — the vault's own
 * gitignored credential file, right next to the thing it configures. */
export const envPath = (root: string): string => join(root, ".env");

/** Credential files are 0600. `.env` inside a vault has always been
 * gitignored, but nothing enforced its MODE. */
const ENV_FILE_MODE = 0o600;

/** Shell-single-quote a value so a dot-sourced env file cannot execute it.
 * Single quotes make every byte inert to the shell; the `'\''` idiom
 * (close-quote, escaped quote, reopen) is the only escape a single-quoted
 * string needs. unquoteEnv reverses exactly this encoding. */
function shQuote(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/** Inverse of shQuote for the reader. A single-quoted value (how writeEnvValues
 * now emits, and a valid hand-written form) is unwrapped and un-escaped; a
 * legacy double-quoted or bare value keeps its historical one-pair strip. */
function unquoteEnv(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'"))
    return raw.slice(1, -1).replace(/'\\''/g, "'");
  return raw.replace(/^(")(.*)\1$/, "$2");
}

/** Tolerant KEY=value parse of the vault's .env — comments and junk lines
 * skipped, surrounding quotes stripped. */
export function readEnvValues(root: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(envPath(root), "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = unquoteEnv(m[2]!);
  }
  return out;
}

/** The engine settings a vault's .env carries (lib/env.ts ENGINE_ENV): what
 * bun's autoload once gave every engine process, without the credentials it
 * gave them too (NO_ENV_FILE). Callers spread this first, so a variable
 * already in the environment wins, as it did over the autoload. */
export function vaultEnvSettings(root: string): Record<string, string> {
  const values = readEnvValues(root);
  const out: Record<string, string> = {};
  for (const k of ENGINE_ENV) if (values[k]?.trim()) out[k] = values[k]!;
  return out;
}

/** A bun process started without NO_ENV_FILE holds `<dir>/.env` in its
 * environment. Remove what that file names, except engine settings, so
 * nothing this process spawns inherits it. Names are matched as loosely as
 * bun's loader reads them (`export KEY=`, lower case), not as readEnvValues. */
export function dropAutoloadedEnv(env: Record<string, string | undefined>, dir: string): void {
  let raw: string;
  try {
    raw = readFileSync(envPath(dir), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const k = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(line)?.[1];
    if (k && !(ENGINE_ENV as readonly string[]).includes(k)) delete env[k];
  }
}

/** Write env updates in place: existing KEY= lines are replaced where they
 * stand (comments and unrelated lines untouched), new keys append at the
 * end. Atomic via writeAtomic — .env is config, not a scratch file. Values
 * are shell-single-quoted (see shQuote) so the file is safe to dot-source. */
export function writeEnvValues(root: string, updates: Record<string, string>): void {
  let raw = "";
  try {
    raw = readFileSync(envPath(root), "utf8");
  } catch {
    /* first credential creates the file */
  }
  const pending = new Map(Object.entries(updates));
  const lines = raw.split("\n").map((line) => {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (m && pending.has(m[1]!)) {
      const v = pending.get(m[1]!)!;
      pending.delete(m[1]!);
      return `${m[1]}=${shQuote(v)}`;
    }
    return line;
  });
  let text = lines.join("\n");
  if (pending.size) {
    if (text.length && !text.endsWith("\n")) text += "\n";
    for (const [k, v] of pending) text += `${k}=${shQuote(v)}\n`;
  }
  writeAtomic(envPath(root), text, ENV_FILE_MODE);
}
