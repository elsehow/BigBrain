import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireAssertionLock,
  assertionLockDir,
  canonicalizeAssertionLinks,
  ownerLabelsFor,
  releaseAssertionLock,
} from "../lib/assertionAgent";
import { assertionEntityId, createAssertionEvent } from "../lib/assertionLog";
import { declareUserIdentity } from "../lib/userIdentity";
import {
  appendAndProjectAssertion,
  projectSourceInsertion,
} from "../lib/assertionProjection";
import { appendSourceInsertionEvent, type SourceInsertion } from "../lib/insertionLog";
import { insertion } from "./support/vault";

const seed = (root: string, item: SourceInsertion): void => {
  appendSourceInsertionEvent(root, item);
  projectSourceInsertion(root, item);
};

describe("assertion intake agent", () => {
  test("canonicalizes new links and permits only known explicit entity ids", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-assert-links-"));
    const first = insertion({ id: "ins_first", body: "Ada discussed sparse probes.", occurred_at: "2026-08-18T10:00:00.000Z" });
    seed(root, first);
    const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
    appendAndProjectAssertion(root, createAssertionEvent({
      text: `[[${ada.id}|Ada]] discussed sparse probes.`, entities: [ada],
      citations: [{ insertion_id: first.id, quotes: [first.body] }],
      author: { kind: "user", id: "nick" }, confidence: "direct",
      created_at: "2026-08-18T10:10:00.000Z",
      produced_by: { procedure: "test", version: "v1" },
    }, new Map([[first.id, first]])));
    expect(canonicalizeAssertionLinks(root, `[[${ada.id}|Ada]] joined [[Atlas project]].`)).toEqual({
      text: `[[${ada.id}|Ada]] joined [[${assertionEntityId("Atlas project")}|Atlas project]].`,
      entities: [ada, { id: assertionEntityId("Atlas project"), label: "Atlas project" }],
    });
    expect(() => canonicalizeAssertionLinks(root, "[[ent_00000000000000000000|Ghost]] appeared."))
      .toThrow("unknown projected entity");
  });

});

describe("the scheduled intake pass's helpers (#475)", () => {
  test("ownerLabelsFor reads the identity declaration plus the hosted owner email, deduplicated — never a dossier (#683)", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-owner-"));
    mkdirSync(join(root, "entities"), { recursive: true });
    // the retired editor's flag is inert: only the declaration says who
    writeFileSync(
      join(root, "entities", "other.md"),
      "---\ntitle: Someone Else\nhuman_user: true\naliases:\n  - Other\n---\nbody\n"
    );
    expect(ownerLabelsFor(root, {})).toEqual([]);
    declareUserIdentity(root, { name: "Dana Example", email: "dana@example.com", aliases: ["Dana"] });
    expect(ownerLabelsFor(root, {})).toEqual(["Dana Example", "dana@example.com", "Dana"]);
    expect(ownerLabelsFor(root, { BIGBRAIN_OWNER_EMAIL: " dana@example.com " })).toEqual([
      "Dana Example", "dana@example.com", "Dana",
    ]);
    expect(ownerLabelsFor(root, { BIGBRAIN_OWNER_EMAIL: "z@host" })).toContain("z@host");
    // no declaration, no env ⇒ no labels, no throw (the prompt simply omits the line)
    expect(ownerLabelsFor(mkdtempSync(join(tmpdir(), "bb-owner-")), {})).toEqual([]);
  });

  test("a vault made after the hosted era has only the declaration (#572)", () => {
    // Nothing writes a `human_user` dossier any more, so without this the
    // gardener is told "No vault-owner identity labels were supplied" forever.
    const root = mkdtempSync(join(tmpdir(), "bb-owner-declared-"));
    declareUserIdentity(root, { name: "Ada Lovelace", email: "ada@example.com", aliases: ["Ada"] });
    expect(ownerLabelsFor(root, {})).toEqual(["Ada Lovelace", "ada@example.com", "Ada"]);
  });

  test("the intake lock is held by a live pid, refused to a second taker, and reclaimed when stale", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-lock-"));
    expect(acquireAssertionLock(root)).toBe(true);
    expect(acquireAssertionLock(root)).toBe(false); // we hold it, alive
    releaseAssertionLock(root);
    expect(existsSync(assertionLockDir(root))).toBe(false);
    // a dead holder's lock is reclaimed on the next acquire
    mkdirSync(assertionLockDir(root), { recursive: true });
    writeFileSync(join(assertionLockDir(root), "pid"), "999999999\n");
    expect(acquireAssertionLock(root)).toBe(true);
    releaseAssertionLock(root);
  });
});
