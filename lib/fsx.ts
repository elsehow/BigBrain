/**
 * fsx.ts — vault filesystem conventions. Two protocol rules live here:
 * atomic file publication (create-only for events, replace for caches) and the frontmatter
 * stamp (provenance is applied by the RUNNER, never written by a model).
 */

import { chmodSync, existsSync, linkSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { slug } from "./slug";
import { stringify } from "yaml";

/** `mode` applies to every directory this creates, none it finds. */
export function ensureDir(dir: string, mode?: number): void {
  mkdirSync(dir, mode !== undefined ? { recursive: true, mode } : { recursive: true });
}

/** Clear the group/other bits an older writer left on a private file or
 * directory; the owner's bits stay. Returns whether it changed anything.
 * A directory is not recursed into: owner-only, it already hides its files. */
export function makePrivate(path: string): boolean {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return false; // absent: whoever creates it sets the mode
  }
  if (!(mode & 0o077)) return false;
  chmodSync(path, mode & 0o700);
  return true;
}

/** A private file's missing parent directories are created private too, so
 * a token store is never the first file in a world-readable folder. */
const parentMode = (mode?: number): number | undefined => (mode !== undefined && !(mode & 0o077) ? 0o700 : undefined);

/** First non-colliding `<dir>/<filename>`, suffixing -2, -3, … before the
 * .md extension. */
export function uniquePath(dir: string, filename: string): string {
  let path = join(dir, filename);
  for (let n = 2; existsSync(path); n++) path = join(dir, filename.replace(/\.md$/, `-${n}.md`));
  return path;
}

const tempPath = (path: string): string =>
  join(dirname(path), `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);

/** Atomic write: temp file in the same directory, then rename. `mode` is
 * applied to the temp file so the final path never exists with looser
 * permissions (token stores are 0o600), and an owner-only `mode` makes any
 * parent directory it creates 0o700. */
export function writeAtomic(path: string, content: string | Buffer, mode?: number): void {
  ensureDir(dirname(path), parentMode(mode));
  const tmp = tempPath(path);
  writeFileSync(tmp, content, mode !== undefined ? { mode } : {});
  renameSync(tmp, path);
}

/** Publish a complete file only if its destination is absent. Linking the
 * prepared file is atomic and cannot replace another writer's event. */
export function createAtomic(path: string, content: string | Buffer, mode?: number): boolean {
  ensureDir(dirname(path), parentMode(mode));
  const tmp = tempPath(path);
  writeFileSync(tmp, content, mode !== undefined ? { mode } : {});
  try {
    linkSync(tmp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(tmp);
  }
}

/** YAML-safe scalar: plain when boring, JSON-quoted otherwise. A string
 * that YAML would read back as a NUMBER or BOOLEAN is quoted too — an
 * all-digit token id emitted bare came back as a number and failed every
 * strict string comparison downstream (found via a flaky /v1/session
 * test: ids are hex, and ~2% of them are all digits). */
export function yscalar(v: string): string {
  const boring = /^[A-Za-z0-9][A-Za-z0-9 ._@/-]*$/.test(v);
  const readsAsNonString =
    !Number.isNaN(Number(v)) || /^(true|false|null|yes|no|on|off)$/i.test(v);
  return boring && !readsAsNonString ? v : JSON.stringify(v);
}

/** Render a frontmatter block from ordered key/value pairs. A list value is
 * emitted as a YAML block sequence (each item yscalar-safe) — so identifiers
 * that contain commas (meeting titles, names) survive as distinct entries. */
export type FrontmatterValue = string | string[] | Record<string, unknown>[];

export function frontmatter(pairs: [string, FrontmatterValue][]): string {
  const render = (k: string, v: FrontmatterValue): string[] => {
    if (!Array.isArray(v)) return [`${k}: ${yscalar(v)}`];
    if (v.length === 0) return [`${k}: []`];
    if (v.every((x): x is string => typeof x === "string"))
      return [`${k}:`, ...v.map((x) => `  - ${yscalar(x)}`)];
    return stringify({ [k]: v }).trimEnd().split("\n");
  };
  // Callers build these arrays with conditional spreads, where `...(c ? [p] :
  // [])` and `...(c ? p : [])` differ by one bracket and only the first is
  // right. Get it wrong and a bare pair scatters into two elements: the KEY
  // destructures per-character into `p: a`, and the value array becomes an
  // `[object Object]` key. That renders as valid-looking YAML, so it reaches
  // the vault silently. Refuse the malformed shape instead.
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string")
      throw new Error(`frontmatter: expected [key, value] pairs, got ${JSON.stringify(pair)?.slice(0, 60)}`);
  }
  return ["---", ...pairs.flatMap(([k, v]) => render(k, v)), "---", ""].join("\n");
}

/**
 * Split a note into its raw frontmatter block and body. Tolerant: a note
 * without frontmatter comes back with fm === "".
 */
export function splitNote(text: string): { fm: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  return m ? { fm: m[1]!, body: text.slice(m[0].length) } : { fm: "", body: text };
}

/**
 * Add runner-applied provenance keys to a note's frontmatter (creating the
 * block if absent). Models never write these; the runner stamps them.
 */
export function stampNote(text: string, stamps: [string, string][]): string {
  const { fm, body } = splitNote(text);
  const lines = fm ? fm.split("\n") : [];
  for (const [k, v] of stamps) lines.push(`${k}: ${yscalar(v)}`);
  return ["---", ...lines, "---", "", body.replace(/^\n+/, "")].join("\n");
}

export const slugify = (s: string): string => slug(s, { maxLen: 60, fallback: "note" });
