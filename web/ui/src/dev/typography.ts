import { mount } from 'svelte';
import '../design/tokens.css';
import '../app.css';
import TypographyWorkbench from './TypographyWorkbench.svelte';
if (import.meta.env.DEV) mount(TypographyWorkbench, {target: document.body});
