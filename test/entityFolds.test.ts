/** entityFolds.test.ts — the feeder (#728): the census the model is shown,
 * the block it answers with, and the validation that stands between the
 * model's groups and `.state/entity-folds.json`. The invariants: only live
 * canonical entities are shown and accepted, a group needs two, an id sits
 * in one group only, a canonical is a member, a rejected pair never
 * re-forms, and nothing is written when the model wrote no answer.
 */
import { describe, expect, test } from "bun:test";
import { MEMORY_PROTOCOL_VERSION, writeMemoryStamp } from "../lib/memory";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertionEntityId, createAssertionEvent, type AssertionEntity } from "../lib/assertionLog";
import { appendAndProjectAssertion, appendAndProjectEntityAlias, projectSourceInsertion, searchAssertionEntities } from "../lib/assertionProjection";
import { scanSurface } from "../lib/searchCore";
import { createEntityAliasEvent } from "../lib/entityAliasLog";
import {
  describeFolds,
  displayWords,
  entityCensus,
  entityFoldsFile,
  parseFolds,
  proposeEntityFolds,
  readEntityFolds,
  renderFoldsPrompt,
  validateFolds,
} from "../lib/entityFolds";
import { appendSourceInsertionEvent } from "../lib/insertionLog";
import type { PiLoader } from "./support/pi";
import { fakePi } from "./support/pi";
import { insertion } from "./support/vault";

const PRODUCED = { procedure: "test", version: "v1" } as const;
const MODEL = { kind: "model", id: "m", invocation_id: "r" } as const;
const ent = (label: string): AssertionEntity => ({ id: assertionEntityId(label), label });
const RIDGEWAYS = ent("Ridgeways");
const RIDGE_WAYS = ent("Ridge Ways");
const AUTO_MAP = ent("Auto-MAP");
const SITE = ent("trails.example.com");
const EK = ent("Evan Keller");
const EVAN = ent("Evan");

let tick = 0;
const stamp = (): string => `2026-08-20T10:${String(tick++ % 60).padStart(2, "0")}:00.000Z`;

/** A vault with one source and the given claims, each `[[label]]` minted. */
function vault(...texts: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "bb-folds-"));
  const ins = insertion({ id: "ins_folds000000000000000000a", body: "A meeting.", occurred_at: "2026-08-18T10:00:00.000Z" });
  appendSourceInsertionEvent(root, ins);
  projectSourceInsertion(root, ins);
  for (const text of texts) {
    const entities: AssertionEntity[] = [];
    const linked = text.replace(/\[\[([^\]|]+)\]\]/g, (_all, label: string) => {
      const e = ent(label);
      if (!entities.some((held) => held.id === e.id)) entities.push(e);
      return `[[${e.id}|${label}]]`;
    });
    appendAndProjectAssertion(root, createAssertionEvent({
      text: linked, entities, sources: [ins.id], author: MODEL,
      confidence: "direct", created_at: stamp(), produced_by: PRODUCED,
    }, new Map([[ins.id, ins]])));
  }
  return root;
}

const CLAIMS = [
  "[[Ridgeways]] ships Friday, said [[Evan Keller]].",
  "[[Ridgeways]] has a capability tab.",
  "[[Ridge Ways]] paper draft is due.",
  "[[Auto-MAP]] is the dashboard's old name; it lives at [[trails.example.com]].",
  "[[Evan]] wants the table by Tuesday.",
];

/** A stub model that answers with the given folds block (or text). */
const answering = (text: string, seen?: { prompt?: string }): PiLoader =>
  fakePi((prompt) => {
    if (seen) seen.prompt = prompt;
    return { result: text };
  });

