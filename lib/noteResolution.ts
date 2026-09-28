/** Resolve note identity and content once; callers own access and presentation. */
import { readFileSync, statSync } from "node:fs";
import { relative, sep } from "node:path";
import { assertionEntityPath, assertionEntityView, isAssertionEntityPath, sourceThreadView } from "./assertionEntityView";
import { isSourceThreadPath } from "./sourceThreads";
import { insertionEventRel, type SourceInsertion } from "./insertionLog";
import { isSourceInsertionPath, readSourceInsertionPath } from "./sourceFeed";
import { readWorkSession } from "./workSessionRead";
import { noteText } from "./vaultRead";

export interface MarkdownContent { path: string; raw: string; mtime?: string; file?: string }
interface Identity { id: string; path: string; title: string }
export type ResolvedNote = Identity & (
  | { kind: "source"; source: SourceInsertion }
  | { kind: "entity"; entity: NonNullable<ReturnType<typeof assertionEntityView>> }
  | { kind: "thread"; thread: NonNullable<ReturnType<typeof sourceThreadView>> }
  | { kind: "session"; session: NonNullable<ReturnType<typeof readWorkSession>> }
  | { kind: "markdown"; markdown: MarkdownContent & ReturnType<typeof noteText> }
);
export interface NoteReadPolicy {
  /** The caller authorizes Markdown before supplying its content. */
  markdown(path: string): MarkdownContent | undefined;
  sessions?: boolean;
  /** Exact file reads by default; briefing callers borrow projected evidence. */
  source?: typeof readSourceInsertionPath;
}

/** `file` must already have passed the caller's path jail. */
export function readNoteFile(root: string, file: string): MarkdownContent | undefined {
  try {
    return { path: relative(root, file).split(sep).join("/"), file,
      raw: readFileSync(file, "utf8"), mtime: statSync(file).mtime.toISOString() };
  } catch { return; }
}

export function resolveNote(root: string, path: string, policy: NoteReadPolicy): ResolvedNote | undefined {
  if (policy.sessions && path.startsWith("sessions/")) {
    const session = readWorkSession(root, path);
    return session ? { kind: "session", id: path, path, title: session.title, session } : undefined;
  }
  if (isSourceThreadPath(path)) {
    const thread = sourceThreadView(root, path);
    return thread ? { kind: "thread", id: thread.id, path: thread.path, title: thread.title, thread } : undefined;
  }
  if (isAssertionEntityPath(path)) {
    const entity = assertionEntityView(root, path);
    return entity ? { kind: "entity", id: entity.id, path: assertionEntityPath(entity.id), title: entity.label, entity } : undefined;
  }
  if (isSourceInsertionPath(path)) {
    const source = (policy.source ?? readSourceInsertionPath)(root, path);
    return source ? { kind: "source", id: `source:${source.id}`, path: insertionEventRel(source), title: source.title, source } : undefined;
  }
  const content = policy.markdown(path);
  if (!content) return;
  const markdown = { ...content, ...noteText(content.path, content.raw) };
  return { kind: "markdown", id: content.path, path: content.path, title: markdown.title, markdown };
}
