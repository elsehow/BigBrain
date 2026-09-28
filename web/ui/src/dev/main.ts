import { initializeApplicationCoordination } from "../lib/applicationCoordinator";
// Entry for /dev.html. Vite's build input is index.html alone, so this tree
// is served in dev and never built into dist/ — the workbench cannot ship.
import { mount } from "svelte";
import "../design/tokens.css";
import "../app.css";
import Workbench from "./Workbench.svelte";

initializeApplicationCoordination();
mount(Workbench, { target: document.body });
