import { vaultStorageKey, onVaultSwitch } from "./vaultScope";
/** Local authoring state belongs to the tab and vault, never to summary refreshes. */
export const pilotDrafts = $state<Record<string, string>>({});
export function restorePilotDraft(id: string, saved: string): void {
  if (pilotDrafts[id] !== undefined) return;
  try { pilotDrafts[id] = sessionStorage.getItem(vaultStorageKey(`draft:${id}`)) ?? saved; }
  catch { pilotDrafts[id] = saved; }
}
export function keepPilotDraft(id: string, text: string): void {
  pilotDrafts[id] = text;
  try { sessionStorage.setItem(vaultStorageKey(`draft:${id}`), text); } catch { /* Keep in memory. */ }
}
onVaultSwitch(() => { for (const [id, text] of Object.entries(pilotDrafts)) keepPilotDraft(id, text); });