describe("the census", () => {
  test("every live canonical entity, alphabetical, counted, with its newest claim flattened", () => {
    const root = vault(...CLAIMS);
    const census = entityCensus(root);
    expect(census.map((r) => r.label)).toEqual(["Auto-MAP", "Evan", "Evan Keller", "Ridge Ways", "Ridgeways", "trails.example.com"]);
    const ridgeways = census.find((r) => r.id === RIDGEWAYS.id)!;
    expect(ridgeways.assertions).toBe(2);
    expect(ridgeways.first).toBe("2026-08");
    // the sample is the reader's words — no [[ent_…|…]] in it
    expect(ridgeways.sample).toBe("Ridgeways has a capability tab.");
    expect(census.find((r) => r.id === AUTO_MAP.id)!.sample).toBe("Auto-MAP is the dashboard's old name; it lives at trails.example.com.");
  });

  test("an alias source is already folded — it is not in the census", () => {
    const root = vault(...CLAIMS);
    appendAndProjectEntityAlias(root, createEntityAliasEvent({
      alias: RIDGE_WAYS.label, entity: RIDGEWAYS, author: { kind: "user", id: "nick" },
      created_at: stamp(), produced_by: PRODUCED,
    }));
    const labels = entityCensus(root).map((r) => r.label);
    expect(labels).not.toContain("Ridge Ways");
    expect(labels).toContain("Ridgeways");
  });

  test("displayWords flattens both link forms", () => {
    expect(displayWords("[[ent_0123456789abcdef0123|Nick]] met [[Ada]]  twice")).toBe("Nick met Ada twice");
  });

  test("the prompt carries the template and one line per entity", () => {
    const root = vault(...CLAIMS);
    const prompt = renderFoldsPrompt("# T\n", entityCensus(root));
    expect(prompt.startsWith("# T\n")).toBe(true);
    expect(prompt).toContain(`${RIDGEWAYS.id} · Ridgeways · 2 · 2026-08 · "Ridgeways has a capability tab."`);
    expect(prompt).toContain("6 live entities");
  });
});

describe("the answer", () => {
  test("the last ```folds block is the answer; none, or not JSON, is an error", () => {
    expect(parseFolds("working…\n```folds\n[1]\n```\nmore\n```folds\n[2]\n```\n")).toEqual([2]);
    expect(() => parseFolds("no block")).toThrow("no ```folds block");
    expect(() => parseFolds("```folds\n{nope\n```")).toThrow("not JSON");
  });

  test("validation: live members only, one group per id, canonical a member, two to a group", () => {
    const root = vault(...CLAIMS);
    const census = entityCensus(root);
    const raw = [
      // canonical named outside the group → the most-cited member stands in
      // a space inside an id (seen live, 2026-09-03) is not a different id
      { members: [AUTO_MAP.id, RIDGEWAYS.id, `${RIDGE_WAYS.id.slice(0, 18)} ${RIDGE_WAYS.id.slice(18)}`, "ent_00000000000000000000"], canonical: "ent_00000000000000000000", why: "one project" },
      // Ridgeways is taken; one live member left → gone
      { members: [RIDGEWAYS.id, SITE.id], canonical: SITE.id, why: "site" },
      // a bare given name, as the model may propose it
      { members: [EVAN.id, EK.id, EK.id], canonical: EK.id, why: "same person" },
      { members: [SITE.id] },
      "not a group",
    ];
    const { groups, dropped } = validateFolds(raw, census);
    expect(groups.map((g) => g.members.map((m) => m.label))).toEqual([
      ["Ridgeways", "Auto-MAP", "Ridge Ways"],
      ["Evan", "Evan Keller"],
    ]);
    expect(groups[0]!.canonical).toBe(RIDGEWAYS.id);
    expect(groups[0]!.why).toBe("one project");
    expect(groups[1]!.canonical).toBe(EK.id);
    expect(dropped).toEqual([
      "group 1: ent_00000000000000000000 is not a live canonical entity",
      "group 1: canonical ent_00000000000000000000 is not a member — the most-cited member stands in",
      `group 2: ${RIDGEWAYS.id} "Ridgeways" already sits in an earlier group`,
      "group 2: fewer than two live members",
      "group 4: fewer than two live members",
      "group 5: not an object with a members array",
    ]);
    expect(() => validateFolds({ members: [] }, census)).toThrow("JSON array");
  });

  test("a pair the operator rejected never re-forms — the lesser-cited side leaves", () => {
    const root = vault(...CLAIMS);
    const census = entityCensus(root);
    const rejected = (a: string, b: string): boolean =>
      new Set([a, b]).size === 2 && [a, b].every((id) => id === RIDGEWAYS.id || id === AUTO_MAP.id);
    const { groups, dropped } = validateFolds(
      [{ members: [AUTO_MAP.id, RIDGEWAYS.id, RIDGE_WAYS.id], canonical: RIDGEWAYS.id, why: "" }],
      census,
      rejected
    );
    expect(groups[0]!.members.map((m) => m.label)).toEqual(["Ridgeways", "Ridge Ways"]);
    expect(dropped).toEqual([`group 1: ${AUTO_MAP.id} "Auto-MAP" was rejected against ${RIDGEWAYS.id} "Ridgeways"`]);
  });
});

