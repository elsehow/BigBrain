/** Whether an entity's label names a source: the same document, written
 * about as its own subject (lib/entitySourceLog.ts).
 *
 * Words, not characters: both sides fold to lowercase letter-and-digit
 * words, so punctuation, case and accents never decide. A source answers to
 * its title (with a trailing file extension, citation parenthetical or
 * "| Publisher" tail dropped) and to the head of its body, where a paper
 * prints its title. Conservative on purpose — a wrong binding sends a click
 * to the wrong place:
 *
 *  - Talk is never a work: a meeting, a mail thread, a session, a request
 *    is about things, never the thing (a call titled "Dana building
 *    manager" is a call with Dana). Nor is an encyclopedia page: it
 *    describes a subject.
 *  - `title`: the label is the title — three words or more for a work (a
 *    clipped page, a PDF, an article), five for anything else, so a note
 *    filed as one ("an agent's note on the repo") needs a paper-length
 *    name; or one is the other with a subtitle dropped, five words or more
 *    and most of the longer. "Lanternworks" never binds to a page titled
 *    "Lanternworks": a short name is a thing with a site, not a document.
 *  - `head`: the body opens with the label, five words or more.
 *  - `near`: the label (five words or more) appears inside the title or
 *    the head without being either — "Notes on <a paper>" is about the
 *    paper, not it. Reported for a person to settle, never bound.
 */

import { norm } from "./ids";

export type SourceMatch = "title" | "head" | "near";

const EXTENSION = /\.(pdf|docx?|md|markdown|txt|html?|epub|rtf)$/iu;

/** Envelope kinds that are a work in their own right. */
const WORK_KINDS = new Set([
  "web-clip", "pdf-import", "pdf", "file-import", "text-import", "paper", "working-paper",
  "article", "post", "review", "legal-document", "podcast", "dataset",
]);
/** Envelope kinds that are talk: about things, never one. */
export const TALK_KINDS: ReadonlySet<string> = new Set([
  "meeting", "transcript", "meeting-dossier", "email", "message", "agent-chat", "pilot-chat",
  "request", "directive", "observation", "identity-declaration",
]);
const ENCYCLOPEDIA = /\s[-|—–]\s*wikipedia\s*$/iu;

/** A string's words: lowercased, accents off, split on anything that is
 * not a letter or digit. */
export function matchWords(value: string): string[] {
  return norm(value).normalize("NFKD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** The forms a source's title is written in: as given, without a trailing
 * extension or parenthetical, and without a "| Publisher" or " - Site" tail. */
export function titleForms(title: string): string[][] {
  const forms = new Set<string>();
  let base = title.trim().replace(EXTENSION, "");
  forms.add(base);
  base = base.replace(/\s*[([][^()[\]]*[)\]]\s*$/u, "");
  forms.add(base);
  for (const sep of [" | ", " — ", " – ", " - "]) {
    const at = base.lastIndexOf(sep);
    if (at > 0) forms.add(base.slice(0, at));
  }
  return [...forms].map(matchWords).filter((words) => words.length);
}

const startsWith = (long: readonly string[], short: readonly string[]): boolean =>
  short.length <= long.length && short.every((word, i) => long[i] === word);

const contains = (long: readonly string[], short: readonly string[]): boolean => {
  for (let i = 0; i + short.length <= long.length; i++)
    if (short.every((word, j) => long[i + j] === word)) return true;
  return false;
};

/** How `label` names a source with this title, body head and envelope
 * kind (as the envelope holds it: anything but a string is no kind), if it
 * does. */
export function sourceMatch(label: string, source: { title: string; head?: string; kind?: unknown }): SourceMatch | undefined {
  const kind = typeof source.kind === "string" ? source.kind.trim().toLowerCase() : "";
  if (TALK_KINDS.has(kind) || ENCYCLOPEDIA.test(source.title)) return undefined;
  const words = matchWords(label);
  if (words.length < (WORK_KINDS.has(kind) ? 3 : 5)) return undefined;
  const titles = titleForms(source.title);
  for (const title of titles) {
    if (title.length === words.length && startsWith(title, words)) return "title";
    const [short, long] = title.length < words.length ? [title, words] : [words, title];
    if (short.length >= 5 && short.length >= 0.6 * long.length && startsWith(long, short)) return "title";
  }
  if (words.length < 5) return undefined;
  const head = matchWords(source.head ?? "");
  if (startsWith(head, words)) return "head";
  if (titles.some((title) => contains(title, words)) || contains(head, words)) return "near";
  return undefined;
}
