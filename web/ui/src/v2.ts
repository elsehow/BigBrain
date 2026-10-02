// The v2 view's own page (v2.html, served at /v2): the agents
// writing the vault, in its field. Deliberately NOT a route inside the app
// shell — the shell owns the window, the keyboard and the ground, and a
// second full-screen view multiplexed over it fought all three. This page
// mounts one component and nothing else; the app stays one link away.
import { mount } from "svelte";
import V2View from "./components/V2View.svelte";
import { watchSystemTheme } from "./lib/theme";
import "./design/tokens.css";

watchSystemTheme();

export default mount(V2View, { target: document.getElementById("app")! });
