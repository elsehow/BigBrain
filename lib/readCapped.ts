/**
 * readCapped.ts — a request body with a ceiling, for both MCP doors
 * (lib/mcpHttp.ts) and the shared connector's OAuth forms (lib/sharedOAuth.ts).
 *
 * Its own module so the local API's door does not import the shared
 * connector: that reaches lib/sharedPages.ts, whose fonts live in a tree the
 * desktop bundle strips (desktop/build-resources.sh), and the app's engine
 * then dies on its first start (test/bundleBoundary.test.ts).
 */

/** The body as text, or null when it exceeds `max` — refused on the
 * declared length before reading, and on the bytes actually read. */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
