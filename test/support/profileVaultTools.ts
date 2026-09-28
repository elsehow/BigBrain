/** Instrument shared operations, including maintenance tools absent from public MCP. */
import { VAULT_TOOLS, type VaultToolDef } from '../../lib/vaultTools';

export function instrumentVaultTools(
  wrap: (tool: VaultToolDef, handler: VaultToolDef['handler']) => VaultToolDef['handler'],
): () => void {
  const originals = VAULT_TOOLS.map(tool => tool.handler);
  VAULT_TOOLS.forEach((tool, index) => { tool.handler = wrap(tool, originals[index]!); });
  return () => { VAULT_TOOLS.forEach((tool, index) => { tool.handler = originals[index]!; }); };
}
