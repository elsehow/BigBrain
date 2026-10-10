// origin.ts — OPEN on a source: the origin the engine read off its envelope
// (lib/sourceOrigin.ts, shipped as the note payload's `origin`), and which
// opener takes it. A page goes the way every outbound link goes (the
// shell's opener plugin, a new tab in a browser — native.ts's openExternal);
// a file goes to the engine's door, which lays the original out under its
// own name and hands it to the OS. Pure but for `deps`, so the test pins
// the switch without a window.

import type { SourceOrigin } from "./types";

export interface OriginOpeners {
  /** native.ts's openExternal */
  external: (url: string) => void;
  /** api.ts's openSource: a file by its sha256, else the source's own origin */
  engine: (path: string, sha256?: string) => Promise<unknown>;
}

/** The chip's title: what will open, so the hover says where ⌘O goes. */
export function originHint(origin: SourceOrigin): string {
  if (origin.kind === "url") return `Open the page this came from in your browser:\n${origin.url}`;
  if (origin.kind === "note") return `Open this note (${origin.name}) in the app your system uses for Markdown`;
  return `Open the original (${origin.name}) in the app your system uses for it`;
}

/** A short name for one of several originals: the page's site, or the file's name. */
export function originLabel(origin: SourceOrigin): string {
  if (origin.kind !== "url") return origin.name;
  try { return new URL(origin.url).hostname.replace(/^www\./, ""); } catch { return origin.url; }
}

/** Where the chip goes when clicked — a URL out of the app, a file through
 * the engine's door. Resolves when the act has been handed off; rejects
 * with the engine's own words when the door refused. */
export function openOrigin(origin: SourceOrigin, path: string, deps: OriginOpeners): Promise<void> {
  if (origin.kind === "url") {
    deps.external(origin.url);
    return Promise.resolve();
  }
  return deps.engine(path, origin.kind === "file" ? origin.sha256 : undefined).then(() => undefined);
}
