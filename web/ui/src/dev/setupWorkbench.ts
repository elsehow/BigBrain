// Component study only. All connections and folder selection are simulated.
import { mount } from 'svelte';
import '../design/tokens.css';
import '../app.css';
import { watchSystemTheme } from '../lib/theme';
import SetupWorkbench from './SetupWorkbench.svelte';
watchSystemTheme();
mount(SetupWorkbench, { target: document.getElementById('app')! });
