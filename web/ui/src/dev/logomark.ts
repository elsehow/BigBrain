// Dev only: the mark (lib/logomark.ts). `?s=turning` (the default) and
// `?s=still` are the workbench; `?s=render` is the stage that
// bin/renderLogomark.cjs screenshots frame by frame (brand/README.md).
import { mount } from "svelte";
import "../design/tokens.css";
import "../app.css";
import LogomarkRender from "./LogomarkRender.svelte";
import LogomarkWorkbench from "./LogomarkWorkbench.svelte";
import { watchSystemTheme } from "../lib/theme";

const scene = new URLSearchParams(location.search).get("s") ?? "turning";
const target = document.getElementById("app")!;
watchSystemTheme();
if (scene === "render") mount(LogomarkRender, { target });
else mount(LogomarkWorkbench, { target, props: { scene } });
