// Dev only: the Field look panel (FieldTune.svelte), added to the app's own
// page by vite.config.ts when the dev server runs with BIGBRAIN_FIELD_TUNE=1.
import { mount } from "svelte";
import FieldTune from "./FieldTune.svelte";

const host = document.body.appendChild(document.createElement("div"));
mount(FieldTune, { target: host });
