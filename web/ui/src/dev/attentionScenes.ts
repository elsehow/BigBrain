import type { GraphData } from "../lib/types";
import type { PilotNotification } from "../lib/notificationTypes";

export const ATTENTION_SCENES: Record<string, { label: string; note: string }> = {
  overview: { label: "Notifications + unread", note: "Two independent reasons for attention. Open the bell, or select unread and press Shift–Enter. All mail and Pilot actions in this workbench are simulated." },
  "no-unread": { label: "Notifications · no unread", note: "No unread sources: the envelope stays visible but inactive, beside the bell and settings." },
  quiet: { label: "Unread · quiet Pilots", note: "A Pilot is working with its agent, but has not notified you. Its activity creates no notification." },
  empty: { label: "All caught up", note: "No unread sources and no Pilot notifications. Both toolbar buttons remain visible; the bell opens its empty state." },
  seen: { label: "Seen · still needs you", note: "Seeing a question clears its new badge, but the Pilot still needs an answer." },
  long: { label: "Long messages + overflow", note: "Long Pilot names, long questions, and enough notifications to scroll. Try a narrow viewport and dark mode." },
  failure: { label: "Read-state sync failure", note: "A failed provider write leaves sources unread. Retry after switching off Simulate sync failure." },
};

export const attentionNotifications = (): PilotNotification[] => [
  { id: "conference-choice", pilotId: "conference", pilotTitle: "Conference plans", messageId: "question-1", kind: "question", text: "Both dates work. Should I plan around Thursday or Friday?", at: "2m", seen: false },
  { id: "research-check", pilotId: "research", pilotTitle: "Research roadmap", messageId: "question-2", kind: "question", text: "The agent found a mismatch in the results. Which dataset should we treat as the reference?", at: "8m", seen: false },
  { id: "reading-ready", pilotId: "reading", pilotTitle: "Reading group", messageId: "update-1", kind: "update", text: "Your reading list is ready. Three papers connect directly to last week’s discussion.", at: "24m", seen: true },
];
export const attentionSources = [
  { id: "mail-1", title: "Two possible dates for the conference", from: "Maya", cluster: "conference", unread: true },
  { id: "mail-2", title: "Travel and accommodation options", from: "Alex", cluster: "conference", unread: true },
  { id: "mail-3", title: "The revised results are attached", from: "Sam", cluster: "research", unread: true },
  { id: "mail-4", title: "Which dataset did we use?", from: "Casey", cluster: "research", unread: true },
  { id: "mail-5", title: "Papers for next week", from: "Jo", cluster: "reading", unread: true },
  { id: "mail-6", title: "Notes from our last discussion", from: "Ari", cluster: "reading", unread: true },
  { id: "mail-7", title: "A new preprint you might like", from: "Lee", cluster: "reading", unread: true },
  { id: "mail-8", title: "Confirmed: meeting room booked", from: "Maya", cluster: "conference", unread: false },
];
export function attentionGraph(): GraphData {
  const hubs = [{ id: "conference", title: "Conference plans", x: -230, y: -70 }, { id: "research", title: "Research roadmap", x: 170, y: -95 }, { id: "reading", title: "Reading group", x: 25, y: 190 }];
  const nodes: GraphData["nodes"] = hubs.map(h => ({ ...h, path: `references/${h.id}.md`, group: "entity", degree: 6 }));
  const edges: GraphData["edges"] = [];
  for (const [i, source] of attentionSources.entries()) {
    const hub = hubs.find(h => h.id === source.cluster)!;
    nodes.push({ id: source.id, title: source.title, group: "source", path: `references/${source.id}.md`, source: "email", degree: 1,
      x: hub.x + Math.cos(i * 2.3) * 110, y: hub.y + Math.sin(i * 2.3) * 115 });
    edges.push({ source: source.id, target: hub.id });
  }
  for (let i = 0; i < 48; i++) {
    const hub = hubs[i % hubs.length]!;
    nodes.push({ id: `other-${i}`, title: ["Meeting notes", "Project brief", "Background reading", "Related discussion"][i % 4]!, group: "source", path: `references/other-${i}.md`, degree: 1,
      x: hub.x + Math.cos(i * 2.399) * (130 + i * 4), y: hub.y + Math.sin(i * 2.399) * (120 + i * 3) });
    edges.push({ source: `other-${i}`, target: hub.id });
  }
  edges.push({ source: "conference", target: "research" }, { source: "research", target: "reading" });
  return { nodes, edges, hash: "attention-workbench", projection: "assertions" };
}
