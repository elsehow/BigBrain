import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { devProvenance } from "./devProvenance";
import { devGraphSnapshot } from "./devGraphSnapshot";
import { devV2Live } from "./devV2Live";

export default defineConfig({
  // Relative base: ONE build must serve at "/" (web/server.ts) AND from any
  // deeper mount (#96 — the hosted era's /app; dev.html today). The
  // app is hash-routed, so the document URL never leaves its mount point and
  // relative asset URLs resolve correctly at either depth.
  base: "./",
  plugins: [svelte(), devProvenance(), devGraphSnapshot(), devV2Live(), {
    // BIGBRAIN_FIELD_TUNE=1: the app's page gets the Field look sliders (src/dev/fieldTune.ts)
    name: "field-tune", apply: "serve",
    transformIndexHtml: (html, ctx) => process.env["BIGBRAIN_FIELD_TUNE"] === "1" && /\/(index|v2)\.html$/.test(ctx.path)
      ? html.replace("</body>", `<script type="module" src="/src/dev/fieldTune.ts"></script></body>`) : html,
  }, {
    name: "read-only-live-preview", apply: "serve",
    configureServer(server) {
      if (process.env["BIGBRAIN_PREVIEW_READ_ONLY"] !== "1") return;
      // BIGBRAIN_PREVIEW_ALLOW: exact /api paths a read-only preview may still
      // write through to the live engine (comma-separated), e.g. the v2
      // view's pilot start and Quick briefing. Everything else stays refused.
      const allow = new Set((process.env["BIGBRAIN_PREVIEW_ALLOW"] ?? "").split(",").map((p) => p.trim()).filter(Boolean));
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/") || ["GET", "HEAD"].includes(req.method ?? "")) return next();
        if (allow.has(req.url.split("?")[0] ?? "")) return next();
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "This workbench is a read-only live preview." }));
      });
    },
  }],
  server: {
    // dev flow: `bun run web` (backend on 4747) + `bun run web:dev` (this, with HMR).
    // BIGBRAIN_WEB_PORT moves the backend — desktop/dev.sh runs it beside a live
    // install on :4757.
    proxy: {
      "/api": { target: `http://localhost:${process.env["BIGBRAIN_WEB_PORT"] ?? "4747"}`, changeOrigin: false },
    },
  },
  // Two pages ship: the app, and the v2 view on its own (v2.html → /v2).
  // Every other *.html here is a dev workbench and stays out of the build.
  build: { outDir: "dist", emptyOutDir: true, rollupOptions: { input: { index: "index.html", v2: "v2.html" } } },
});
