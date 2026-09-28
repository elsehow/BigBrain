import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const version = JSON.parse(readFileSync(new URL("../../desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8")).version;
const provenance = `${version} · ${git("rev-parse", "--short", "HEAD")}${git("status", "--porcelain") ? " + edits" : ""}`;

// Separate entry: no production route changes, API proxy, or public assets.
export default defineConfig({
  root: fileURLToPath(new URL("./integration-workbench", import.meta.url)),
  base: "./",
  publicDir: false,
  define: { "import.meta.env.VITE_INTEGRATION_PREVIEW_SOURCE": JSON.stringify(provenance) },
  resolve: { alias: [{
    find: /^\.\/components\/IntegrationsView\.svelte$/,
    replacement: fileURLToPath(new URL("./src/dev/integrations/IntegrationsPreview.svelte", import.meta.url)),
  }] },
  plugins: [
    {
      name: "offline-design-tokens",
      enforce: "pre",
      transform(code, id) {
        if (id.endsWith("/design/tokens.css")) {
          return code.replace(/@import url\("https:\/\/fonts\.googleapis\.com[^\n]+\n/, "");
        }
      },
    },
    svelte({ configFile: false }),
  ],
  build: { outDir: "../dist-integrations", emptyOutDir: true, modulePreload: { polyfill: false } },
});
