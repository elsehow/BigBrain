export const PILOTS_PANE_SCENES: Record<string, { label: string; note: string }> = {
  overview: { label: "Pilots · needs you", note: "a opens Pilots; j/k previews each active Pilot and highlights it in the graph; Enter opens its conversation. The same breathing selector identifies needs-you Pilots in the list and graph. Working Pilots keep their orbiting circle. All activity and decisions are simulated." },
  quiet: { label: "Pilots · all working", note: "Active Pilots remain discoverable even when none needs you. No attention pulse." },
  empty: { label: "Pilots · none active", note: "The pane stays accessible with a. An empty state replaces a notification history." },
  many: { label: "Pilots · long list", note: "A longer active roster tests scrolling and keyboard navigation. Rows keep their place when a request is answered." },
};
