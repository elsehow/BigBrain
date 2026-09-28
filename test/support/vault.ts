// The scratch-vault fixtures, and the source-insertion factory.
//
// Both were written by hand across the suite before they lived here: the
// git-vault 9× (#265), and the `source.inserted` object literal in 12 test
// files plus 7 more inlining it (#637). The literal is the expensive one —
// every field of `SourceInsertion` spelled out 19 times means adding a field
// to the type is 19 edits, and 19 chances to write a fixture that no longer
// resembles what the engine actually stores.
//
// Every caller differs in a small deliberate way — a seed file's content, an
// envelope that says `from_kind: person`, whether the FIRST commit happens at
// all — so those differences ride as arguments, and don't get flattened away.
//
// bun test only collects `*.test.ts`, so this file is invisible to the
// runner; nothing here executes unless a test imports it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSourceInsertionEvent, type SourceInsertion } from "../../lib/insertionLog";
import type { Manifest } from "../../lib/manifest";

export interface GitIdentity {
  name: string;
  email: string;
}

const DEFAULT_IDENTITY: GitIdentity = { name: "test", email: "test@test" };

export interface VaultOpts {
  /** `mkdtemp` prefix. */
  prefix?: string;
  /** Subdirectories created (`mkdir -p`) before anything is written. */
  dirs?: string[];
  /** Vault-relative path → content. Parent directories are created. */
  files?: Record<string, string>;
}

export interface GitVaultOpts extends VaultOpts {
  /** Skip `git init` entirely — references.test.ts asserts landing is
   * fail-soft against a root that isn't a git repo at all. Prefer
   * `mdVault`, which says the same thing by name. */
  git?: boolean;
  /** Committer identity for `git config`. */
  identity?: GitIdentity;
  /** Initial commit message, or `false` to leave the tree uncommitted (some
   * suites drive every commit themselves via their own `commitAs`). */
  commit?: string | false;
}

/** A scratch vault with no git repo: a temp directory, some subdirectories,
 * some files. What most fixtures actually need. */
export function mdVault(opts: VaultOpts = {}): string {
  const root = mkdtempSync(join(tmpdir(), opts.prefix ?? "bb-vault-"));
  for (const dir of opts.dirs ?? []) mkdirSync(join(root, dir), { recursive: true });
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

/** The shared git-vault fixture: a real git repo (most of what's under test
 * shells out to git), scaffolded to taste and — by default — one initial
 * commit. See `GitVaultOpts` for what each caller can vary. */
export function gitVault(opts: GitVaultOpts = {}): string {
  const { identity = DEFAULT_IDENTITY, commit = "init" } = opts;
  const root = mdVault(opts);
  if (opts.git === false) return root;
  const runGit = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  runGit(["init", "-q"]);
  runGit(["config", "user.email", identity.email]);
  runGit(["config", "user.name", identity.name]);
  if (commit !== false) {
    runGit(["add", "-A"]);
    runGit(["commit", "-q", "-m", commit]);
  }
  return root;
}

/** What a vault says to declare the assertion substrate native. */
export const NATIVE_YAML = "assertions:\n  native: true\n";

/** A scratch vault with insertion events already in `log/insertions/`.
 * Appending through the real `appendSourceInsertionEvent` is the point: the
 * fixture is built the way intake builds it, month directories and all. */
export function nativeVault(
  opts: VaultOpts & { insertions?: readonly SourceInsertion[] } = {}
): string {
  const root = mdVault(opts);
  for (const event of opts.insertions ?? []) appendSourceInsertionEvent(root, event);
  return root;
}

/** One `source.inserted` event. Pass what the test is actually about; the
 * rest is a plausible meeting. `source_id`, `title` and `content_sha256`
 * follow the id unless overridden, so a caller naming only `id` and `body`
 * still gets a coherent event.
 *
 * UNDATED unless you say otherwise. An insertion's month directory and sort
 * key come from `received_at ?? occurred_at`, so a default date here would
 * be a fixture quietly deciding something several suites assert on — and a
 * legitimately dateless insertion (a legacy import) could not be written at
 * all. Say `occurred_at` or `received_at` when the test is about time. */
export function insertion(over: Partial<SourceInsertion> = {}): SourceInsertion {
  const id = over.id ?? `ins_${"0".repeat(24)}`;
  const source_id = over.source_id ?? `source-${id}`;
  return {
    event: "source.inserted",
    id,
    source_id,
    author: { kind: "service", id: "test" },
    title: `Title ${id}`,
    body: "Ada said the Atlas experiment should test sparse probes.",
    envelope: { id: source_id, kind: "meeting" },
    content_sha256: `sha-${id}`,
    ...over,
  };
}

/** A test file's OWN numbered stream of insertions — `ins_001…`, `ins_002…`,
 * each received a minute after the last. For the suites about order, depth
 * and backlog, where what matters is that there are N of them in sequence.
 *
 * Per file, deliberately. `bun test` shares one module registry across test
 * files and does not run them in a fixed order (b.test.ts can take 1 and 2
 * while a.test.ts takes 3 and 4), so a counter living in THIS module would
 * hand a test different ids depending on which other files ran first. A
 * factory per file keeps the numbering a property of the file that reads it.
 *
 * `defaults` rides on every call — where a suite wants its own tag or hour,
 * it says so once rather than at each call site. */
export function insertionSeq(
  defaults: (n: string) => Partial<SourceInsertion> = () => ({})
): (over?: Partial<SourceInsertion>) => SourceInsertion {
  let seq = 0;
  return (over: Partial<SourceInsertion> = {}) => {
    const n = String(++seq).padStart(3, "0");
    return insertion({
      id: `ins_${n}${"0".repeat(18)}abc`,
      source_id: `src-${n}`,
      title: `Item ${n}`,
      body: `Body of item ${n}: Ada said the Atlas experiment should test sparse probes today.`,
      content_sha256: `sha-${n}`,
      received_at: `2026-08-20T10:${n.slice(-2)}:00.000Z`,
      ...defaults(n),
      ...over,
    });
  };
}

/** The base `Manifest` for the tests that need one — one model, one auth
 * (#524) — with `over` spread on top for a caller's own fields
 * (memory.test.ts's `memory:` block) or overrides. */
export function testManifest(root: string, over: Partial<Manifest> = {}): Manifest {
  return {
    root,
    auth: "max",
    integrations: {},
    gardener: { adapter: "pi", provider: "anthropic", model: "claude-x" },
    memory: {
      adapter: "pi", provider: "anthropic",
      model: "claude-x",
      interval: "1d",
      intervalMs: 86_400_000,
    },
    ...over,
  } as Manifest;
}
