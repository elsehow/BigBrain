/** A viewer or first-run door a test spawns answers only its launch's session
 * (lib/viewerSession.ts). Spawn it with HOME at `viewerHome()` — the session
 * file lives under HOME, never the developer's — and ask with `viewerAuth`. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readViewerSession, viewerAuthorization } from "../../lib/viewerSession";

export const viewerHome = (): string => mkdtempSync(join(tmpdir(), "bb-viewer-home-"));

const dir = (home: string): string => join(home, ".config", "bigbrain");

export const viewerSecret = (home: string, port: number): string | null => readViewerSession(port, dir(home));

export const viewerAuth = (home: string, port: number): Record<string, string> => viewerAuthorization(port, dir(home));

/** `fetch` against the spawned server, with its session. */
export function viewerFetch(home: string, port: number, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { ...viewerAuth(home, port), ...(init.headers as Record<string, string> | undefined) } });
}
