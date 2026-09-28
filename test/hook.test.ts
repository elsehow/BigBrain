import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mergeHook, removeHookFrom, renderHookEntry } from "../lib/hook";

const ROOT = "/tmp/bb-hook-test-root";

/** Round-trip an entry through JSON exactly like settings.json does (write +
 * read), then run its rendered command against synthetic hook-input JSON —
 * the only way to be sure the jq escaping (lake/.blobs literal dot) survives
 * the whole pipeline, not just the JS string construction. */
function run(input: object, env: Record<string, string> = {}): string {
  const entry = renderHookEntry(ROOT);
  const roundTripped = JSON.parse(JSON.stringify(entry));
  const cmd = roundTripped.hooks[0].command as string;
  const r = spawnSync("bash", ["-c", cmd], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, BIGBRAIN_ROLE: "", ...env },
  });
  if (r.status !== 0 && r.stderr) throw new Error(`jq failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** An interactive session: no BIGBRAIN_ROLE. Cleared explicitly, so the suite
 * asserts the interactive posture even when it runs inside a machine pass. */
const decide = (input: object): string => run(input);

/** A sanctioned machine pass. */
const machineDecide = (input: object): string => run(input, { BIGBRAIN_ROLE: "editor" });

describe("write-guard covers the record planes", () => {
  test("references/ write is denied", () => {
    const out = decide({
      tool_input: { file_path: `${ROOT}/references/2026-08-02-x.md` },
      cwd: ROOT,
    });
    expect(out).toContain('"permissionDecision":"deny"');
  });

  test("legacy lake/ write is still denied", () => {
    const out = decide({
      tool_input: { file_path: `${ROOT}/lake/2026/08/x.md` },
      cwd: ROOT,
    });
    expect(out).toContain('"permissionDecision":"deny"');
  });

  test("queue/ write is denied — lifecycle belongs to the runner", () => {
    const out = decide({
      tool_input: { file_path: `${ROOT}/queue/pending/q-1.yaml` },
      cwd: ROOT,
    });
    expect(out).toContain('"permissionDecision":"deny"');
    const bash = decide({
      tool_input: { command: "mv queue/pending/q-1.yaml queue/done/" },
      cwd: ROOT,
    });
    expect(bash).toContain('"permissionDecision":"deny"');
  });

  test(".blobs/ write is denied (path form)", () => {
    const out = decide({
      tool_input: { file_path: `${ROOT}/.blobs/sha256/ab/deadbeef` },
      cwd: ROOT,
    });
    expect(out).toContain('"permissionDecision":"deny"');
  });

  test("bare .blobs/ token (cwd inside root) is denied", () => {
    const out = decide({ tool_input: { command: "echo hi > .blobs/foo" }, cwd: ROOT });
    expect(out).toContain('"permissionDecision":"deny"');
  });

  test('a name that merely contains "blobs" is not denied', () => {
    const outFile = decide({
      tool_input: { file_path: `${ROOT}/foo.blobsextra` },
      cwd: ROOT,
    });
    expect(outFile).toBe("");
    const outDir = decide({ tool_input: { command: "echo hi > blobsville/x" }, cwd: ROOT });
    expect(outDir).toBe("");
  });

  test("BIGBRAIN_ROLE is the machine's write key — the record planes open", () => {
    // The machine pass IS the sanctioned writer of references/, entities/,
    // lake/. That is the whole point of the key.
    expect(machineDecide({ tool_input: { file_path: `${ROOT}/lake/x.md` }, cwd: ROOT })).toBe("");
    expect(
      machineDecide({ tool_input: { file_path: `${ROOT}/references/x.md` }, cwd: ROOT })
    ).toBe("");
    expect(
      machineDecide({ tool_input: { file_path: `${ROOT}/entities/x.md` }, cwd: ROOT })
    ).toBe("");
  });

  test("BIGBRAIN_ROLE does NOT open queue/ — the audit spine stays closed (#67)", () => {
    // 2026-08-07: a person's directive vanished from queue/pending/ with no
    // trace, and the leading candidate was a pass tidying "stray" untracked
    // files — with BIGBRAIN_ROLE set, which used to exit 0 before any check.
    const write = machineDecide({
      tool_input: { file_path: `${ROOT}/queue/pending/q-1.yaml` },
      cwd: ROOT,
    });
    expect(write).toContain('"permissionDecision":"deny"');
    const rm = machineDecide({
      tool_input: { command: "rm queue/pending/q-1.yaml" },
      cwd: ROOT,
    });
    expect(rm).toContain('"permissionDecision":"deny"');
    expect(rm).toContain("#67");
    const logWrite = machineDecide({
      tool_input: { file_path: `${ROOT}/log/insertions/2026-08/x.json` },
      cwd: ROOT,
    });
    expect(logWrite).toContain('"permissionDecision":"deny"');
  });

  test("a machine pass command naming the queue — no queue/ path token — still passes", () => {
    const out = machineDecide({
      tool_input: { command: 'bigbrain observe "the queue felt slow today"' },
      cwd: ROOT,
    });
    expect(out).toBe("");
  });

  test("entities/, references/, and log/ are denied", () => {
    for (const tree of ["entities", "references", "log"]) {
      const out = decide({ tool_input: { file_path: `${ROOT}/${tree}/x.md` }, cwd: ROOT });
      expect(out).toContain('"permissionDecision":"deny"');
    }
  });

  test("inbox/ writes stay legitimate (not denied)", () => {
    const out = decide({ tool_input: { file_path: `${ROOT}/inbox/x.md` }, cwd: ROOT });
    expect(out).toBe("");
  });
});

describe("mergeHook / removeHookFrom", () => {
  test("merging into empty settings creates the PreToolUse entry", () => {
    const { settings, changed } = mergeHook({}, ROOT);
    expect(changed).toBe(true);
    const pre = settings.hooks!["PreToolUse"] as unknown[];
    expect(pre).toHaveLength(1);
  });

  test("removing strips exactly this root's entry, leaves others untouched", () => {
    const other = {
      matcher: "Write",
      hooks: [{ type: "command", command: "echo other", timeout: 5 }],
    };
    const merged = mergeHook({ hooks: { PreToolUse: [other] } }, ROOT).settings;
    const { settings, changed } = removeHookFrom(merged, ROOT);
    expect(changed).toBe(true);
    expect(settings.hooks!["PreToolUse"]).toEqual([other]);
  });
});

describe("write-guard covers the memory pass's trees (the memory boundary)", () => {
  test("memory/ and observations/ writes are denied — feed them via observe / search --why", () => {
    for (const p of ["memory/MEMORY.md", "observations/pending/obs-1.yaml"]) {
      const out = decide({ tool_input: { file_path: `${ROOT}/${p}` }, cwd: ROOT });
      expect(out).toContain('"permissionDecision":"deny"');
    }
    const bash = decide({
      tool_input: { command: "echo x >> memory/MEMORY.md" },
      cwd: ROOT,
    });
    expect(bash).toContain('"permissionDecision":"deny"');
  });
});
