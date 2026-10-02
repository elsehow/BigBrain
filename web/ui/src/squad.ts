// The squad view's own page (squad.html, served at /squad): the agents
// writing the vault, in its field. Deliberately NOT a route inside the app
// shell — the shell owns the window, the keyboard and the ground, and a
// second full-screen view multiplexed over it fought all three. This page
// mounts one component and nothing else; the app stays one link away.
import { mount } from "svelte";
import SquadView from "./components/SquadView.svelte";
import { watchSystemTheme } from "./lib/theme";
import "./design/tokens.css";

watchSystemTheme();

export default mount(SquadView, { target: document.getElementById("app")! });
