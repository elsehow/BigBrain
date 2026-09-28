/**
 * update.svelte.ts — "a newer BigBrain exists", one banner's worth of state.
 *
 * The shell does the real work (desktop lib.rs: update_check asks the
 * site's latest.json, update_install downloads, verifies and relaunches) —
 * this module is only the cadence and what UpdateNudge renders. No shell,
 * no checks: a plain tab or the workbench never shows the banner unless a
 * workbench scene sets this state by hand.
 *
 * Dismissing is per version and remembered (bb-update-skip): ×-ing 0.2.0
 * keeps 0.2.0 quiet on every later check, and 0.2.1 speaks again.
 */
import { hasShell, updateCheck, updateInstall, type UpdateInfo } from "./native";

const SKIP_KEY = "bb-update-skip";
const EVERY = 6 * 60 * 60 * 1000;

export const update = $state({
  available: null as UpdateInfo | null,
  phase: "idle" as "idle" | "installing" | "failed",
  error: null as string | null,
});

function skipped(): string {
  try {
    return localStorage.getItem(SKIP_KEY) ?? "";
  } catch {
    return "";
  }
}

async function check(): Promise<void> {
  try {
    const u = await updateCheck();
    update.available = u && u.version !== skipped() ? u : null;
  } catch {
    // a failed CHECK is not news (offline, the site down) — the banner only
    // ever reports an install the person asked for going wrong
  }
}

let started = false;

/** Called once from App.svelte: check now, then every six hours. */
export function startUpdateChecks(): void {
  if (started || !hasShell()) return;
  started = true;
  void check();
  setInterval(() => void check(), EVERY);
}

/** The banner's button. On success the app restarts out from under this
 * page; a thrown error becomes the banner's failed line, with the button
 * still there to try again. */
export async function install(): Promise<void> {
  if (update.phase === "installing") return;
  update.phase = "installing";
  update.error = null;
  try {
    await updateInstall();
  } catch (e) {
    update.phase = "failed";
    update.error = e instanceof Error ? e.message : String(e);
  }
}

/** × — this version stays quiet for good, the next one speaks. */
export function dismiss(): void {
  const v = update.available?.version;
  update.available = null;
  update.phase = "idle";
  update.error = null;
  if (v) {
    try {
      localStorage.setItem(SKIP_KEY, v);
    } catch {
      /* private mode: quiet until the next launch is fine */
    }
  }
}
