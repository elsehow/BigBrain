/**
 * granola relabel — a one-shot pass over meetings already in the record
 * whose transcript landed without speaker names (the poll dropped them
 * until lib/granolaNote.ts carried the vendor's labels whole).
 *
 * For each granola source the LATEST insertion decides: a body that
 * already carries a named turn is done. Otherwise the note is fetched
 * again and, when the vendor attributes voices in it, re-landed through
 * the intake waist as a NEW insertion of the same source id — the lake is
 * immutable, a source-side revision is a fresh event (lib/references.ts),
 * `supersedes` names the one it revises, and the gardener files it with
 * the prior landing's assertions in view (lib/work.ts's neighborhood).
 * Notes the vendor still cannot attribute are left alone: a gardener pass
 * for a body that gained nothing but the owner's name is not worth it.
 *
 * Dry by default — prints the plan. `--apply` lands. `--since YYYY-MM-DD`
 * bounds by meeting date; `--limit N` caps landings. Each landing is one
 * intake job for the gardener's next sweep, so the count IS the cost.
 *
 * Usage: bun integrations/granola/relabel.ts [--apply] [--since <date>] [--limit N]
 * Needs GRANOLA_API_KEY in .env.
 */

import { VAULT_ROOT } from "../../lib/vaultRoot";
import { land } from "../../lib/door";
import { readEnvValues } from "../../lib/envFile";
import { flagValue, hasFlag } from "../../lib/cliflags";
import { readSourceInsertionLog, type SourceInsertion } from "../../lib/insertionLog";
import { granolaBodyHasNames, granolaItem, granolaNamedTurns, type GranolaNote } from "../../lib/granolaNote";

const GRANOLA_BASE = "https://public-api.granola.ai/v1";
const PREFIX = "granola-";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function granolaGet(path: string, key: string): Promise<GranolaNote | null> {
  const res = await fetch(`${GRANOLA_BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Granola ${path} → ${res.status} ${res.statusText}`);
  return (await res.json()) as GranolaNote;
}

/** The newest insertion per granola source id — the one whose body says
 * whether names have landed. A relabel is received now, so it wins the
 * comparison on the next run and the pass is idempotent. */
function latestPerSource(events: SourceInsertion[]): SourceInsertion[] {
  const latest = new Map<string, SourceInsertion>();
  for (const e of events) {
    if (!e.source_id.startsWith(PREFIX)) continue;
    const prev = latest.get(e.source_id);
    if (!prev || (e.received_at ?? "") > (prev.received_at ?? "")) latest.set(e.source_id, e);
  }
  return [...latest.values()].sort((a, b) => (a.occurred_at ?? "").localeCompare(b.occurred_at ?? ""));
}

async function main(): Promise<void> {
  const root = VAULT_ROOT;
  const key = readEnvValues(root)["GRANOLA_API_KEY"];
  if (!key) throw new Error("GRANOLA_API_KEY is not set — add it to .env");

  const apply = hasFlag(process.argv, "apply");
  const since = flagValue(process.argv, "since");
  const limit = hasFlag(process.argv, "limit") ? Number(flagValue(process.argv, "limit")) : Infinity;
  if (!(limit > 0)) throw new Error("--limit wants a positive number");

  const sources = latestPerSource(readSourceInsertionLog(root)).filter(
    (e) => !since || (e.occurred_at ?? "") >= since
  );
  const verb = apply ? "relabel" : "would relabel";
  let named = 0, vendorless = 0, gone = 0, landed = 0;
  for (const e of sources) {
    const stamp = `${(e.occurred_at ?? "").slice(0, 10)} ${e.title ?? e.source_id}`;
    if (granolaBodyHasNames(e.body)) {
      named++;
      continue;
    }
    if (landed >= limit) break;
    await sleep(220); // rate courtesy (~5/s limit)
    const id = e.source_id.slice(PREFIX.length);
    const note = await granolaGet(`/notes/${id}?include=transcript`, key);
    if (!note?.transcript?.length) {
      gone++;
      console.log(`skip (vendor has no transcript): ${stamp}`);
      continue;
    }
    const n = granolaNamedTurns(note.transcript);
    if (!n) {
      vendorless++;
      continue;
    }
    console.log(`${verb} (${n}/${note.transcript.length} turns named): ${stamp}`);
    landed++;
    if (!apply) continue;
    const item = granolaItem(id, note, new Date(), { supersedes: e.id });
    const receipt = await land({ root, content: item.content, source: "granola" });
    console.log(`  → ${receipt.path}${receipt.deduped ? " (deduped — already there)" : ""}`);
  }
  console.log(
    `granola relabel: ${sources.length} sources — ${named} already named, ${vendorless} the vendor cannot attribute, ` +
      `${gone} without a transcript, ${landed} ${apply ? "re-landed" : "to re-land"}` +
      (landed && !apply ? " (re-run with --apply; each is one intake job for the gardener)" : "")
  );
}

main().catch((e) => {
  console.error(`granola relabel: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
