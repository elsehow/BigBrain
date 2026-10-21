import { selectedWorkspace } from './vaultScope';
export const sharedWorkspace = $state({ ready: !selectedWorkspace, error: '' });
let checking = false;
export async function checkSharedWorkspace(): Promise<void> {
  if (!selectedWorkspace || checking) return;
  checking = true;
  try {
    const response = await globalThis.fetch('/api/shared-identity', { headers: { 'x-bigbrain-workspace': selectedWorkspace }, cache: 'no-store', signal: AbortSignal.timeout(18000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Server unavailable.');
    // the server's copy answers here (lib/serverStore.ts); who you are on it is asked only to write
    Object.assign(sharedWorkspace, { ready: true, error: '' });
  } catch (e) { sharedWorkspace.ready = false; sharedWorkspace.error = (e as Error).message; } finally { checking = false; }
}
