export const TEXT_TABS = [
  { id: "recent", label: "Recent", key: "r" },
  { id: "top", label: "Top", key: "t" },
  { id: "pilot", label: "Pilot", key: "p" },
] as const;
export type TextTab = typeof TEXT_TABS[number]["id"] | "note";
export const visibleTextTabs = (pilotEnabled: boolean, noteTitle?: string): { id: TextTab; label: string; key: string }[] => [
  ...TEXT_TABS.filter(t => t.id !== "pilot" || pilotEnabled),
  ...(noteTitle ? [{ id: "note" as const, label: noteTitle, key: "o" }] : []),
];

/** Tab works even in a field; letter shortcuts never steal typed text. */
export function textTabKey(e: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "repeat" | "isComposing">, current: TextTab, typing: boolean, pilotEnabled = true, noteTitle?: string): TextTab | null {
  if (e.repeat || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return null;
  const tabs = visibleTextTabs(pilotEnabled, noteTitle);
  if (e.key === "Tab") {
    const i = Math.max(0, tabs.findIndex(t => t.id === current));
    return tabs[(i + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length]!.id;
  }
  if (typing || e.shiftKey) return null;
  return tabs.find(t => t.key === e.key)?.id ?? null;
}