describe("a proposal run", () => {
  test("census in, validated groups out, the state file written — and read back", async () => {
    const root = vault(...CLAIMS);
    const seen: { prompt?: string } = {};
    const answer = `Looked at all six.\n\`\`\`folds\n${JSON.stringify([
      { members: [AUTO_MAP.id, RIDGEWAYS.id, RIDGE_WAYS.id], canonical: RIDGEWAYS.id, why: "one project, renamed" },
    ])}\n\`\`\`\n`;
    const { folds } = await proposeEntityFolds(root, {
      target: { adapter: "pi", provider: "anthropic", model: "claude-x" }, auth: "max", loadPi: answering(answer, seen), template: "# T\n",
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });
    expect(seen.prompt).toContain(`${AUTO_MAP.id} · Auto-MAP · 1`);
    expect(folds.census).toBe(6);
    expect(folds.groups).toHaveLength(1);
    expect(folds.groups[0]!.canonical).toBe(RIDGEWAYS.id);
    expect(folds.proposedAt).toBe("2026-09-03T12:00:00.000Z");
    expect(existsSync(entityFoldsFile(root))).toBe(true);
    expect(readEntityFolds(root)).toEqual(JSON.parse(readFileSync(entityFoldsFile(root), "utf8")));
    const shown = describeFolds(folds);
    expect(shown).toContain("1. Ridgeways (2)  ← Auto-MAP (1), Ridge Ways (1)");
    expect(shown).toContain("one project, renamed");
  });

  test("no answer: an error, and no state file", async () => {
    const root = vault(...CLAIMS);
    await expect(proposeEntityFolds(root, { target: { adapter: "pi", provider: "anthropic", model: "claude-x" }, auth: "max", loadPi: answering("I looked but wrote no block."), template: "# T\n" }))
      .rejects.toThrow("no ```folds block");
    expect(existsSync(entityFoldsFile(root))).toBe(false);
    expect(readEntityFolds(root)).toBeUndefined();
  });

  test("a census with fewer than two entities never calls the model", async () => {
    const root = vault("[[Ridgeways]] alone.");
    let called = 0;
    const loadPi: PiLoader = fakePi(() => { called++; return {}; });
    const { folds, ran } = await proposeEntityFolds(root, { target: { adapter: "pi", provider: "anthropic", model: "claude-x" }, auth: "max", loadPi });
    expect(called).toBe(0);
    expect(ran).toBe(false);
    expect(folds.groups).toEqual([]);
    expect(folds.census).toBe(1);
  });
});

// ── the record's half (#728, step 3): rejects, the live view, the acts ──

import { dispatch } from "../lib/httpx";
import { createEntityFoldRejectEvent, appendEntityFoldRejectEvent, readEntityFoldRejectLog, validateEntityFoldRejectEvent } from "../lib/entityFoldLog";
import { acceptFold, changedSince, foldsRoutes, liveFolds, rejectFold, rejectedPairs } from "../lib/entityFolds";
import { readEntityAliasLog } from "../lib/entityAliasLog";
import { runMemory } from "../lib/memoryRun";
import { appendAssertionEvent } from "../lib/assertionLog";
import { gitVault, testManifest } from "./support/vault";

