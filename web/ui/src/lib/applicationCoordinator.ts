import { app, gotoPilot } from "./store.svelte";
import { chat, openChat } from "./pilotChat.svelte";
import { withPilotChats } from "./pilotChatGraph";
import { findNode } from "../../../../lib/graphIdentity";
import { refreshSourceAttention } from "./sourceAttention.svelte";
import { refreshWork } from "./workSessions.svelte";
import { configurePilotCoordination } from "./pilotCoordination";
import { configureNoteAliases } from "./noteNavigation";

export function initializeApplicationCoordination(): void {
  configurePilotCoordination({
    navigate(id, replace, focus) { gotoPilot(id, replace); if (focus === false) app.pilotAutofocus = false; },
    selection: () => app.graphView.selected,
    clearSelection() { app.graphView = { selected: [], excluded: [] }; },
    recordChanged() { app.rev++; },
    settled() { void refreshSourceAttention(); },
    refreshWorkers: refreshWork,
  });
  configureNoteAliases((path, replace) => {
    const graph = withPilotChats(chat.graph, chat.sessions, null);
    const node = graph?.nodes[findNode(graph.nodes, path)];
    if (!node || !chat.sessions.some(s => s.id === node.id)) return false;
    openChat(node.id, { replace }); return true;
  });
}
