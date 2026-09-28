/** Shared semantic options for HTTP and agent note readers. Transport-specific
 * flags and response formats are decoded by the caller. */
import type { EntityViewFilter } from "./assertionEntityView";

/** q filters assertions on an entity and blocks on a source/Markdown note.
 * after/before/n/order/toc affect entities; slack affects source/Markdown blocks. */
export interface NoteWindow extends EntityViewFilter {
  /** Source / Markdown notes: blocks of context each side of a match. */
  slack?: number;
}
export const ENTITY_WINDOW_CAP = 1000;
export const SLACK_CAP = 20;
export class NoteWindowError extends Error {}

export function parseNoteWindow(input: Record<string, unknown>): NoteWindow {
  const window: NoteWindow = {};
  const text = (key: string) => typeof input[key] === "string" ? input[key].trim() : "";
  const q = text("q");
  if (q) window.q = q;
  for (const name of ["after", "before"] as const) {
    const value = text(name);
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new NoteWindowError(`bad ${name} "${value}" — use YYYY-MM-DD`);
    if (value) window[name] = value;
  }
  for (const [name, min, max] of [["n", 1, ENTITY_WINDOW_CAP], ["slack", 0, SLACK_CAP]] as const) {
    const raw = input[name];
    if (raw === undefined) continue;
    const value = typeof raw === "number" || typeof raw === "string" ? Math.trunc(Number(raw)) : NaN;
    if (!(value >= min && value <= max)) throw new NoteWindowError(`bad ${name} "${raw}" — use an integer from ${min} to ${max}`);
    window[name] = value;
  }
  const order = text("order");
  if (order && order !== "asc" && order !== "desc") throw new NoteWindowError(`bad order "${order}" — use order=asc or order=desc`);
  if (order) window.order = order as "asc" | "desc";
  if (input.toc === true) window.toc = true;
  return window;
}
