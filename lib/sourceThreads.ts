/** Read-side grouping only. Original insertions and their citations stay intact. */
import { sha256hex } from "./hash";
import { sourceMoment, type SourceInsertion, type SourceMetadata } from "./insertionLog";
import { supersededInsertionIds } from "./sourceSupersede";

export interface SourceThread<T extends SourceMetadata = SourceInsertion> {
  id: string;
  path: string;
  title: string;
  aliases: string[];
  /** Latest arrival first; the feed uses its time and delivery facet. */
  members: T[];
}
const pattern = /^projection\/threads\/(thread_[a-f0-9]{24})\.md$/u;
export const isSourceThreadPath = (path: string): boolean => pattern.test(path);
export const threadSubject = (title: string): string => title.trim().replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/iu, "").replace(/\s+/gu, " ").trim();
const scalar = (v: unknown): string => typeof v === "string" ? v.trim() : "";

/** Provider identity joins replies even after a subject change. A long,
 * exact subject can also join provider-split conversations in the same inbox.
 * Short generic subjects never bridge distinct provider conversations. */
function keysOf(source: SourceMetadata): string[] {
  const e = source.envelope;
  if (e.source !== "email" && e.kind !== "email") return [];
  const scope = scalar(e.inbox).toLowerCase() || scalar(e.stream).toLowerCase().replace(/^email:/u, "");
  const gmail = /^https:\/\/mail\.google\.com\/mail\/u\/\d+\/#(?:all|inbox|sent)\/([a-f0-9]+)$/iu.exec(scalar(e.url));
  const keys: string[] = [];
  if (gmail) keys.push(JSON.stringify(["email", scope, "gmail", gmail[1]!.toLowerCase()]));
  const subject = threadSubject(source.title).toLowerCase();
  const distinctive = subject.length >= 32 && subject.split(" ").length >= 4;
  if (distinctive || (!gmail && subject.length >= 12 && subject.includes(" ") && subject !== "(no subject)"))
    keys.push(JSON.stringify(["email", scope, "subject", subject]));
  return keys;
}
export const sourceTime = (s: SourceMetadata): number => Date.parse(sourceMoment(s)) || 0;

/** Includes singleton conversations so an existing thread link remains
 * readable if all but one of its messages is superseded. */
export function sourceThreads<T extends SourceMetadata>(events: readonly T[]): SourceThread<T>[] {
  const superseded = supersededInsertionIds(events);
  const parent = new Map<string, string>();
  const root = (key: string): string => {
    let top = key;
    while (parent.get(top) !== top) top = parent.get(top)!;
    while (key !== top) { const next = parent.get(key)!; parent.set(key, top); key = next; }
    return top;
  };
  const candidates = events.filter(s => !superseded.has(s.id)).map(source => ({ source, keys: keysOf(source) })).filter(s => s.keys.length);
  for (const { keys } of candidates) {
    for (const key of keys) if (!parent.has(key)) parent.set(key, key);
    for (const key of keys.slice(1)) parent.set(root(key), root(keys[0]!));
  }
  const groups = new Map<string, { members: T[]; keys: Set<string> }>();
  for (const { source, keys } of candidates) {
    const key = root(keys[0]!);
    let group = groups.get(key);
    if (!group) { group = { members: [], keys: new Set() }; groups.set(key, group); }
    group.members.push(source); for (const k of keys) group.keys.add(k);
  }
  return [...groups.values()].map(({ members, keys }) => {
    members.sort((a, b) => sourceTime(b) - sourceTime(a) || b.id.localeCompare(a.id));
    // Every identity remains an alias, so a bookmark survives later joins.
    const ordered = [...keys].sort((a, b) => Number(b.includes('"subject"')) - Number(a.includes('"subject"')) || a.localeCompare(b));
    const ids = ordered.map(key => `thread_${sha256hex(key).slice(0, 24)}`);
    const paths = ids.map(id => `projection/threads/${id}.md`);
    return { id: ids[0]!, path: paths[0]!, aliases: paths.slice(1), title: threadSubject(members[0]!.title), members };
  });
}

export function threadsByInsertion<T extends SourceMetadata>(threads: readonly SourceThread<T>[]): Map<string, SourceThread<T>> {
  const out = new Map<string, SourceThread<T>>();
  for (const thread of threads) if (thread.members.length > 1)
    for (const member of thread.members) out.set(member.id, thread);
  return out;
}
