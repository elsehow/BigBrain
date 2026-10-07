/** Serve the diagnostic viewer over a read-only proxy to an already-running app.
 * bun bin/ui-diagnostics.ts [port]; no supervisor, jobs, or PostHog collection.
 * The app's viewer answers only its session: the browser's cookie from
 * `bigbrain open` is passed through, and nothing else grants one. */
import { resolve, sep } from "node:path";

const dist = resolve(import.meta.dir, "../web/ui/dist");
const port = Number(process.argv[2] ?? 53919);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid diagnostic port");
if (!await Bun.file(resolve(dist, "index.html")).exists()) throw new Error("Build web/ui first");
const server = Bun.serve({
  hostname: "127.0.0.1", port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/telemetry") return Response.json({ enabled: false, decided: true,
      configured: false, samples: [], operations: {}, actions: {}, queued: 0, delivery: "idle" });
    if (!["GET", "HEAD"].includes(request.method))
      return Response.json({ error: "This diagnostic window is read-only." }, { status: 403 });
    if (url.pathname.startsWith("/api/")) {
      try {
        return await fetch(`http://127.0.0.1:4747${url.pathname}${url.search}`, {
          method: request.method, signal: request.signal, redirect: "error",
          headers: { accept: request.headers.get("accept") ?? "application/json", cookie: request.headers.get("cookie") ?? "" },
        });
      } catch { return Response.json({ error: "The running desktop engine is unavailable." }, { status: 502 }); }
    }
    let path: string;
    try { path = resolve(dist, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)); }
    catch { return new Response("Invalid path", { status: 400 }); }
    if (!path.startsWith(dist + sep)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    if (!await file.exists()) return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : file, {
      headers: { "content-type": file.type, "cache-control": "no-store" },
    });
  },
});
console.log(`Diagnostic viewer: ${server.url} (read-only; keep the installed desktop app running, and run \`bigbrain open\` once in the same browser)`);
