// Pilot conversation requests leave the page, where a browser test's
// page.route stands in for the engine. Everything else stays fabricated. Like
// the engine, the fake event stream sends its connect snapshot on every
// connection, after the UI's first requests are already under way, and then
// stays silent until the test dispatches `workbench-application` events in
// this epoch.
export const PILOT_NETWORK_EPOCH = 'pilot-network';
export function installPilotNetworkFixture(network: typeof window.fetch) {
  const fabricated = window.fetch;
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
    return path === '/api/pilot/chat' || path.startsWith('/api/pilot/chat/') ? network(input, init) : fabricated(input, init);
  }) as typeof window.fetch;
  const Stream = window.EventSource;
  window.EventSource = class extends Stream {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      setTimeout(() => window.dispatchEvent(new CustomEvent('workbench-application', { detail: { epoch: PILOT_NETWORK_EPOCH, revision: 0, snapshot: true, entities: [] } })), 0);
    }
  };
}
