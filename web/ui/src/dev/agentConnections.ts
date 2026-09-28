import { mount } from 'svelte';
import '../design/tokens.css';
import '../app.css';
import AgentConnectionsWorkbench from './AgentConnectionsWorkbench.svelte';
document.documentElement.dataset.theme = 'asagiiro';
mount(AgentConnectionsWorkbench, { target: document.getElementById('app')! });
