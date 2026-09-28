// Dev-only: the production App, connected directly to the local backend.
import { mount } from 'svelte';
import '../design/tokens.css';
import '../app.css';
import SidebarWorkbench from './SidebarWorkbench.svelte';
import { searchPresentation } from '../lib/floatingSearch.svelte';
import { watchSystemTheme, setChoice, type BuiltIn } from '../lib/theme';

searchPresentation.includeAgents = new URLSearchParams(location.search).get('layout') === 'original';


import { installGraphFixture } from './graphFixture';
if (new URLSearchParams(location.search).has('onboarding') || new URLSearchParams(location.search).get('vault') !== 'live') await installGraphFixture();

if(new URLSearchParams(location.search).has('gmail')) {
  const {installGmailScene}=await import('./gmailScene');installGmailScene();
}
if (new URLSearchParams(location.search).has('onboarding')) {
  const { installOnboardingFixture } = await import('./onboardingFixture');
  installOnboardingFixture();
}
if (new URLSearchParams(location.search).has('scenario')) {
  const { installApplicationScenario } = await import('./applicationScenarioFixture');
  installApplicationScenario();
}
if (new URLSearchParams(location.search).has('vaultScope')) {
  const { installVaultScopeFixture } = await import('./vaultScopeFixture');
  installVaultScopeFixture();
}
watchSystemTheme();
const graphTheme = new URLSearchParams(location.search).get('graphTheme');
if (['default', 'dusk', 'phosphor'].includes(graphTheme ?? '')) setChoice(graphTheme as BuiltIn);
mount(SidebarWorkbench, { target: document.getElementById('app')! });
