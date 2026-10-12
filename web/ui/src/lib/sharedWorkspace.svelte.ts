import { selectedWorkspace } from './vaultScope';
export const sharedWorkspace = $state({ ready: !selectedWorkspace, error: '', name: '', handle: '', display: '', role: '', writable: false });
let checking = false;
export async function checkSharedWorkspace(): Promise<void> {
  if (!selectedWorkspace || checking) return;
  checking = true;
  try {
    const response = await globalThis.fetch('/api/shared-identity', { headers: { 'x-bigbrain-workspace': selectedWorkspace }, cache: 'no-store', signal: AbortSignal.timeout(18000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Server unavailable.');
    Object.assign(sharedWorkspace, { ready: true, error: '', name: data.name, handle: data.identity.handle, display: data.identity.display || data.identity.handle, role: data.identity.role, writable: data.identity.permissions.includes('write') });
  } catch (e) { sharedWorkspace.ready = false; sharedWorkspace.error = (e as Error).message; } finally { checking = false; }
}
