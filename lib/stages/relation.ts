/** relation.ts — a hovered note's gloss as a memo stage
 * (docs/plans/2026-10-12-stages-and-views-refactor.md, R9): keyed by the
 * prompt, the Quick model and the content of its input, which is the record
 * alone (the claims and links naming both notes), never a briefing's memo. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../fsx";
import { sha256hex } from "../hash";
import { loadManifest } from "../manifest";
import {
  NOTE_RELATION_MODEL_OPTIONS, NOTE_RELATION_SCHEMA, NOTE_RELATION_SYSTEM, noteRelationPrompt, parseNoteRelation, readNoteRelationInput,
  type NoteRelation, type NoteRelationInput,
} from "../noteRelation";
import { runBriefingModel, type BriefingModel } from "./quick";

export function createNoteRelationService(run: BriefingModel = runBriefingModel,
  read: (root: string, focus: string, hovered: string) => NoteRelationInput | Promise<NoteRelationInput> = readNoteRelationInput) {
  const pending = new Map<string, { promise: Promise<NoteRelation>; controller: AbortController; readers: Set<object> }>();
  return async function generate(root: string, focus: string, hovered: string, signal?: AbortSignal): Promise<NoteRelation> {
    signal?.throwIfAborted();
    const input = await read(root, focus, hovered);
    signal?.throwIfAborted();
    const quick = loadManifest(root).quick;
    const key = sha256hex(JSON.stringify([NOTE_RELATION_SYSTEM, quick.adapter, quick.provider, quick.model, quick.reasoning, input]));
    const file = join(root, ".state", "note-relations", `${key}.json`);
    try {
      const cached = JSON.parse(readFileSync(file, "utf8")) as NoteRelation;
      if (cached.key === key && typeof cached.text === "string") return cached;
    } catch { /* rebuild missing/damaged derived output */ }
    const jobKey = `${root}:${key}`;
    let job = pending.get(jobKey);
    if (!job) {
      job = { promise: Promise.resolve(null as never), controller: new AbortController(), readers: new Set() };
      const active = job;
      job.promise = (async () => {
        const result = await run(root, noteRelationPrompt(input), () => {}, NOTE_RELATION_SYSTEM,
          { ...NOTE_RELATION_MODEL_OPTIONS, outputSchema: NOTE_RELATION_SCHEMA, queueSignal: active.controller.signal });
        const relation: NoteRelation = { key, model: result.model, generatedAt: new Date().toISOString(),
          text: parseNoteRelation(result.text), ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}) };
        writeAtomic(file, JSON.stringify(relation));
        return relation;
      })().finally(() => pending.delete(jobKey));
      pending.set(jobKey, job);
    }
    const reader = {};
    job.readers.add(reader);
    const leave = () => { job!.readers.delete(reader); if (!job!.readers.size) job!.controller.abort(); };
    signal?.addEventListener("abort", leave, { once: true });
    try { return await job.promise; }
    catch (error) {
      if (!signal?.aborted && error === job.controller.signal.reason) return generate(root, focus, hovered, signal);
      throw error;
    } finally { leave(); signal?.removeEventListener("abort", leave); }
  };
}

