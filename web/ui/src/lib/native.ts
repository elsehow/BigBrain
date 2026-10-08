/**
 * native.ts — what the desktop shell lends the viewer.
 *
 * The viewer is a web page served by the engine (http://127.0.0.1:4747) and
 * shown inside the Tauri webview. Tauri injects `window.__TAURI__` there
 * only because the shell says so twice: `app.withGlobalTauri` in
 * desktop/src-tauri/tauri.conf.json, and a capability whose `remote.urls`
 * names the viewer's origin (desktop/src-tauri/capabilities/default.json)
 * — a remote page gets NO system access by default. Each plugin the
 * capability grants appears under the global; the dialog plugin is the one
 * granted today, for the folder picker.
 *
 * Everything here is feature-detected, so the same bundle runs in a plain
 * browser (the dev loop's vite tab, a headless host's viewer, the
 * workbench) and simply has no dialog there.
 */

interface TauriDialog {
  open(opts: { directory?: boolean; multiple?: boolean; title?: string; defaultPath?: string }): Promise<string | string[] | null>;
}
interface TauriOpener {
  openUrl(url: string): Promise<void>;
}
interface TauriCore {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}
interface TauriApp {
  getVersion(): Promise<string>;
}
interface TauriGlobal {
  dialog?: TauriDialog;
  opener?: TauriOpener;
  core?: TauriCore;
  app?: TauriApp;
}

const tauri = (): TauriGlobal | undefined => typeof window === "undefined" ? undefined : (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;

function dialog(): TauriDialog | null {
  const t = tauri();
  return t?.dialog && typeof t.dialog.open === "function" ? t.dialog : null;
}

/** The shell's own version (tauri.conf.json's) — null in a plain tab. The
 * engine cannot know it: the bundle stamp names a commit, the app a
 * release, and the diagnostics bundle wants the one a person quotes. */
export async function appVersion(): Promise<string | null> {
  const a = tauri()?.app;
  if (!a || typeof a.getVersion !== "function") return null;
  try {
    return await a.getVersion();
  } catch {
    return null;
  }
}

/** Open a link OUTSIDE the app. Inside the shell a `_blank` link would load
 * in the app's own webview — there is no tab to open — so the opener plugin
 * hands it to the system browser; in a plain tab a new tab is the same
 * thing. Never used for anything but http(s) links we wrote ourselves. */
export function openExternal(url: string): void {
  const o = tauri()?.opener;
  if (o && typeof o.openUrl === "function") {
    void o.openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}
export const hasExternalOpener = (): boolean => typeof tauri()?.opener?.openUrl === "function";

/** Can this page put up a native folder dialog? */
export const hasFolderDialog = (): boolean => dialog() !== null;

/** The native folder dialog; null when the person cancels. macOS's panel
 * has its own New Folder button, so "create a vault" and "open a vault"
 * are the same dialog with a different title. */
export async function chooseFolder(title: string, defaultPath?: string): Promise<string | null> {
  const d = dialog();
  if (!d) return null;
  const r = await d.open({ directory: true, multiple: false, title, ...(defaultPath ? { defaultPath } : {}) });
  return typeof r === "string" && r ? r : null;
}

/** Choose several allowlisted folders in the same OS panel. */
export async function chooseFolders(title: string, defaultPath?: string): Promise<string[]> {
  const d = dialog();
  if (!d) return [];
  const result = await d.open({ directory: true, multiple: true, title, ...(defaultPath ? { defaultPath } : {}) });
  return [...new Set((Array.isArray(result) ? result : typeof result === "string" ? [result] : []).filter(Boolean))];
}

// ── the shell's own commands (desktop/src-tauri/src/lib.rs) ─────────────────
// `core.invoke` reaches the app's #[tauri::command]s. Absent in a plain tab
// and in the workbench, where every call below answers "no shell" and the
// caller does the in-page thing instead.

function core(): TauriCore | null {
  const t = tauri();
  return t?.core && typeof t.core.invoke === "function" ? t.core : null;
}

/** Is this page inside the desktop app? (Only the shell can register a
 * global shortcut or move the palette window.) */
export const hasShell = (): boolean => core() !== null;

/** The OS window's zoom state; absent in browsers and older shells. */
export async function nativeWindowMaximized(): Promise<boolean | null> {
  const c = core();
  if (!c) return null;
  try { return await c.invoke<boolean>("window_is_maximized"); }
  catch { return null; }
}

/** Fill the desktop or restore the previous frame; never changes app chrome. */
export async function toggleNativeWindow(): Promise<boolean | null> {
  const c = core();
  return c ? c.invoke<boolean>("window_toggle_maximize") : null;
}

/** Match the native title bar to the actual page colour, including custom
 * skins. Canvas resolves any CSS colour syntax into the shell's sRGB bytes. */
export function syncWindowBackground(): void {
  const c = core();
  if (!c || typeof document === "undefined" || !document.body) return;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  void c.invoke("window_background", { color: [r, g, b] }).catch(() => {
    // An older desktop shell can serve a newer viewer during development.
  });
}

/** An update the site is offering: the version waiting, and the notes its
 * update feed carries. */
export interface UpdateInfo {
  version: string;
  notes: string | null;
}

/** Ask the shell whether the site holds a newer build than the one running.
 * Null in a plain tab (no shell) and when this version is current; throws
 * with the shell's words when the check itself failed (offline, a
 * update feed that does not parse). */
export async function updateCheck(): Promise<UpdateInfo | null> {
  const c = core();
  if (!c) return null;
  return c.invoke<UpdateInfo | null>("update_check");
}

/** Download, verify against the built-in pubkey, swap the app, relaunch.
 * In practice this resolves only by throwing — on success the shell
 * restarts out from under the page. */
export async function updateInstall(): Promise<void> {
  const c = core();
  if (!c) throw new Error("Updating needs the desktop app.");
  await c.invoke("update_install");
}
