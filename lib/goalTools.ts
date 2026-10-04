/** The goal picture agent's tools (#51) — read-only, over the goal chain's own
 * log and the sources it cites. Nothing here reads the classic chain's
 * assertions, memory or graph, and nothing writes.
 *
 * `relevance` never leaves this module: it was written against an earlier
 * picture, so handing it to the picture agent would feed the picture back to
 * itself. Sources are served in their owner-only view (`intakeBody`) — never
 * through `read_note`, which on a transcript returns assistant turns too.
 */

import type { RunTool } from "./run/machineTools";
import { readGoalLog } from "./goalLog";
import { readSourceInsertionLog, type SourceInsertion } from "./insertionLog";
import { norm } from "./ids";
import { intakeBody } from "./work";

const schema = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", properties, required, additionalProperties: false });

const envStr = (s: SourceInsertion, k: string): string | null =>
  typeof s.envelope?.[k] === "string" ? (s.envelope[k] as string) : null;

/** What a goal row says about where it came from. */
function provenance(s: SourceInsertion | undefined) {
  return {
    date: (s?.occurred_at ?? s?.received_at ?? "").slice(0, 10),
    via: s ? envStr(s, "source") : null,
    from: s ? envStr(s, "from") : null,
    from_kind: s ? envStr(s, "from_kind") : null,
    title: s?.title ?? null,
  };
}

export function goalTools(root: string): RunTool[] {
  const sources = () => new Map(readSourceInsertionLog(root).map((s) => [s.id, s]));
  return [
    {
      name: "search_goals",
      description: "Search the goal log: every assertion gardened from a source about the owner's goals. All query terms must appear. Newest first. Each row names its source (insertion_id) with date, integration (via), sender (from) and the sender's grade (from_kind: person, agent or service).",
      inputSchema: schema({
        query: { type: "string" },
        type: { type: "string", enum: ["about_goals", "action_space"] },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      }),
      call: (a) => {
        const terms = typeof a.query === "string" ? norm(a.query).split(" ").filter(Boolean) : [];
        const limit = Math.max(1, Math.min(200, Number(a.limit) || 40));
        const byId = sources();
        const rows = readGoalLog(root).flatMap((e) => e.assertions
          .filter((x) => (!a.type || x.type === a.type) && terms.every((t) => norm(x.assertion).includes(t)))
          .map((x) => ({ event: e.id, insertion_id: e.insertion_id, ...provenance(byId.get(e.insertion_id)), type: x.type, assertion: x.assertion })))
          .sort((x, y) => y.date.localeCompare(x.date));
        return { rows: rows.slice(0, limit), truncated: rows.length > limit, limit };
      },
    },
    {
      name: "read_source",
      description: "Read a source by insertion_id, in the view the gardener read: a conversation shows only the owner's turns. Returns a bounded character window.",
      inputSchema: schema({
        insertion_id: { type: "string" },
        start: { type: "integer", minimum: 0 },
        chars: { type: "integer", minimum: 1, maximum: 40_000 },
      }, ["insertion_id"]),
      call: (a) => {
        const s = sources().get(String(a.insertion_id));
        if (!s) throw new Error(`no source ${String(a.insertion_id)}`);
        const body = intakeBody(s);
        const start = Math.max(0, Number(a.start) || 0);
        const chars = Math.max(1, Math.min(40_000, Number(a.chars) || 12_000));
        return { insertion_id: s.id, ...provenance(s), text: body.slice(start, start + chars), length: body.length, start, truncated: start + chars < body.length };
      },
    },
  ];
}
