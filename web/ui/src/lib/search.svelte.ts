import { api } from "./api";
import { app } from "./store.svelte";
import type { NoteMeta } from "./types";

// The everywhere-search's backing index: one flat list of every note across
// collections, built lazily the first time search or a wikilink needs it and
// rebuilt after every live change ping (rev bump).

export interface Col {
  label: string;
  dir: string;
  count: number;
  group: string;
}

/** Every collection in the vault — entities and references first (the
 * trees wikilinks resolve against), then the non-empty queues. */
export function collections(): Col[] {
  const v = app.vault;
  if (!v) return [];
  const view = v.view ?? { references: 0, entities: 0 };
  return [
    ...(view.entities > 0
      ? [{ label: "entities", dir: "entities", count: view.entities, group: "view" }]
      : []),
    ...(view.references > 0
      ? [{ label: "references", dir: "references", count: view.references, group: "view" }]
      : []),
    ...(v.inbox.unsorted > 0
      ? [{ label: "unsorted", dir: "inbox/unsorted", count: v.inbox.unsorted, group: "queues" }]
      : []),
    ...(v.requests.open > 0
      ? [{ label: "requests", dir: "requests", count: v.requests.open, group: "queues" }]
      : []),
  ];
}

export const index = $state({
  all: null as { dir: string; note: NoteMeta }[] | null,
  building: false,
});
let builtRev = -1;

export async function ensureAllNotes(): Promise<{ dir: string; note: NoteMeta }[]> {
  if (index.all && builtRev === app.rev) return index.all;
  builtRev = app.rev;
  index.building = true;
  try {
    const per = await Promise.all(
      collections().map((c) =>
        api.notes(c.dir).then((r) => r.notes.map((note) => ({ dir: c.dir, note })))
      )
    );
    index.all = per.flat();
  } catch {
    index.all = [];
  }
  index.building = false;
  return index.all;
}
