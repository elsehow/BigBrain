// Pilot conversation requests leave the page, where a browser test's
// page.route stands in for the engine. Everything else stays fabricated. The
// fake event stream is already connected, as after the engine's connect
// snapshot, and stays silent until the test dispatches `workbench-application`
// events in this epoch.
import { receiveApplicationChange } from '../lib/applicationUpdates';
export const PILOT_NETWORK_EPOCH = 'pilot-network';
export function installPilotNetworkFixture(network: typeof window.fetch) {
  const fabricated = window.fetch;
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
    return path === '/api/pilot/chat' || path.startsWith('/api/pilot/chat/') ? network(input, init) : fabricated(input, init);
  }) as typeof window.fetch;
  receiveApplicationChange({ epoch: PILOT_NETWORK_EPOCH, revision: 0, snapshot: true, entities: [] });
}
