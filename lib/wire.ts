/**
 * wire.ts — the /v1/drop and /v1/enqueue wire shapes, and the
 * frontmatter-serialization RULE every capture client hand-builds today:
 * clients/browser-extension/background.js (post()/enqueue()), bin/drop.ts
 * (its attachment envelope), web/ui/src/components/DropZone.svelte (fm()),
 * web/ui/src/lib/omnibox.ts (composeCapture). Split out of #259 by #294
 * after #293's review flagged the duplication.
 *
 * THE INVARIANT THIS MODULE SERVES: a landing's exact-dupe identity is the
 * sha256 of the payload bytes AS SENT (lib/intake.ts) — not a client id,
 * not a normalized re-encoding, the literal wire bytes. So this file
 * centralizes only the mechanical RULE (the `---` fences, the `k: v`
 * quoting via the yq idiom, order-as-given, an opt-in empty/null skip) and
 * says nothing about which fields a caller sends or in what order. Each
 * caller keeps its own field list, unnormalized — the four sites above
 * disagree with each other today (different fields, different quoting,
 * different empty-value rules) and MUST keep disagreeing after adopting
 * this helper, or their existing items stop deduping against fresh
 * resends of the same logical input. Byte-stability beats field-set
 * unification; do not "clean up" a caller's pairs here.
 *
 * clients/browser-extension/wire.js is a hand-kept plain-JS twin — clients/
 * cannot `import` lib/ (same constraint slug.js #306 already lives with).
 * This file is that twin's source of truth; test/wire.test.ts pins the two
 * in sync the same way test/slug.test.ts does for slug.js.
 */

export type FmScalar = string | number | boolean | null | undefined;

/**
 * Wrap a value to emit it VERBATIM in a frontmatter line — no yq quoting.
 * bin/drop.ts's attachment envelope has always shipped a couple of fields
 * unquoted (`kind`, `date`) alongside a quoted `title`; wrap only the
 * fields a caller already sends unquoted so its wire bytes don't shift
 * under this helper. Nothing here judges whether that mix is a good
 * spelling — it predates this module, and byte-stability outranks tidying
 * it up.
 */
export class FmRaw {
  constructor(readonly text: string) {}
}
export const fmRaw = (v: string): FmRaw => new FmRaw(v);

export type FmValue = FmScalar | FmRaw;
export type FmPair = readonly [string, FmValue];

export interface FmSerializeOpts {
  /** Drop pairs whose value is `""` or nullish before rendering.
   * DropZone.svelte's fm() has always pruned this way; leave it off (the
   * default) for callers that hand in exactly the fields they mean to
   * send, unpruned — background.js's post() and bin/drop.ts both depend
   * on getting every pair back, including ones a "helpful" empty-value
   * skip would otherwise have dropped. */
  skipEmpty?: boolean;
}

const yq = (v: FmScalar): string => JSON.stringify(String(v ?? ""));

/**
 * `---`-fenced frontmatter: order-as-given, one `k: v` line per pair,
 * trailing blank line after the closing fence — the shape every
 * /v1/drop-bound client builds by hand today. Quoting is the yq idiom
 * (`JSON.stringify(String(v))`) unless a value arrives wrapped in
 * `fmRaw()`.
 */
export function fmSerialize(pairs: readonly FmPair[], opts: FmSerializeOpts = {}): string {
  const rows = opts.skipEmpty ? pairs.filter(([, v]) => v !== "" && v != null) : pairs;
  const lines = rows.map(([k, v]) => `${k}: ${v instanceof FmRaw ? v.text : yq(v)}`);
  return ["---", ...lines, "---", ""].join("\n");
}

/**
 * `fm` + a blank line + `body` + a trailing newline — the shape a text
 * /v1/drop payload takes once its frontmatter is composed (background.js's
 * post(), bin/drop.ts, DropZone's shipPdf/shipText, omnibox's
 * composeCapture). Not every caller wants this — DropZone's shipFile ships
 * frontmatter with no body text at all — so it stays a small opt-in helper
 * rather than something fmSerialize does unconditionally.
 */
export function fmBody(fm: string, body: string): string {
  return `${fm}\n${body}\n`;
}

/** /v1/drop's JSON wire shape, used whenever binaries ride along
 * (lib/api.ts's dropHandler: `content-type: application/json`, raw
 * markdown otherwise). */
export interface DropAttachment {
  name: string;
  b64: string;
}
export function dropJsonBody(content: string, attachments: DropAttachment[]): string {
  return JSON.stringify({ content, attachments });
}

/** /v1/enqueue's JSON wire shape (lib/api.ts's enqueueHandler) — a
 * directive naming what it concerns (`refs`) and the person's or agent's
 * words (`guidance`). */
export interface EnqueueDraft {
  refs?: string[];
  guidance?: string;
}
export function enqueueBody(draft: EnqueueDraft): string {
  return JSON.stringify(draft);
}
