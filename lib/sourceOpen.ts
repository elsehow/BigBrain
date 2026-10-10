/**
 * sourceOpen.ts — the door that opens a source's origin ON THIS MACHINE.
 *
 * `POST /api/source/open {path}` — the note view's OPEN chip (⌘O) for a
 * source whose origin is a FILE: the original is copied out of the CAS
 * under its own name (the CAS keys by sha256, extensionless — the OS
 * picks a reader by the extension) and handed to the OS's open. A URL
 * origin never comes here: the viewer opens it itself (the shell's opener
 * plugin, a new tab in a browser — web/ui/src/lib/native.ts), the same
 * way it diverts every other outbound link. The door still answers a URL
 * — one act, "open the origin", whoever asks — so a client without a
 * browser of its own is not turned away.
 *
 * A copy out of the CAS is opened the way a browser opens a download: it
 * carries the quarantine mark first, so Gatekeeper asks before anything in
 * it runs, and a kind the OS would run or follow rather than read (an app,
 * a script, a .webloc) is only shown in Finder.
 *
 * Desktop-only, like the themes and diagnostics doors: the file opens on
 * the machine the app runs on, and that is the machine the person is at.
 * `open` and `reveal` are injectable for the same reason theirs are — the
 * real ones put a window on the screen of whoever runs `bun test`.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { getBlobPath } from "./blobs";
import { sha256hex } from "./hash";
import { osOpen, osReveal } from "./diagnostics";
import { json, readBody, send, type Route } from "./httpx";
import { readSourceInsertionPath } from "./sourceFeed";
import { sourceThreadView } from "./assertionEntityView";
import { sourceOrigin, sourceOrigins, type SourceOrigin } from "./sourceOrigin";

/** A filename the OS will take as one: no separators, no NUL, no leading
 * dot (a hidden file is one the person cannot find), the sha256 when
 * nothing usable is left. */
export function safeName(name: string, fallback: string): string {
  const cleaned = name.replace(/[\0/\\]/g, "_").replace(/^\.+/, "").trim();
  return cleaned || fallback;
}

/** Where the original is laid out for the OS: one folder per blob, so two
 * drops with the same filename never overwrite each other, and the name
 * inside is the one it arrived with. A copy is made once; the CAS itself
 * is never handed out — a reader that "saves" edits its own copy. */
export function materializedPath(sha256: string, name: string, base: string = join(tmpdir(), "bigbrain", "open")): string {
  return join(base, sha256, safeName(name, sha256));
}

/** Kinds the OS runs, installs or follows somewhere else when opened. */
const RUNS = new Set([
  "app", "pkg", "mpkg", "dmg", "jar", "jnlp", "mobileconfig", "shortcut", "workflow", "action",
  "prefpane", "saver", "kext", "bundle", "plugin", "dylib", "xpc", "osax",
  "command", "tool", "terminal", "sh", "bash", "zsh", "csh", "tcsh", "ksh", "fish",
  "py", "pyw", "pl", "rb", "scpt", "scptd", "applescript",
  "webloc", "fileloc", "inetloc", "url", "desktop", "lnk",
  "exe", "msi", "bat", "cmd", "com", "scr", "ps1", "vbs", "appimage", "run",
]);

export const runsWhenOpened = (name: string): boolean => RUNS.has(extname(name).slice(1).toLowerCase());

/** The mark a browser puts on a download (`com.apple.quarantine`), naming
 * BigBrain as the agent. macOS only; elsewhere there is nothing to mark. */
export function quarantine(path: string, platform: string = process.platform, now: Date = new Date()): boolean {
  if (platform !== "darwin") return true;
  const value = `0081;${Math.floor(now.getTime() / 1000).toString(16)};BigBrain;`;
  return spawnSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", value, path], { stdio: "ignore" }).status === 0;
}

export type OpenResult =
  | { ok: true; origin: SourceOrigin; opened: string; revealed?: true }
  | { ok: false; origin: SourceOrigin | null; error: string };

/** Open one source's origin — or, by `sha256`, one of the files it names
 * (a page clipped with its PDF has both). Pure over its inputs but for the
 * copy and the open — `base`, `open` and `reveal` are the seams the test holds. */
export function openSourceOrigin(
  root: string,
  path: string,
  open: (target: string) => boolean = osOpen,
  base?: string,
  reveal: (target: string) => boolean = osReveal,
  sha256?: string,
): OpenResult {
  const source = readSourceInsertionPath(root, path) ?? sourceThreadView(root, path)?.members[0];
  if (!source) return { ok: false, origin: null, error: "no such source" };
  const origin = sha256
    ? sourceOrigins(source.envelope).find((o) => o.kind === "file" && o.sha256 === sha256) ?? null
    : sourceOrigin(source.envelope, source);
  if (!origin) return { ok: false, origin, error: sha256 ? "this source names no such file" : "this source has no origin to open" };
  if (origin.kind === "url")
    return open(origin.url) ? { ok: true, origin, opened: origin.url } : { ok: false, origin, error: "could not open a browser here" };
  if (origin.kind === "note") {
    const markdown = `# ${source.title}\n\n${source.body}\n`;
    const dest = materializedPath(sha256hex(markdown), origin.name, base);
    mkdirSync(dirname(dest), { recursive: true });
    // Exclusive creation preserves edits to the opened copy on subsequent opens.
    try { writeFileSync(dest, markdown, { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return open(dest) ? { ok: true, origin, opened: dest } : { ok: false, origin, error: "nothing here knows how to open a file" };
  }
  const blob = getBlobPath(root, origin.sha256);
  if (!blob) return { ok: false, origin, error: `the original (${origin.name}) is no longer in the vault` };
  const dest = materializedPath(origin.sha256, origin.name, base);
  if (!existsSync(dest)) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(blob, dest);
  }
  // Marked on every open: a copy laid out before the mark existed gets it too.
  if (!quarantine(dest) || runsWhenOpened(dest))
    return reveal(dest) ? { ok: true, origin, opened: dest, revealed: true } : { ok: false, origin, error: "nothing here can show a file" };
  return open(dest) ? { ok: true, origin, opened: dest } : { ok: false, origin, error: "nothing here knows how to open a file" };
}

export function sourceOpenRoutes(root: string, open: (target: string) => boolean = osOpen, base?: string, reveal: (target: string) => boolean = osReveal): Route[] {
  return [
    {
      method: "POST",
      path: "/api/source/open",
      handler: async ({ req, res }) => {
        let path = "", sha256: string | undefined;
        try {
          const body = JSON.parse(await readBody(req)) as { path?: unknown; sha256?: unknown };
          path = String(body.path ?? "");
          if (typeof body.sha256 === "string" && body.sha256) sha256 = body.sha256;
        } catch {
          return send(res, 400, JSON.stringify({ error: "a JSON body naming the source's path" }));
        }
        const r = openSourceOrigin(root, path, open, base, reveal, sha256);
        if (r.ok) return json(res, 200, r);
        json(res, r.origin ? 500 : 404, r);
      },
    },
  ];
}