const USER = { kind: "user", id: "nick" } as const;
const FOLDS_ANSWER = (groups: unknown[]): string => `\`\`\`folds\n${JSON.stringify(groups)}\n\`\`\`\n`;

/** One HTTP exchange against a route table, the diagnostics suite's way. */
function call(routes: ReturnType<typeof foldsRoutes>, method: string, path: string, body?: unknown): Promise<{ code: number; body: string }> {
  return new Promise((resolve) => {
    const { PassThrough } = require("node:stream") as typeof import("node:stream");
    const req = Object.assign(new PassThrough(), { method, url: path, headers: {} });
    let code = 0;
    let out = "";
    const res = {
      writeHead: (c: number) => { code = c; },
      setHeader() {},
      write: (b: string) => { out += b; },
      end: (b?: string) => { out += b ?? ""; resolve({ code, body: out }); },
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    dispatch(routes, req as any, res as any);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

describe("the reject log", () => {
  test("a pair is one fact whichever way round; validation holds the shape", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-fold-rej-"));
    const at = stamp();
    const ab = createEntityFoldRejectEvent({ a: RIDGEWAYS, b: SITE, author: USER, created_at: at, produced_by: PRODUCED });
    const ba = createEntityFoldRejectEvent({ a: SITE, b: RIDGEWAYS, author: USER, created_at: at, produced_by: PRODUCED });
    expect(ab.id).toBe(ba.id);
    expect(ab.pair.map((e) => e.id)).toEqual([RIDGEWAYS.id, SITE.id].sort());
    expect(appendEntityFoldRejectEvent(root, ab).deduped).toBe(false);
    expect(appendEntityFoldRejectEvent(root, ba).deduped).toBe(true);
    expect(readEntityFoldRejectLog(root)).toHaveLength(1);
    expect(() => validateEntityFoldRejectEvent({ ...ab, pair: [ab.pair[1], ab.pair[0]] })).toThrow("ascending");
  });

  test("rejectedPairs resolves both sides through the alias table", () => {
    const root = vault(...CLAIMS);
    rejectFold(root, { member: SITE.id, others: [RIDGE_WAYS.id] }, USER);
    // Ridge Ways folds into Ridgeways afterwards: the refusal follows it
    acceptFold(root, { canonical: RIDGEWAYS.id, members: [RIDGE_WAYS.id] }, USER);
    const rejected = rejectedPairs(root);
    expect(rejected(SITE.id, RIDGEWAYS.id)).toBe(true);
    expect(rejected(RIDGEWAYS.id, SITE.id)).toBe(true);
    expect(rejected(SITE.id, AUTO_MAP.id)).toBe(false);
    // and the viewer reads the same pairs, resolved, with or without proposals standing
    expect(liveFolds(root).rejected).toEqual([[SITE.id, RIDGEWAYS.id].sort() as [string, string]]);
  });
});

describe("the delta shape", () => {
  test("changed rows are the question in full, the rest the bare lookup; nothing changed is no prompt", () => {
    const root = vault(...CLAIMS);
    const census = entityCensus(root);
    const cut = census.find((r) => r.id === EVAN.id)!.latest; // the last claim's created_at
    expect(changedSince(census, cut)).toEqual([]);
    expect(renderFoldsPrompt("# T\n", census, cut)).toBeNull();
    const earlier = census.find((r) => r.id === RIDGEWAYS.id)!.latest;
    const prompt = renderFoldsPrompt("# T\n", census, earlier)!;
    expect(prompt).toContain("### New or changed");
    expect(prompt).toContain(`${EVAN.id} · Evan · 1 · 2026-08 · "Evan wants the table by Tuesday."`);
    expect(prompt).toContain("### The rest");
    expect(prompt).toContain(`${RIDGEWAYS.id} · Ridgeways · 2\n`);
    expect(prompt).not.toContain(`${RIDGEWAYS.id} · Ridgeways · 2 · 2026-08`);
  });

  test("a delta run keeps the standing groups and adds the new; nothing changed keeps them without a model", async () => {
    const root = vault(...CLAIMS);
    const first = await proposeEntityFolds(root, {
      target: { adapter: "pi", provider: "anthropic", model: "claude-x" }, auth: "max", template: "# T\n",
      loadPi: answering(FOLDS_ANSWER([{ members: [AUTO_MAP.id, RIDGEWAYS.id], canonical: RIDGEWAYS.id, why: "one" }])),
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });
    expect(first.ran).toBe(true);
    expect(first.folds.groups).toHaveLength(1);
    // a delta with nothing after the cut: no model, the standing group stands
    let called = 0;
    const counting: PiLoader = fakePi(() => { called++; return {}; });
    const quiet = await proposeEntityFolds(root, { target: { adapter: "pi", provider: "anthropic", model: "claude-x" }, auth: "max", template: "# T\n", loadPi: counting, since: "2026-09-03T12:00:00.000Z" });
    expect(called).toBe(0);
    expect(quiet.ran).toBe(false);
    expect(quiet.folds.groups).toHaveLength(1);
    // a delta with a question: the answer merges — a member already
    // proposed is not re-proposed, a new pair is added
    const second = await proposeEntityFolds(root, {
      target: { adapter: "pi", provider: "anthropic", model: "claude-x" }, auth: "max", template: "# T\n",
      loadPi: answering(FOLDS_ANSWER([
        { members: [RIDGEWAYS.id, RIDGE_WAYS.id], canonical: RIDGEWAYS.id, why: "again" },
        { members: [EVAN.id, EK.id], canonical: EK.id, why: "same person" },
      ])),
      since: "2020-01-01T00:00:00.000Z",
    });
    expect(second.ran).toBe(true);
    expect(second.folds.groups.map((g) => g.members.map((m) => m.label))).toEqual([["Ridgeways", "Auto-MAP"], ["Evan", "Evan Keller"]]);
    expect(second.folds.dropped).toContain(`group 2: ${RIDGEWAYS.id} "Ridgeways" already sits in an earlier group`);
  });
});

describe("the live view and the two acts", () => {
  const seed = async (root: string): Promise<void> => {
    await proposeEntityFolds(root, {
      target: { adapter: "pi", provider: "anthropic", model: "claude-x" }, auth: "max", template: "# T\n",
      loadPi: answering(FOLDS_ANSWER([
        { members: [AUTO_MAP.id, RIDGEWAYS.id, RIDGE_WAYS.id], canonical: RIDGEWAYS.id, why: "one" },
        { members: [EVAN.id, EK.id], canonical: EK.id, why: "same" },
      ])),
    });
  };

  test("accept aliases the members into the canonical and they leave the view", async () => {
    const root = vault(...CLAIMS);
    await seed(root);
    expect(liveFolds(root).groups).toHaveLength(2);
    const r = acceptFold(root, { canonical: RIDGEWAYS.id, members: [AUTO_MAP.id, RIDGE_WAYS.id, RIDGEWAYS.id] }, USER);
    expect(r.aliased.map((e) => e.label).sort()).toEqual(["Auto-MAP", "Ridge Ways"]);
    const aliases = readEntityAliasLog(root);
    expect(aliases.map((e) => `${e.alias}→${e.entity.label}`).sort()).toEqual(["Auto-MAP→Ridgeways", "Ridge Ways→Ridgeways"]);
    expect(aliases[0]!.author).toEqual(USER);
    expect(aliases[0]!.produced_by.procedure).toBe("entity-folds-accept");
    const live = liveFolds(root);
    expect(live.groups.map((g) => g.members.map((m) => m.label))).toEqual([["Evan", "Evan Keller"]]);
    // the file is untouched — the view is the file against today
    expect(readEntityFolds(root)!.groups).toHaveLength(2);
    // search shows it knows: the label you typed, then the one that stands
    expect(searchAssertionEntities(root, "Auto-MAP").map((h) => [h.label, h.alias])).toEqual([["Ridgeways", "Auto-MAP"]]);
    expect(searchAssertionEntities(root, "Ridge Ways").map((h) => [h.label, h.alias])).toEqual([["Ridgeways", "Ridge Ways"]]);
    expect(searchAssertionEntities(root, "Ridgeways").map((h) => [h.label, h.alias])).toEqual([["Ridgeways", null]]);
    const surface = scanSurface(root, "Auto-MAP", 10, "web");
    expect(surface.ok && surface.hits[0]).toMatchObject({ title: "Ridgeways", alias: "Auto-MAP" });
    expect(() => acceptFold(root, { canonical: RIDGEWAYS.id, members: [RIDGEWAYS.id] }, USER)).toThrow("nothing to fold");
    expect(() => acceptFold(root, { canonical: "ent_00000000000000000000", members: [EVAN.id] }, USER)).toThrow("not in the record");
  });

  test("reject splits the pair in the view and the pass never re-forms it", async () => {
    const root = vault(...CLAIMS);
    await seed(root);
    rejectFold(root, { member: RIDGE_WAYS.id, others: [AUTO_MAP.id, RIDGEWAYS.id] }, USER);
    expect(readEntityFoldRejectLog(root)).toHaveLength(2);
    expect(liveFolds(root).groups[0]!.members.map((m) => m.label)).toEqual(["Ridgeways", "Auto-MAP"]);
    // the next proposal cannot bring it back
    const again = await proposeEntityFolds(root, {
      target: { adapter: "pi", provider: "anthropic", model: "claude-x" }, auth: "max", template: "# T\n",
      loadPi: answering(FOLDS_ANSWER([{ members: [AUTO_MAP.id, RIDGEWAYS.id, RIDGE_WAYS.id], canonical: RIDGEWAYS.id, why: "" }])),
    });
    expect(again.folds.groups[0]!.members.map((m) => m.label)).toEqual(["Ridgeways", "Auto-MAP"]);
    expect(again.folds.dropped[0]).toContain("was rejected against");
    // an accepted member is also gone from a rejected group
    rejectFold(root, { member: EVAN.id, others: [EK.id] }, USER);
    expect(liveFolds(root).groups).toHaveLength(1);
  });

  test("the routes: GET is the live view, POSTs are the acts, a bad body is 400", async () => {
    const root = vault(...CLAIMS);
    await seed(root);
    const routes = foldsRoutes(root, () => USER);
    const got = JSON.parse((await call(routes, "GET", "/api/entity/folds")).body) as { proposedAt: string; groups: unknown[] };
    expect(got.groups).toHaveLength(2);
    const rej = await call(routes, "POST", "/api/entity/folds/reject", { member: EVAN.id, others: [EK.id] });
    expect(rej.code).toBe(200);
    expect(JSON.parse(rej.body).member.label).toBe("Evan");
    const acc = await call(routes, "POST", "/api/entity/folds/accept", { canonical: RIDGEWAYS.id, members: [AUTO_MAP.id, RIDGE_WAYS.id] });
    expect(acc.code).toBe(200);
    expect(JSON.parse(acc.body).aliased).toHaveLength(2);
    expect(JSON.parse((await call(routes, "GET", "/api/entity/folds")).body).groups).toEqual([]);
    const bad = await call(routes, "POST", "/api/entity/folds/accept", { canonical: "nope", members: [] });
    expect(bad.code).toBe(400);
    expect(JSON.parse(bad.body).error).toContain("not an entity id");
    // no pass yet: the view says so rather than 404ing
    const empty = foldsRoutes(vault("[[Ridgeways]] alone."), () => USER);
    expect(JSON.parse((await call(empty, "GET", "/api/entity/folds")).body)).toEqual({ proposedAt: null, groups: [], rejected: [] });
  });
});

describe("on the memory clock", () => {
  /** A committed native git vault with one claim on two labels, the sweep's
   * template, and a stub that writes a cited tree for the sweep's prompt
   * and a folds block for the feeder's. */
  function clockVault(foldsText: string): { root: string; prompts: string[] } {
    const root = gitVault({
      prefix: "bb-folds-clock-",
      dirs: ["memory", "journal/memory", ".state"],
      files: { "memory/MEMORY.md": "# Memory index\n" },
      identity: { name: "t", email: "t@t" },
      commit: "seed",
    });
    const ins = insertion({ id: "ins_foldsclock00000000000000", body: "A meeting.", occurred_at: "2026-08-18T10:00:00.000Z" });
    appendSourceInsertionEvent(root, ins);
    const ev = createAssertionEvent({
      text: `[[${RIDGEWAYS.id}|Ridgeways]] and [[${AUTO_MAP.id}|Auto-MAP]] met.`, entities: [RIDGEWAYS, AUTO_MAP], sources: [ins.id],
      author: MODEL, confidence: "direct", created_at: "2026-08-20T10:00:00.000Z", produced_by: PRODUCED,
    }, new Map([[ins.id, ins]]));
    appendAssertionEvent(root, ev);
    writeMemoryStamp(root, { protocolVersion: MEMORY_PROTOCOL_VERSION }); // a current tree: no rebuild
    const prompts: string[] = [];
    const loadPi: PiLoader = fakePi((prompt) => {
      prompts.push(prompt);
      if (prompt.includes("## The census, today")) return { result: foldsText };
      require("node:fs").writeFileSync(join(root, "memory", "MEMORY.md"), `# Memory index\n\n- one fact [[${ev.id}]]\n`);
      return { result: "```report\nswept\n```\n" };
    });
    return { root, prompts, loadPi } as unknown as { root: string; prompts: string[] } & { loadPi: PiLoader };
  }

  test("after a good sweep the feeder runs once, journals under `folds`, and writes the state file", async () => {
    const v = clockVault(FOLDS_ANSWER([{ members: [AUTO_MAP.id, RIDGEWAYS.id], canonical: RIDGEWAYS.id, why: "one" }])) as ReturnType<typeof clockVault> & { loadPi: PiLoader };
    const result = await runMemory({ root: v.root, manifest: testManifest(v.root), force: true, loadPi: v.loadPi });
    expect(result.error).toBeUndefined();
    expect(result.committed).toBe(true);
    expect(v.prompts).toHaveLength(2);
    // a first pass has no `since`: the whole census, in full
    expect(v.prompts[1]).toContain("live entities, alphabetical");
    const folds = readEntityFolds(v.root)!;
    expect(folds.groups[0]!.members.map((m) => m.label)).toEqual(["Auto-MAP", "Ridgeways"]);
    const journal = JSON.parse(readFileSync(join(v.root, "journal", "memory", `${result.run}.json`), "utf8")) as { folds: { ran: boolean; groups: number; changed: number } };
    expect(journal.folds).toMatchObject({ ran: true, groups: 1, changed: 2 });
  });

  test("a feeder that fails is journaled and never fails the sweep", async () => {
    const v = clockVault("no block here") as ReturnType<typeof clockVault> & { loadPi: PiLoader };
    const result = await runMemory({ root: v.root, manifest: testManifest(v.root), force: true, loadPi: v.loadPi });
    expect(result.error).toBeUndefined();
    expect(result.committed).toBe(true);
    const journal = JSON.parse(readFileSync(join(v.root, "journal", "memory", `${result.run}.json`), "utf8")) as { folds: { error: string } };
    expect(journal.folds.error).toContain("no ```folds block");
    expect(readEntityFolds(v.root)).toBeUndefined();
  });
});
