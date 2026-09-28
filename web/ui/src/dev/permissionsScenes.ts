import { SETTINGS, type VaultState } from "./fakeApi";
export const PERMISSIONS_SCENES: Record<string, { label: string; note: string } & Partial<VaultState>> = {
  settings: { ...SETTINGS.codexVault, label: "Settings → Vault · Pilot permissions", note: "The actual Vault settings page, with Pilot permissions under Pilot. Scroll down to it. All edits are local to this preview." },
};