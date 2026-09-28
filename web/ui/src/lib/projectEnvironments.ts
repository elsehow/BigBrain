import { vaultFetch } from './vaultScope';
export async function environmentRequest(route = '', body?: unknown) {
  const response = await vaultFetch('/api/agent-orchestration' + route, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Could not update the project environment.');
  return value;
}
