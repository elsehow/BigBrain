// /v2 (v2.html): the same base and Field as the app at /, kept so links to
// /v2 still land.
import { mount } from "svelte";
import Base from "./components/Base.svelte";
import { watchSystemTheme } from "./lib/theme";
import "./design/tokens.css";
import "./app.css";

watchSystemTheme();

export default mount(Base, { target: document.getElementById("app")! });
