/** notesDoor.ts — the door for notes edited outside the engine
 * (docs/plans/2026-10-12-stages-and-views-refactor.md, R11). A person edits
 * `memory/` or `entities/` in their editor; nothing in the engine wrote it,
 * so nothing projected it. The watcher names each changed note here, and a
 * flush projects them (lib/assertionProjection.ts projectNotes): every note
 * when the watcher was lost and may have missed some. A flush commits, and
 * the commit is heard like any other: the stream that pushes stamps
 * (lib/liveEvents.ts) never projects anything itself. */
import { projectNotes } from "./assertionProjection";

export interface NotesDoor {
  /** A note changed at this vault-relative path. */
  noted(rel: string): void;
  /** The watcher may have missed changes: the next flush projects every note. */
  lost(): void;
  /** Whether a flush has anything to project. */
  pending(): boolean;
  /** Project what changed since the last flush. Never throws: what it could
   * not project, the next edit or the next process to start projects. */
  flush(): void;
}

export function createNotesDoor(root: string, refresh: (root: string, paths?: string[]) => void = projectNotes): NotesDoor {
  const paths = new Set<string>();
  let everything = false;
  return {
    noted: (rel) => { paths.add(rel); },
    lost: () => { everything = true; },
    pending: () => everything || paths.size > 0,
    flush() {
      if (!everything && !paths.size) return;
      const named = everything ? undefined : [...paths];
      everything = false;
      paths.clear();
      try { refresh(root, named); } catch { /* projected later */ }
    },
  };
}
