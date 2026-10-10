/** Optional onboarding steps belong only to vaults created by the new setup flow. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./fsx";

/** `reader`: joined a server and went straight to its notes, with nothing yet to
 * run the gardener (D5). Adding something sends them back to `providers`. */
export type SetupProgress = "vault" | "providers" | "integrations" | "clients" | "analytics" | "complete" | "reader";
const path = (root: string) => join(root, ".spool", "setup-progress.json");

export function setupProgress(root: string): SetupProgress | undefined {
  try {
    const value = JSON.parse(readFileSync(path(root), "utf8"));
    return ["vault", "providers", "integrations", "clients", "analytics", "complete", "reader"].includes(value.step) ? value.step : undefined;
  } catch { return undefined; }
}

export function saveSetupProgress(root: string, step: SetupProgress): void {
  writeAtomic(path(root), JSON.stringify({ step }) + "\n");
}
