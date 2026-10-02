/** Shared landing pipeline for HTTP and MCP: extract a discussable PDF,
 * apply verified provenance, then append an insertion. Each door owns its
 * authentication, transport limits, and wire response. */

import { land } from "./door";
import {
  stampIntake,
  type Attachment,
  type IntakeReceipt,
  type StampOpts,
} from "./intake";
import { discussablePdf } from "./pdfText";
import { landVoice, type VoicePrincipal } from "./voice";

export interface LandDropOpts {
  root: string;
  /** The payload as the CLIENT delivered it, pre-stamp — this is what the
   * landing dedup hashes, so byte-identical redeliveries land once. */
  content: string;
  /** Provenance from the door's VERIFIED credential. Absent inside the
   * host-account trust boundary (a direct/tunnel viewer drop), where the
   * item ships as composed — the doors' existing rule, unchanged. */
  stamp?: StampOpts;
  attachments?: Attachment[];
}

/** The receipt identifies the stored source and insertion, including on
 * a duplicate submission. No read-back from disk is needed. */
export async function landDrop(opts: LandDropOpts): Promise<IntakeReceipt> {
  // The discussable version first (design principle 3): a PDF that arrived
  // as a stub plus bytes gets its text layer here (lib/pdfText.ts), on the
  // CLIENT's payload — the stamp goes on after. `raw`, the dedup identity,
  // is this composed payload BEFORE the stamp: a retry or a double-click
  // lands once, and a re-clip after the door learned to extract lands the
  // text-bearing version as a new item — the only road a stub landed
  // earlier has to its text, the lake being append-only.
  const discussable = await discussablePdf(opts.content, opts.attachments);
  const content = opts.stamp ? stampIntake(discussable, opts.stamp) : discussable;
  return land({
    root: opts.root,
    content,
    raw: discussable,
    attachments: opts.attachments,
  });
}

/** Land a DIRECTIVE as a voice arrival (#521): the same wire draft the
 * doors always accepted — `{refs, guidance}` — now lands an immutable
 * insertion event, `refs` becoming the canonicalized `about` and
 * `guidance` the body (lib/voice.ts). Throws VoiceError on a contract
 * violation — the door turns that into its 400 exactly as it turned
 * QueueError. The returned `id` is the insertion event's (`ins_…`): the
 * handle an assertion or decline cites to settle it. */
export function landDirective(
  root: string,
  draft: { refs?: string[]; guidance?: string },
  principal: VoicePrincipal,
  opts: { idPrefix?: string } = {}
): { id: string; path: string; source_id: string; title: string } {
  return landVoice(
    root,
    {
      kind: "directive",
      ...(draft.guidance !== undefined ? { text: draft.guidance } : {}),
      ...(draft.refs?.length ? { about: draft.refs } : {}),
    },
    principal,
    opts
  );
}
