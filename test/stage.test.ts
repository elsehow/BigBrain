import { fakeIntegrationActivation } from "./support/integrationActivation";
/** stage.test.ts — what the pollers found, waiting for the gardener (#744).
 *
 * The invariants: a staged item is a cache file, never an event; the
 * overview is heads only, oldest first; `open` is the follow-up; admit
 * lands through the intake waist and the item is due intake at once, its
 * insertion id in the answer; pass lands nothing and, with a scope, writes
 * a skip rule the poller reads back — except on a protected scope (a
 * person the record knows), which is refused. The same ops ride `submit`,
 * so the MCP tool and the HTTP door speak them without knowing them.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { appendSkipRules, ruleScope, skipMatches, skipRules } from "../lib/skipRules";
import {
  admitStaged,
  openStaged,
  passStaged,
  STAGE_INLINE_CHARS,
  stage,
  stageDir,
  stagedCount,
  stagedHeads,
  stagedIds,
  type StagedItem,
} from "../lib/stage";
import { tendDue } from "../lib/tend";
import { readEmailState } from "../lib/emailState";
import { dueWork, nextWork, submitWire, type StagedJob } from "../lib/work";
import { gitVault, NATIVE_YAML } from "./support/vault";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const YAML = `${NATIVE_YAML}integrations:\n  email:\n    inboxes:\n      - address: a@example.com\n        host: imap.example\n`;

const vault = (): string => {
  const root = gitVault({ prefix: "bb-stage-", files: { "vault.yaml": YAML } });
  fakeIntegrationActivation(root);
  scratch.push(root);
  return root;
};

let n = 0;
const item = (over: Partial<StagedItem> = {}): StagedItem => {
  n += 1;
  const id = over.id ?? `email-${String(n).padStart(20, "0")}`;
  return {
    id,
    source: "email",
    at: `2026-09-04T10:${String(n).padStart(2, "0")}:00.000Z`,
    line: `2026-09-04 · Evan Keller <evan@fri.example.org> · "Re: Ridgeways timing ${n}" · 4k · reply`,
    scopes: { sender: "evan@fri.example.org" },
    name: `2026-09-04-re-ridgeways-timing-${n}.md`,
    content: `---\nid: ${id}\nsource: email\nkind: email\ntitle: "Re: Ridgeways timing ${n}"\ndate: 2026-09-04\n---\n# Re: Ridgeways timing ${n}\n\nFriday works.\n`,
    ...over,
  };
};

const OPTS = {
  author: { kind: "model" as const, id: "test", invocation_id: "t" },
  produced_by: { procedure: "test", version: "v1" },
};

describe("skipRules — standing rules, generic", () => {
  test("a rule is one scope plus reason/at; malformed rules drop; matching is by key and value, case-insensitively", () => {
    const rules = skipRules({
      skip: [
        { sender: "NoReply@GitHub.com", reason: "CI", at: "2026-09-04" },
        { list: "L.example" },
        { reason: "no scope" },
        { sender: "a@b.c", list: "two scopes" },
        "junk",
      ],
    });
    expect(rules).toEqual([
      { sender: "noreply@github.com", reason: "CI", at: "2026-09-04" },
      { list: "l.example", reason: "", at: "" },
    ]);
    expect(ruleScope(rules[0]!)).toEqual(["sender", "noreply@github.com"]);
    expect(skipMatches({ sender: "noreply@github.com" }, rules)).toEqual(rules[0]);
    expect(skipMatches({ sender: "x@y.z", list: "L.EXAMPLE" }, rules)).toEqual(rules[1]);
    expect(skipMatches({ sender: "x@y.z" }, rules)).toBeUndefined();
    // a display name is never a scope value, so a spoofed name matches nothing
    expect(skipMatches({ sender: "GitHub <noreply@github.com>" }, rules)).toBeUndefined();
  });

  test("appendSkipRules: new rules join integrations.<name>.skip, committed as author <name>; duplicates on file or in the batch are not written", () => {
    const root = vault();
    const fresh = appendSkipRules(root, "email", [
      { sender: "noreply@github.com", reason: "CI notifications", at: "2026-09-04" },
      { list: "deals.shop.example", reason: "marketing", at: "2026-09-04" },
      { list: "deals.shop.example", reason: "again, same batch", at: "2026-09-04" },
      { reason: "no scope", at: "2026-09-04" },
    ]);
    expect(fresh.map((r) => ruleScope(r)![1])).toEqual(["noreply@github.com", "deals.shop.example"]);
    const yaml = readFileSync(join(root, "vault.yaml"), "utf8");
    expect(yaml).toContain("- address: a@example.com"); // the inboxes survived the edit
    expect(yaml).toContain("sender: noreply@github.com");
    expect(appendSkipRules(root, "email", [{ sender: "noreply@github.com", reason: "again", at: "2026-09-05" }])).toEqual([]);
    const log = spawnSync("git", ["log", "-1", "--format=%an %s"], { cwd: root, encoding: "utf8" }).stdout;
    expect(log).toContain("email: skip");
    expect(log).toContain("noreply@github.com");
    // a source with no block yet gets one
    expect(appendSkipRules(root, "slack", [{ channel: "#random", reason: "noise", at: "2026-09-04" }])).toHaveLength(1);
    expect(readFileSync(join(root, "vault.yaml"), "utf8")).toContain("channel: \"#random\"");
  });
});

describe("stage — durable pending arrivals, heads first", () => {
  test("old pending bodies and the email cursor survive deleting .state", () => {
    const root = vault();
    const pending = item();
    const legacy = join(root, ".state", "stage", "email");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, `${pending.id}.json`), JSON.stringify(pending));
    const state = { inboxes: { "a@example.com": { uidvalidity: 12, lastUid: 456, mailbox: "INBOX" } } };
    writeFileSync(join(root, ".state", "email.json"), JSON.stringify(state));
    expect(readEmailState(root)).toEqual(state);
    rmSync(join(root, ".state"), { recursive: true, force: true });
    expect(readEmailState(root)).toEqual(state);
    expect(stagedHeads(root).map((h) => h.id)).toEqual([pending.id]);
    expect(openStaged(root, [pending.id])[0]).toMatchObject({ content: pending.content });
    expect(spawnSync("git", ["status", "--porcelain", "--", ".spool"], { cwd: root, encoding: "utf8" }).stdout).toBe("");
    expect(admitStaged(root, [pending.id])[0]).toMatchObject({ ok: true, source_id: pending.id });
  });

  test("backlog reads need only small headers, even when a body is unreadable", () => {
    const root = vault();
    const pending = item({ content: "x".repeat(1_000_000), attachments: [{ name: "large.pdf", b64: "YQ==".repeat(250_000) }] });
    stage(root, pending);
    expect(statSync(join(stageDir(root), "email", `${pending.id}.json`)).size).toBeLessThan(1_000);
    writeFileSync(join(stageDir(root), "email", "bodies", `${pending.id}.json`), "damaged");
    expect(stagedCount(root)).toBe(1);
    expect(stagedHeads(root, 1).map((h) => h.id)).toEqual([pending.id]);
    expect(openStaged(root, [pending.id])[0]).toHaveProperty("error");
  });

  test("a failed skip-rule write leaves the pending arrival available", () => {
    const root = vault();
    const pending = item();
    stage(root, pending);
    writeFileSync(join(root, "vault.yaml"), "integrations:\n  email: invalid-map\n");
    expect(passStaged(root, [pending.id], "skip sender", pending.scopes)[0]).toMatchObject({ ok: false });
    expect(openStaged(root, [pending.id])[0]).toMatchObject({ error: "Integration is inactive; pending data is retained." });
    writeFileSync(join(root, "vault.yaml"), YAML); fakeIntegrationActivation(root);
    expect(openStaged(root, [pending.id])[0]).toMatchObject({ content: pending.content });
    expect(existsSync(join(stageDir(root), "passed.jsonl"))).toBe(false);
  });

  test("stage dedupes by id; heads come back oldest first, without content; open is the follow-up, capped honestly", () => {
    const root = vault();
    const late = item({ at: "2026-09-04T12:00:00.000Z" });
    const early = item({ at: "2026-09-04T08:00:00.000Z" });
    expect(stage(root, late)).toBe(true);
    expect(stage(root, early)).toBe(true);
    expect(stage(root, { ...late, line: "a second poll saw it again" })).toBe(false);
    expect(stagedCount(root)).toBe(2);
    expect(stagedIds(root)).toEqual([early.id, late.id]);
    const heads = stagedHeads(root);
    expect(heads.map((h) => h.id)).toEqual([early.id, late.id]);
    expect(heads[0]).toEqual({ id: early.id, source: "email", at: early.at, line: early.line, scopes: early.scopes });
    expect(heads[0]).not.toHaveProperty("content");
    expect(stagedHeads(root, 1)).toHaveLength(1);

    const big = item({ content: "x".repeat(STAGE_INLINE_CHARS + 5) });
    stage(root, big);
    const opened = openStaged(root, [early.id, big.id, "email-nope"]);
    expect(opened[0]).toMatchObject({ id: early.id, line: early.line, content_length: early.content.length, truncated: false });
    expect((opened[0] as { content: string }).content).toContain("Friday works.");
    expect(opened[1]).toMatchObject({ content_length: STAGE_INLINE_CHARS + 5, truncated: true });
    expect((opened[1] as { content: string }).content.length).toBe(STAGE_INLINE_CHARS);
    expect(opened[2]).toMatchObject({ id: "email-nope", error: expect.stringContaining("not staged") });
  });

  test("bad ids and source names are refused before anything touches the disk", () => {
    const root = vault();
    expect(() => stage(root, item({ id: "../escape" }))).toThrow("bad item id");
    expect(() => stage(root, item({ source: "Email Door" }))).toThrow("bad source name");
    expect(openStaged(root, ["../x"])[0]).toHaveProperty("error");
  });

  test("admit lands through the intake waist: the file is gone, the item is due intake, the answer names the insertion id", () => {
    const root = vault();
    const a = item();
    stage(root, a);
    expect(tendDue(root)).toEqual({ intake: 0, staged: 1, memory: false });
    const [r] = admitStaged(root, [a.id]);
    expect(r).toMatchObject({ id: a.id, ok: true, source_id: a.id });
    expect(r!.insertion_id).toMatch(/^ins_/u);
    expect(stagedCount(root)).toBe(0);
    const due = dueWork(root, { kinds: ["intake"] });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ kind: "intake", insertion_id: r!.insertion_id, source_id: a.id, class: "mail" });
    expect(tendDue(root)).toEqual({ intake: 1, staged: 0, memory: false });
    expect(admitStaged(root, [a.id])[0]).toMatchObject({ ok: false, error: expect.stringContaining("not staged") });
  });

  test("pass lands nothing; with a scope it writes the rule the poller reads back; a protected scope or a foreign scope is refused, the message alone still passable", () => {
    const root = vault();
    const robot = item({ scopes: { sender: "noreply@robot.example", list: "alerts.robot.example" } });
    const person = item({ scopes: { sender: "evan@fri.example.org" }, protect: ["sender"] });
    stage(root, robot);
    stage(root, person);

    const [bad] = passStaged(root, [robot.id], "noise", { sender: "someone@else.example" });
    expect(bad).toMatchObject({ id: robot.id, ok: false, error: expect.stringContaining("carries no sender") });
    const [twoScopes] = passStaged(root, [robot.id], "noise", { sender: "noreply@robot.example", list: "alerts.robot.example" });
    expect(twoScopes!.error).toContain("exactly one scope");
    expect(stagedCount(root)).toBe(2); // refusals leave the item staged

    const [ruled] = passStaged(root, [robot.id], "automated alerts", { list: "Alerts.Robot.Example" }, new Date("2026-09-04T16:00:00Z"));
    expect(ruled).toEqual({ id: robot.id, ok: true, rule: { list: "alerts.robot.example", reason: "automated alerts", at: "2026-09-04" } });
    expect(skipRules(readYamlBlock(root))).toHaveLength(1);
    expect(skipMatches({ sender: "x@y", list: "alerts.robot.example" }, skipRules(readYamlBlock(root)))).toBeDefined();

    const [refused] = passStaged(root, [person.id], "chatty", { sender: "evan@fri.example.org" });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("a person the record knows") });
    expect(stagedCount(root)).toBe(1);
    const [alone] = passStaged(root, [person.id], "this one message");
    expect(alone).toEqual({ id: person.id, ok: true });
    expect(stagedCount(root)).toBe(0);
    expect(existsSync(join(root, "log", "insertions"))).toBe(false); // nothing ever landed
    const passed = readFileSync(join(stageDir(root), "passed.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; rule?: unknown });
    expect(passed.map((p) => p.id)).toEqual([robot.id, person.id]);
    expect(passed[0]).toHaveProperty("rule");
    expect(passed[1]).not.toHaveProperty("rule");
  });
});

function readYamlBlock(root: string): Record<string, unknown> {
  const doc = parseYaml(readFileSync(join(root, "vault.yaml"), "utf8")) as { integrations: { email: Record<string, unknown> } };
  return doc.integrations.email;
}

describe("through the work contract — one next, one submit", () => {
  test("next lists staged heads as jobs beside intake; submit admit then assertion in one call; pass with a rule", () => {
    const root = vault();
    const a = item();
    const b = item({ scopes: { sender: "news@list.example", list: "weekly.list.example" } });
    stage(root, a);
    stage(root, b);
    const items = nextWork(root);
    const staged = items.filter((i) => i.job.kind === "staged").map((i) => i.job as StagedJob);
    expect(staged.map((j) => j.id)).toEqual([a.id, b.id]);
    expect(staged[0]).toMatchObject({ kind: "staged", source: "email", line: a.line, scopes: a.scopes });
    expect(items.find((i) => i.job.kind === "staged")!.inputs).toEqual({ remembering_rule: "Remember useful project decisions; skip promotional messages." });
    expect(nextWork(root, { kinds: ["intake"] })).toEqual([]);

    // admit, then cite the insertion the admit answered — one call
    const first = submitWire(root, [{ submit: "admit", staged_ids: [a.id] }], OPTS);
    expect(first).toMatchObject({ admitted: 1, passed: 0, appended: 0, rejected: 0 });
    const insertionId = (first.results[0]!.staged![0] as { insertion_id: string }).insertion_id;
    const second = submitWire(
      root,
      [
        { submit: "assertion", text: "[[Evan Keller]] says Friday works for the Ridgeways timing.", sources: [insertionId], confidence: "direct" },
        { submit: "pass", staged_ids: [b.id], reason: "a newsletter", rule: { list: "weekly.list.example" } },
      ],
      OPTS
    );
    expect(second).toMatchObject({ appended: 1, passed: 1, admitted: 0, rejected: 0 });
    expect(second.results[1]!.staged![0]).toMatchObject({ ok: true, rule: { list: "weekly.list.example" } });
    expect(nextWork(root)).toEqual([]); // the assertion settled the admitted item; the pass emptied the stage
    expect(readFileSync(join(root, "vault.yaml"), "utf8")).toContain("list: weekly.list.example");

    // wire validation speaks in the caller's words
    const bad = submitWire(root, [{ submit: "admit" }, { submit: "pass", staged_ids: ["x"], rule: "nope" }, { submit: "pass", staged_ids: ["email-gone"], reason: "r" }], OPTS);
    expect(bad.results[0]!.error).toContain("admit needs staged_ids");
    expect(bad.results[1]!.error).toContain("rule must be an object");
    expect(bad.results[2]).toMatchObject({ ok: false, error: expect.stringContaining("not staged") });
    expect(bad.rejected).toBe(3);
  });
});
