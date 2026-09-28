import { mount } from "svelte";
import AppShell from "./components/AppShell.svelte";
import faviconPngUrl from "./assets/favicon-128.png";
import faviconUrl from "./assets/favicon.svg";
import { watchSystemTheme } from "./lib/theme";
import "./design/tokens.css";
import "./app.css";

// The favicon is attached here rather than written into index.html because
// ONE build serves at "/" and at "/app" (vite.config.ts's base: "./"). A
// literal href would be correct at one mount and a 404 at the other;
// importing it lets Vite emit the base-correct URL either way.
// Two of them: the SVG is the mark, and the 128px PNG is what a browser that
// refuses SVG favicons (Safari) shows instead — the same pair the landing
// links, so one tab icon holds across the whole origin.
for (const [rel, type, href] of [
  ["icon", "image/svg+xml", faviconUrl],
  ["alternate icon", "image/png", faviconPngUrl],
  ["apple-touch-icon", "image/png", faviconPngUrl],
]) {
  const icon = document.createElement("link");
  icon.rel = rel;
  icon.type = type;
  icon.href = href;
  document.head.appendChild(icon);
}

// Before the mount, so the first paint is already the right palette on a
// dark desktop rather than a cream flash that corrects itself.
watchSystemTheme();

const app = mount(AppShell, { target: document.getElementById("app")! });

export default app;
