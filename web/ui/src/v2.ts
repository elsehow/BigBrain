// /v2 (v2.html): the base with Field pinned, whatever this device chose.
// The app at / is the same base, showing the view chosen in Settings.
import { mount } from "svelte";
import Base from "./components/Base.svelte";
import { watchSystemTheme } from "./lib/theme";
import "./design/tokens.css";
import "./app.css";

watchSystemTheme();

export default mount(Base, { target: document.getElementById("app")!, props: { view: "field" } });
