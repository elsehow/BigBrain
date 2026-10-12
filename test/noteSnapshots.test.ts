import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { nativeVault, insertion } from "./support/vault";
import { declareOwner } from "./support/identity";
import { appendSourceInsertionEvent, insertionEventRel } from "../lib/insertionLog";
import { createDeclineEvent } from "../lib/declineLog";
import { appendAndProjectDecline, claimProjectionRecovery, projectSourceInsertion, syncAssertionProjection } from "../lib/assertionProjection";
import { withVaultSnapshot } from "../lib/vaultReadModel";
import { userIdentityDeclarations } from "../lib/userIdentity";
import { readMemoryInputs, memoryInputDelta } from "../lib/memoryInputs";
import { voiceMessagesFor } from "../lib/voice";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const source = insertion();
  const voice = insertion({ id: `ins_${"a".repeat(24)}`, source_id: "voice", body: "Keep the original words.",
    envelope: { kind: "directive", about: ` ${source.source_id} ` } });
  const root = nativeVault({ insertions: [source, voice] }); roots.push(root);
  return { root, source, voice };
}

test("voice and settlement retain one revision during a concurrent publication", () => {
  const { root, source, voice } = fixture();
  withVaultSnapshot(root, () => {
    expect(voiceMessagesFor(root, [source.source_id])[0]!.state).toBe("pending");
    appendAndProjectDecline(root, createDeclineEvent({ insertion_ids: [voice.id], reason: "Already recorded",
      author: { kind: "agent", id: "test" }, created_at: "2026-09-20T00:00:00Z",
      produced_by: { procedure: "test", version: "1" } }, new Map([[voice.id, voice]])));
    syncAssertionProjection(root);
    expect(voiceMessagesFor(root, [source.source_id])[0]!.state).toBe("pending");
  });
  expect(voiceMessagesFor(root, [source.source_id])[0]).toMatchObject({ state: "done", outcome: "declined", guidance: voice.body });
});

test("identity and memory inputs share a snapshot, including its exact checkpoint and voice", () => {
  const { root, source, voice } = fixture();
  const first = declareOwner(root, { account: "me", verified_email: "me@example.com", name: "Before", now: new Date("2026-09-19T00:00:00Z") });
  const initial = readMemoryInputs(root);
  expect(initial.inss.every(s => !("body" in s))).toBe(true);
  expect(initial.voice).toEqual([voice]);
  expect(initial.checkpoint.assertions).toEqual([first.assertion_id]);
  expect(initial.checkpoint.insertions).toContain(source.id);
  withVaultSnapshot(root, () => {
    declareOwner(root, { account: "me", verified_email: "me@example.com", name: "After", now: new Date("2026-09-20T00:00:00Z") });
    const late = { ...voice, id: `ins_${"b".repeat(24)}`, source_id: "late", received_at: "2020-01-01T00:00:00Z" };
    appendSourceInsertionEvent(root, late); projectSourceInsertion(root, late);
    expect(userIdentityDeclarations(root).at(-1)!.name).toBe("Before");
    expect(readMemoryInputs(root).checkpoint).toEqual(initial.checkpoint);
  });
  expect(userIdentityDeclarations(root).at(-1)!.name).toBe("After");
  const delta = memoryInputDelta(readMemoryInputs(root), { checkpoint: initial.checkpoint });
  expect(delta.astDelta).toHaveLength(1);
  expect(delta.voiceNotes.map(v => v.source_id)).toEqual(["late"]);
});

test("failed reconciliation retains tolerant memory inputs and the pending voice fallback", () => {
  const { root, source, voice } = fixture();
  const checkpoint = readMemoryInputs(root).checkpoint;
  mkdirSync(join(root, "log/assertions/2026-09"), { recursive: true });
  writeFileSync(join(root, "log/assertions/2026-09/ast_broken.json"), "{}");
  // A read never meets a hand-written log file; recovery does. Here the
  // viewer's background recovery failed and withdrew its claim (as
  // recoverInBackground does), so the next read recovers, fails, falls back.
  expect(() => syncAssertionProjection(root)).not.toThrow();
  const withdraw = claimProjectionRecovery(root);
  withdraw();
  expect(readMemoryInputs(root).checkpoint).toEqual(checkpoint);
  expect(voiceMessagesFor(root, [source.source_id])[0]).toMatchObject({ state: "pending", guidance: voice.body });
  // Raw fallback never revives a missing source from a stale projection.
  rmSync(join(root, insertionEventRel(voice)));
  expect(voiceMessagesFor(root, [source.source_id])).toEqual([]);
  expect(readMemoryInputs(root).checkpoint.insertions).toEqual([source.id]);
});


test("identity recovery requires sources only for a claimed declaration and validates them strictly", () => {
  const { root } = fixture();
  const broken = join(root, "log/insertions/undated/ins_broken.json");
  mkdirSync(join(root, "log/insertions/undated"), { recursive: true });
  writeFileSync(broken, "{}");
  expect(userIdentityDeclarations(root)).toEqual([]);
  rmSync(broken);
  declareOwner(root, { account: "me", verified_email: "me@example.com", name: "Owner" });
  writeFileSync(broken, "{}");
  expect(() => userIdentityDeclarations(root)).toThrow("unreadable event");
});
