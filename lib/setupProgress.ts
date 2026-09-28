/** Optional onboarding steps belong only to vaults created by the new setup flow. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./fsx";

export type SetupProgress = "vault" | "providers" | "integrations" | "clients" | "analytics" | "complete";
const path = (root: string) => join(root, ".spool", "setup-progress.json");

export function setupProgress(root: string): SetupProgress | undefined {
  try {
    const value = JSON.parse(readFileSync(path(root), "utf8"));
    return ["vault", "providers", "integrations", "clients", "analytics", "complete"].includes(value.step) ? value.step : undefined;
  } catch { return undefined; }
}

export function saveSetupProgress(root: string, step: SetupProgress): void {
  writeAtomic(path(root), JSON.stringify({ step }) + "\n");
}
