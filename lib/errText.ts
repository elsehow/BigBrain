/** Render any thrown/caught value as display text — an `Error`'s message,
 * or the value coerced to a string for anything else a `catch` might see
 * (a thrown string, a rejected fetch's plain object, …). The one spelling
 * every catch block in the viewer, and web/server.ts, reached for
 * separately before this consolidation (#265).
 *
 * Lives in lib/, not web/ui/src/lib/, because web/server.ts imports it and
 * the desktop bundle strips web/ui/src (desktop/build-resources.sh — the
 * viewer ships as web/ui/dist). Its old home shipped by accident until #654
 * fixed the excludes, after which desktop 0.1.14 could not start its viewer.
 * test/bundleBoundary.test.ts now fails on any engine-side import of ui/src. */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
