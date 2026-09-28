/** In-process hints for appenders and readers. Durable state lives in the logs. */
const changes = new Map<string, number>();
export const vaultChangeVersion = (root: string): number => changes.get(root) ?? 0;
export function markVaultChanged(root: string): void { changes.set(root, vaultChangeVersion(root) + 1); }
