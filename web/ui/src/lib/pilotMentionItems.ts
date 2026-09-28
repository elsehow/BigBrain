import type { MentionItem } from "../../../../lib/pilotMentions";
import type { SearchHit } from "./omnibox.svelte";
import { titleOf } from "./utils";

export function mentionItem(hit: SearchHit): MentionItem {
  const ms = hit.note.modified;
  const date = ms && Number.isFinite(ms) ? new Date(ms) : null;
  const dateOnly = date && date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0;
  return { id: hit.sessionId && hit.dir === "pilot" ? hit.sessionId : hit.note.path,
    title: hit.title || titleOf(hit.note.name),
    tag: hit.dir === "pilot" ? "PILOT" : hit.dir === "memory" ? "MEMORY" : hit.dir === "projection/entities" ? "ENTITY" : "SOURCE",
    date: !date ? "" : dateOnly ? date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
      : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", ""),
  };
}
