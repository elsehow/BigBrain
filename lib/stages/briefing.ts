/** briefing.ts — a note briefing as a memo stage
 * (docs/plans/2026-10-12-stages-and-views-refactor.md, R9). Its answer is
 * a memo, keyed by the stage's version, the Quick model and the content of
 * its input (the selection's items, links and evidence, and for an unread
 * briefing the day the door asked on): the same input answers from the memo
 * without a model call, whatever was selected to reach it, and its loss
 * costs only asking again. No stage reads it as input.
 *
 * A read finds the memo, or asks this stage and streams its preview; the
 * briefings chain (lib/chains.ts) asks it ahead of time for memory topics.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256hex } from "../hash";
import { loadManifest } from "../manifest";
import {
  briefingPrompt, DESCRIBED_LINKS, NOTE_BRIEFING_MODEL_OPTIONS, NOTE_BRIEFING_SYSTEM, noteBriefingPreview, noteBriefingSchema,
  parseNoteBriefing, readNoteBriefingInput, type BriefingConnection, type NoteBriefing, type NoteBriefingInput, type NoteBriefingRequest,
} from "../noteBriefing";
import { runBriefingModel, type BriefingModel } from "./quick";

/** Moves when the prompt or the answer's shape does: every memo before it is asked again. */
export const BRIEFING_VERSION = 15;

/** Where the memo for an input's key is kept. */
export const briefingMemoFile = (root: string, key: string): string => join(root, ".state", "note-briefings", `${key}.json`);

export function createNoteBriefingService(run: BriefingModel = runBriefingModel,
  read: (root: string, request: NoteBriefingRequest) => NoteBriefingInput | Promise<NoteBriefingInput> = readNoteBriefingInput) {
  const pending = new Map<string, { promise: Promise<NoteBriefing>; preview: string; listeners: Set<(text: string) => void> }>();
  return async (root: string, request: NoteBriefingRequest, onPreview: (text: string) => void = () => {}, signal?: AbortSignal): Promise<NoteBriefing> => {
    const full = await read(root, request);
    const purpose = typeof request === "string" ? undefined : request.purpose;
    const today = purpose === "unread" && typeof request !== "string" ? request.today : undefined;
    const quick = loadManifest(root).quick;
    // Include the whole connection/evidence set, even passages shortened for
    // the prompt: additions, removals and corrections invalidate this view.
    const key = sha256hex(JSON.stringify([BRIEFING_VERSION, DESCRIBED_LINKS, quick.adapter, quick.provider, quick.model, quick.reasoning, purpose, today, full]));
    const file = briefingMemoFile(root, key);
    try {
      const cached = JSON.parse(readFileSync(file, "utf8"));
      if (cached.key === key && typeof cached.summary === "string" && Array.isArray(cached.links)) {
        // Earlier cache entries stored model order. Reuse their prose while
        // restoring the same deterministic order as a fresh response.
        const order = new Map(full.links.map((link, i) => [link.id, i]));
        cached.links.sort((a: BriefingConnection, b: BriefingConnection) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
        return cached;
      }
    } catch { /* rebuild missing/damaged derived output */ }
    const jobKey = `${root}:${key}`;
    let job = pending.get(jobKey);
    if (!job) {
      // Navigation leaves earlier generations running to fill the cache. Only
      // deduplicate identical work; those jobs must not block a new selection.
      const { input, prompt } = briefingPrompt(full);
      job = { promise: Promise.resolve(null as never), preview: "", listeners: new Set() };
      const active = job;
      job.promise = (async () => {
        const result = await run(root, prompt, text => {
          const preview = noteBriefingPreview(text);
          if (preview === undefined || preview === active.preview) return;
          active.preview = preview;
          for (const listener of active.listeners) listener(preview);
        }, NOTE_BRIEFING_SYSTEM + (purpose === "unread" ? `\nToday is ${today}. This selection was explicitly opened as unread sources. In the summary, prioritize concrete requests, decisions and dated deadlines that may need the user, then group informational/background items. Distinguish explicit asks from inferred follow-up; unread alone never implies a reply is owed. Do not claim a historical deadline is upcoming. Mention limited evidence when excerpts cannot establish what needs action. Reading these sources does not change their read state.` : ""), { ...NOTE_BRIEFING_MODEL_OPTIONS, outputSchema: noteBriefingSchema(input) });
        const described = parseNoteBriefing(result.text, input);
        const briefing: NoteBriefing = { key, model: result.model, generatedAt: new Date().toISOString(),
          summary: described.summary,
          links: [...described.links, ...full.links.slice(DESCRIBED_LINKS).map(link => ({ ...link, evidence: [] }))], ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}) };
        mkdirSync(join(root, ".state", "note-briefings"), { recursive: true });
        const temp = `${file}.${crypto.randomUUID()}.tmp`;
        try { writeFileSync(temp, JSON.stringify(briefing)); renameSync(temp, file); }
        finally { rmSync(temp, { force: true }); }
        return briefing;
      })().finally(() => pending.delete(jobKey));
      pending.set(jobKey, job);
    }
    const unsubscribe = () => job!.listeners.delete(onPreview);
    if (!signal?.aborted) {
      job.listeners.add(onPreview);
      if (job.preview) onPreview(job.preview);
      signal?.addEventListener("abort", unsubscribe, { once: true });
    }
    try { return await job.promise; }
    finally { unsubscribe(); signal?.removeEventListener("abort", unsubscribe); }
  };
}

