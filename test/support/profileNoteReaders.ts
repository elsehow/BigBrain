/** Synthetic, isolated comparison: bun test/support/profileNoteReaders.ts <checkout> <operation> <output.json> */
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
const engine = resolve(process.argv[2]!), operation = process.argv[3]!;
const mod = (file: string) => import(join(engine, "lib", `${file}.ts`));
const { insertion } = await import(join(engine, "test/support/vault.ts"));
const { appendSourceInsertionEvent } = await mod("insertionLog");
const { createAssertionEvent, appendAssertionEvent, assertionEntityId } = await mod("assertionLog");
const { appendDeclineEvent, createDeclineEvent } = await mod("declineLog");
const { syncAssertionProjection } = await mod("assertionProjection");
const { sourceThreads } = await mod("sourceThreads");
const { sourceThreadView } = await mod("assertionEntityView");
const { notePayload } = await mod("noteRead");
const { createSourceReadStateService } = await mod("sourceReadState");
const { readMemoryInputs } = await mod("memoryInputs");
const { voiceMessagesFor } = await mod("voice");
const { userIdentityDeclarations } = await mod("userIdentity");
const root = mkdtempSync(join(tmpdir(), "bb-note-readers-profile-"));
process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state/assertions.db");
try {
  const sources = Array.from({ length: 1200 }, (_, n) => insertion({ id: `ins_${n.toString(16).padStart(24, "0")}`,
    source_id: `source-${n}`, title: `Project ${Math.floor(n / 4)} quarterly planning conversation`,
    body: `Evidence for item ${n}. ` + "Substantial email transcript. ".repeat(1100),
    received_at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    envelope: { source: "email", kind: "email", inbox: "fixture@example.com", message_id: `<${n}@example.com>` },
  }));
  for (const source of sources) appendSourceInsertionEvent(root, source);
  const byId = new Map(sources.map(s => [s.id, s]));
  const entity = { id: assertionEntityId("Project"), label: "Project" };
  for (let n = 0; n < sources.length; n++) appendAssertionEvent(root, createAssertionEvent({
    text: `[[${entity.id}|Project]] has finding ${n}.`, entities: [entity], sources: [sources[n].id],
    author: { kind: "agent", id: "fixture" }, confidence: "direct", created_at: sources[n].received_at,
    produced_by: { procedure: "fixture", version: "1" },
  }, byId));
  const identity = insertion({ id: `ins_${"f".repeat(23)}0`, source_id: "identity-fixture", title: "About Fixture Owner",
    author: { kind: "user", id: "fixture@example.com" }, body: "Fixture Owner owns this vault.",
    received_at: "2026-01-02T00:00:00.000Z", envelope: { kind: "identity-declaration", source: "user-bootstrap",
      identity_name: "Fixture Owner", identity_aliases: ["fixture@example.com"] } });
  appendSourceInsertionEvent(root, identity); byId.set(identity.id, identity);
  const owner = { id: assertionEntityId("Fixture Owner"), label: "Fixture Owner" };
  appendAssertionEvent(root, createAssertionEvent({ text: `[[${owner.id}|Fixture Owner]] owns this vault.`,
    entities: [owner], sources: [identity.id], author: identity.author, confidence: "direct",
    created_at: identity.received_at, produced_by: { procedure: "user-identity-bootstrap", version: "1" } }, byId));
  const voices = ["directive", "request", "observation"].map((kind, n) => insertion({
    id: `ins_${"f".repeat(23)}${n+1}`, source_id: `voice-${n}`, title: `Voice ${n}`, body: `Please remember finding ${n}.`,
    author: { kind: "user", id: "fixture@example.com" }, received_at: `2026-01-02T00:00:0${n+1}.000Z`,
    envelope: { kind, about: n === 0 ? " source-0 " : [n === 1 ? "source-0" : "source-1"], from_kind: "person" },
  }));
  for (const voice of voices) { appendSourceInsertionEvent(root, voice); byId.set(voice.id, voice); }
  appendDeclineEvent(root, createDeclineEvent({ insertion_ids: [voices[1].id], reason: "Already recorded",
    author: { kind: "agent", id: "fixture" }, created_at: "2026-01-03T00:00:00.000Z",
    produced_by: { procedure: "fixture", version: "1" } }, byId));
  const syncStart = performance.now(); syncAssertionProjection(root); const projectionMs = performance.now() - syncStart;
  const thread = sourceThreads(sources.slice(0, 4))[0]!;
  const service = createSourceReadStateService([]);
  const read: Record<string, () => unknown> = {
    thread: () => sourceThreadView(root, thread.path),
    note: () => notePayload(root, thread.path),
    readState: () => service.peek(root),
    memory: () => {
      const input = readMemoryInputs(root);
      // Compare observable memory inputs, including every voice body, across
      // the old full-source and new metadata-only internal representations.
      return { ...input, inss: input.inss.map((s: any) => ({ ...s, body: undefined })),
        superseded: [...input.superseded].sort(), voice: input.voice ?? input.inss.filter((s: any) => ["directive", "request", "observation"].includes(s.envelope.kind)) };
    },
    voice: () => voiceMessagesFor(root, ["source-0"]),
    identity: () => userIdentityDeclarations(root),
  };
  if (!read[operation]) throw new Error(`Unknown operation: ${operation}`);
  const bytes = { totalBodies: sources.reduce((n, s) => n + s.body.length, 0), threadBodies: sources.slice(0, 4).reduce((n, s) => n + s.body.length, 0) };
  // Retain neither fixture objects nor prior outputs during timed reads.
  sources.length = 0; byId.clear(); thread.members.length = 0; Bun.gc(true);
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
  const decodeOnly = process.argv[5] === "decode";
  const decoded = { calls: 0, jsonBytes: 0, sourceBodyBytes: 0, sourceBodies: 0 };
  const parse = JSON.parse;
  if (decodeOnly) JSON.parse = (text, reviver) => {
    const value = parse(text, reviver);
    decoded.calls++; decoded.jsonBytes += Buffer.byteLength(text);
    if (value?.event === "source.inserted" && typeof value.body === "string") {
      decoded.sourceBodies++; decoded.sourceBodyBytes += Buffer.byteLength(value.body);
    }
    return value;
  };
  const before = process.memoryUsage(), samples: number[] = [], digests: string[] = [];
  for (let n = 0; n < (decodeOnly ? 1 : 6); n++) {
    const start = performance.now(), result = read[operation]!(); samples.push(performance.now() - start);
    digests.push(createHash("sha256").update(JSON.stringify(canonical(result))).digest("hex"));
  }
  JSON.parse = parse;
  Bun.gc(true);
  const result = { operation, sources: 1204, assertions: 1201, threads: 300, bun: Bun.version,
    ...(decodeOnly ? { decoded } : {}), projectionMs, databaseBytes: statSync(process.env["BIGBRAIN_ASSERTION_DB"]!).size, samplesMs: samples, firstMs: samples[0], warmMedianMs: samples.slice(1).sort((a,b) => a-b)[2],
    digests: [...new Set(digests)], bytes, before, after: process.memoryUsage() };
  writeFileSync(process.argv[4]!, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ operation, firstMs: result.firstMs, warmMs: result.warmMedianMs }));
} finally { rmSync(root, { recursive: true, force: true }); }
