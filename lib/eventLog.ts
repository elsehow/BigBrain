/** One append-only event log, written once.
 *
 * Assertions, declines, revocations, entity aliases and source insertions are
 * the same machine: one immutable JSON event per file, the filename IS the
 * event id, filed under the month it happened, never edited. Each log carried
 * its own hand copy of that machine — the month-directory walk, the
 * collision check, the tolerant read, the porcelain-additions commit filter —
 * so a sixth event kind meant a sixth copy, and a fix in one was a fix in
 * exactly one (#637).
 *
 * This is the machine. A `*Log.ts` module is now what only it can say: its
 * event type, its validator, and its create function. Each keeps its own log
 * DIRECTORY on purpose — the assertion log's readers validate that log
 * strictly, and a separate homogeneous log costs one directory where a mixed
 * one costs a guard in every reader forever (lib/declineLog.ts's reason).
 */
import { markVaultChanged } from "./vaultChanges";

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createAtomic } from "./fsx";
import { commitPathsOnly, gitLines, gitOut } from "./git";

/** One event's file, without reading it. */
export interface EventFile {
  id: string;
  abs: string;
}

export interface AppendResult<T> {
  event: T;
  path: string;
  /** The event was already on disk, byte-identical — a retry, not new work. */
  deduped: boolean;
}

export interface EventLogSpec<T> {
  /** Names the log in every error message (`${name}-log: …`) and in the
   * subject of its commits. */
  name: string;
  /** Vault-relative log directory, e.g. `log/assertions`. */
  dir: string;
  /** The event's own timestamp. It picks the month directory and orders a
   * read; an event without one files under `undated/`. */
  when: (event: T) => string;
  /** Throws when the event is not well-formed. Runs before every append and
   * on every event read back, so an invalid event can neither be written nor
   * mistaken for the record. */
  validate: (event: T) => void;
}

export interface EventLog<T> {
  /** Vault-relative log directory. */
  dir: string;
  /** Where an event with this id and timestamp belongs, vault-relative.
   * For a caller holding an id and a date but not the event —
   * lib/searchCore.ts ranks over slim projected rows that carry no body. */
  path(id: string, when: string): string;
  /** Where this event belongs, vault-relative. */
  rel(event: T): string;
  /** Idempotently append. A deterministic event id makes a retry converge on
   * the same file; a DIFFERENT event under an id already on disk is a
   * collision and throws, because these files are never edited. */
  append(root: string, event: T): AppendResult<T>;
  /** Cheap census — id per file, no parse. The filename is the event id, so
   * an incremental projection diffs this listing against what it already
   * holds and reads only the new files (#456). */
  listFiles(root: string): EventFile[];
  /** Every valid event, oldest first. Tolerant by default: unreadable or
   * invalid files are skipped, because an operational reader must not crash
   * on damage. `strict` throws instead — what a projection builder wants,
   * so missing evidence can never look complete. */
  read(root: string, opts?: { strict?: boolean }): T[];
  /** Commit only append-only additions under this log's directory. Never
   * throws: events are already safe on disk, and a vault need not be a git
   * repo at all. */
  commit(root: string, preferred: readonly string[], summary: string): void;
}

/** Read one event file: parse it, validate it, and check that the event
 * carries the id its filename claims. The three checks that make a file part
 * of the record. `read` applies them to a whole log; the incremental
 * projection applies them one file at a time — it skips what it already
 * holds and so cannot go through `read` — and both must mean the same thing
 * by a valid event file. Throws bare; the caller names the log. */
export function parseEventFile<T extends { id: string }>(
  file: EventFile,
  validate: (event: T) => void
): T {
  const event = JSON.parse(readFileSync(file.abs, "utf8")) as T;
  validate(event);
  if (event.id !== file.id) throw new Error("event id does not match its filename");
  return event;
}

export function eventLog<T extends { id: string }>(spec: EventLogSpec<T>): EventLog<T> {
  const { name, dir, when, validate } = spec;

  const path = (id: string, at: string): string =>
    `${dir}/${/^\d{4}-\d{2}/u.exec(at)?.[0] ?? "undated"}/${id}.json`;
  const rel = (event: T): string => path(event.id, when(event));

  const listFiles = (root: string): EventFile[] => {
    const base = join(root, dir);
    let months;
    try {
      months = readdirSync(base, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: EventFile[] = [];
    const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);
    for (const month of months.filter((entry) => entry.isDirectory()).sort(byName)) {
      for (const file of readdirSync(join(base, month.name)).filter((value) => value.endsWith(".json")).sort()) {
        out.push({ id: file.slice(0, -".json".length), abs: join(base, month.name, file) });
      }
    }
    return out;
  };

  return {
    dir,
    path,
    rel,
    listFiles,

    append(root, event) {
      validate(event);
      const at = rel(event);
      const abs = join(root, at);
      const encoded = `${JSON.stringify(event)}\n`;
      if (!createAtomic(abs, encoded)) {
        if (readFileSync(abs, "utf8") !== encoded)
          throw new Error(`${name}-log: immutable event collision: ${event.id}`);
        return { event, path: at, deduped: true };
      }
      markVaultChanged(root);
      return { event, path: at, deduped: false };
    },

    read(root, opts = {}) {
      const rows: T[] = [];
      for (const file of listFiles(root)) {
        try {
          rows.push(parseEventFile(file, validate));
        } catch (error) {
          if (opts.strict) throw new Error(`${name}-log: unreadable event ${file.abs}: ${error}`);
        }
      }
      return rows.sort((a, b) => when(a).localeCompare(when(b)) || a.id.localeCompare(b.id));
    },

    commit(root, preferred, summary) {
      if (!gitOut(root, ["rev-parse", "--git-dir"])) return;
      try {
        const additions = gitLines(root, ["status", "--porcelain", "--", dir])
          .filter((line) => line.startsWith("??") || line.startsWith("A"))
          .map((line) => line.slice(3).trim().replace(/^"|"$/gu, ""))
          .filter(Boolean);
        const allowed = new Set(additions);
        const paths = [...new Set([...preferred.filter((one) => allowed.has(one)), ...additions])];
        if (paths.length) commitPathsOnly(root, name, summary, paths);
      } catch (error) {
        console.error(`${name}-log: commit failed (events remain safe on disk): ${error}`);
      }
    },
  };
}
