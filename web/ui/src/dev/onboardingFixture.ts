// Browser-only state for the production AppShell. No filesystem or provider calls.
import type { SetupState } from '../lib/setup';
import type { TelemetrySnapshot } from '../lib/telemetry';
export const onboardingPreviewKey = 'bb-preview-onboarding-v1';
export function installOnboardingFixture() {
  const mode = new URLSearchParams(location.search).get('onboarding');
  const ready = mode !== 'start';
  const setup: SetupState = {
    onboarding: mode === 'existing' ? undefined : mode === 'analytics' ? 'analytics' : ready ? 'integrations' : 'vault',
    vault: ready ? { path: '/synthetic/vault', created: null } : null,
    identity: ready ? { name: 'Sample', entity_id: 'sample' } : null,
    suggested: '/synthetic/vault', claude: { installed: 'preview', account: 'Sample', connected: ready }, agent: null,
    anthropic: { connected: ready, phase: ready ? 'connected' : 'idle' },
    chatgpt: { connected: false, phase: 'idle' },
  };
  let state = { setup, metrics: { enabled: mode === 'enabled', decided: ['enabled', 'declined'].includes(mode ?? ''), configured: mode !== 'unconfigured', samples: [], operations: {}, actions: {}, queued: 0, delivery: 'idle' } as TelemetrySnapshot };
  try { const saved = localStorage.getItem(onboardingPreviewKey); if (saved) state = JSON.parse(saved); } catch { /* fresh preview */ }
  const save = () => localStorage.setItem(onboardingPreviewKey, JSON.stringify(state));
  const previous = window.fetch;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.origin !== location.origin) return json({ error: 'External requests disabled in onboarding preview' }, 403);
    const data = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const path = url.pathname;
    if (path === '/api/telemetry') {
      if (typeof data.enabled === 'boolean') { state.metrics = { ...state.metrics, enabled: data.enabled, decided: true, queued: 0 }; save(); }
      return json(state.metrics);
    }
    if (path === '/api/setup/vault') { state.setup.vault = { path: '/synthetic/vault', created: null }; save(); }
    if (path === '/api/setup/identity') { state.setup.identity = { name: data.name, entity_id: 'sample' }; save(); }
    if (path === '/api/setup/anthropic/login') { state.setup.anthropic = { connected: true, phase: 'connected' }; save(); return json(state.setup.anthropic); }
    if (path === '/api/setup/chatgpt/login') { state.setup.chatgpt = { connected: true, phase: 'connected' }; save(); return json(state.setup.chatgpt); }
    if (path === '/api/setup/progress') { state.setup.onboarding = data.step; save(); }
    if (path === '/api/setup' || ['/api/setup/vault', '/api/setup/identity', '/api/setup/connect', '/api/setup/progress'].includes(path)) return json(state.setup);
    if (path === '/api/connected-clients') return json({ clients: [], local: [] });
    if (path === '/api/integration-accounts') return json({ library: [], accounts: [] });
    return previous(input, init);
  }) as typeof fetch;
}
