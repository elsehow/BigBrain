// Dev-only: the production App, connected directly to the local backend.
import { mount } from 'svelte';
import '../design/tokens.css';
import '../app.css';
import SidebarWorkbench from './SidebarWorkbench.svelte';
import { watchSystemTheme, setChoice, type BuiltIn } from '../lib/theme';

// Captured before any fixture replaces the page's transport.
const networkFetch = window.fetch.bind(window);


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
if (new URLSearchParams(location.search).has('pilotNetwork')) {
  const { installPilotNetworkFixture } = await import('./pilotNetworkFixture');
  installPilotNetworkFixture(networkFetch);
}
if (new URLSearchParams(location.search).has('unreadSearch')) {
  const { installUnreadSearchFixture } = await import('./unreadSearchFixture');
  installUnreadSearchFixture();
}
watchSystemTheme();
const graphTheme = new URLSearchParams(location.search).get('graphTheme');
if (['default', 'dusk', 'phosphor'].includes(graphTheme ?? '')) setChoice(graphTheme as BuiltIn);
mount(SidebarWorkbench, { target: document.getElementById('app')! });
