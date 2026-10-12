// Settings › lenses and Edit a lens talk to /api/lenses (lib/lensApi.ts) through here.
import { vaultFetch } from "./vaultScope";

export type SharingMode = "conservative" | "yeehaw";
export interface ServerRef { id: string; name: string }
export interface LensReviewSummary { reason: "model" | "vault" | "update"; hold: boolean; joins: number; leaves: number; at: string }
export interface LensSummary { id: string; name: string; text: string; members: number; error?: string; servers: ServerRef[]; review?: LensReviewSummary }
export interface LensNoteRow { id: string; title: string; date: string; path: string }
export interface LensDetail extends Omit<LensSummary, "review"> {
  pins: string[]; exclusions: string[]; summarized: string[]; notes: LensNoteRow[];
  review?: { reason: LensReviewSummary["reason"]; hold: boolean; joins: LensNoteRow[]; leaves: LensNoteRow[]; at: string };
}
/** A note the edited rule takes (`rule`) or the lens had (`was`), before hand edits. */
export interface PreviewRow extends LensNoteRow { rule: boolean; was: boolean; summarized: boolean; failed: boolean }
export interface Preview { id: string; busy: boolean; done: number; total: number; error?: string; failed: number; rows: PreviewRow[] }

export async function lensRequest<T>(action: string, body?: unknown): Promise<T> {
  const r = await vaultFetch("/api/lenses" + (action ? "/" + action : ""), {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error ?? "Could not update the lens.");
  return data as T;
}

/** The warning on a lens a change grew while shared (D3), as the feed says it. */
export function reviewWords(review: Pick<LensReviewSummary, "reason" | "hold">, servers: ServerRef[]) {
  const cause = review.reason === "model" ? "A model upgrade" : review.reason === "vault" ? "A vault change" : "A BigBrain update";
  const to = servers.map((s) => s.name).join(", ");
  return review.hold ? `${cause} would cause you to share new items with ${to}. Lens is paused until you review.` : `${cause} has caused you to share new items with ${to}.`;
}

/** What Edit a lens opens with, when the warning in Settings › lenses sent the person there. */
export const lensOpening = $state({ panel: "" as "" | "changes" | "rule" });

/** A rule to start a new lens from (a server's suggestion), handed from the server page to Edit a lens. */
export const lensDraft = $state({ text: "" });

/** The words for sharing a lens with a server, or stopping: the same on the lens and on the server's page. */
export function shareWords(lens: string, server: string, on: boolean) {
  return on
    ? { title: `Share ${lens} with ${server}?`, body: `Are you sure? This gives every user of ${server} visibility of every item in this lens.`, action: `Share with ${server}` }
    : { title: `Stop sharing ${lens} with ${server}?`, body: `Are you sure? This removes visibility of every item in this lens for every user of ${server}.`, action: "Stop sharing" };
}
