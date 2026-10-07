/**
 * loopbackFrame.ts — where the viewer shows a page an agent serves itself.
 *
 * Cookies are scoped to a host, not a port: framed (or opened) on the
 * viewer's own loopback name, any server on this machine — an agent's dev
 * server included — would be sent the viewer's session cookie
 * (lib/viewerSession.ts). So the page goes under the other loopback name,
 * which reaches the same server and carries none of the viewer's cookies.
 */
const OTHER: Record<string, string> = { "127.0.0.1": "localhost", localhost: "127.0.0.1" };

export function otherLoopback(url: string, viewerHost: string = location.hostname): string {
  try {
    const at = new URL(url);
    const other = OTHER[at.hostname];
    if (!other || at.hostname !== viewerHost) return url;
    at.hostname = other;
    return at.href;
  } catch {
    return url;
  }
}
