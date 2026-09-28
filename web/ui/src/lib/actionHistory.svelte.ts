import { onVaultSwitch } from "./vaultScope";
export const actionHistory = $state<{ open: boolean; pilot?: string; title: string }>({ open: false, title: "Recent actions" });
export function inspectActions(pilot?: string, title = "Recent actions"): void {
  actionHistory.pilot = pilot; actionHistory.title = title; actionHistory.open = true;
}
onVaultSwitch(() => { actionHistory.open = false; actionHistory.pilot = undefined; });
