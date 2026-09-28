import { mount } from 'svelte';
import '../design/tokens.css';
import '../app.css';
import VideoDemoWorkbench from './VideoDemoWorkbench.svelte';
if (import.meta.env.DEV) mount(VideoDemoWorkbench, { target: document.body });
