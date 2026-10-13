/** contentHash.ts — what an arrival says, apart from how it arrived
 * (docs/plans/2026-10-11-field-of-assertions.md, step 2). A source's id
 * covers its envelope, `received:` time included, so the same note dropped
 * twice was two sources until copy detection paired them. Its content hash
 * is its body and its attachments' hashes alone: the door lands nothing for
 * an arrival whose content the record already holds (lib/references.ts),
 * and the copies chain says so of the pairs already in a vault
 * (lib/exactCopies.ts).
 *
 * A body too slight to be one work has none: two different people can each
 * send "Thanks!", and that is two arrivals, not one dropped twice.
 */
import { sha256hex } from "./hash";

/** The fewest characters of body, with no attachment, that make a work of its own. */
export const CONTENT_MIN = 280;

export function contentHash(body: string, attachments: readonly { sha256: string }[] = []): string | undefined {
  const text = body.trim();
  if (text.length < CONTENT_MIN && !attachments.length) return undefined;
  return sha256hex(JSON.stringify([text, attachments.map((a) => a.sha256).sort()]));
}
