export const PILOT_SESSION_SCENES: Record<string, { label: string; note: string }> = {
  agents: { label: "Agent indicators", note: "Production canvas and SVG: running, waiting, done, stopped. Compare graph, search, panel and small sizes." },
  mentions: { label: "@ · Mention recents", note: "Type @ to mention a recent item. Type to filter; ↑↓ and Enter choose. Esc dismisses the menu. The current Pilot is excluded. Shift-↑ expands the text tab; Shift-↓ restores its standard height." },
  resize: { label: "Resizable text tab", note: "Two heights: Shift-↑ fully expands the text tab; Shift-↓ restores its standard height. The header arrows do the same. The taller conversation covers and blurs the graph behind it. Scripted conversation; no agent runs." },
  identity: { label: "Closed Pilot identity", note: "Visual experiment · A permanent Pilot glyph inside a separate selection ring. Compare graph, search and text-tab sizes; select nodes and switch activity states." },
  overview: { label: "Start on the graph", note: "Interactive mock · Click nodes (Shift-click for several), then Shift-Enter. Replies and context changes are scripted; no agent runs." },
  draft: { label: "4a · New session", note: "A session owns its context. Type and press Enter to play the working → answered transition." },
  typing: { label: "4b · Typing", note: "The draft is mirrored beside the session node. Enter sends; Shift-Enter adds a newline. Leaving preserves typed text as Draft session." },
  working: { label: "4c · Working", note: "Held working state for visual review. Moving dashes travel toward the session. Esc returns to the graph; Shift-Esc interrupts. Shift-Esc again stops." },
  answered: { label: "4d · Answered", note: "Scripted answer. Keep typing to continue; Shift-Enter inserts a newline. Leave the session before creating another." },
  multiple: { label: "Several selected", note: "A new session with Dana, Arbor OS and Arbor Cloud attached. Type and press Enter." },
  alone: { label: "No selected context", note: "Only the new session, alone in the void. Type and press Enter; context appears as the session attaches items." },
};

/** Visual tuning parameter: outer selector radius / inner shape radius. */
export const SELECTOR_RATIO = (1 + Math.sqrt(5)) / 2;
