/** Installation is local UI state. Account policies remain the source of access. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './fsx';
import { listTokens, tokenStorePath } from './auth';
import { INTEGRATIONS, integrationNamed } from './integrations';
import { policyPath } from './integrations/contract';
/** The browser extension is a client, not an integration: its card is listed here, the rest are declared. */
export const INTEGRATION_LIBRARY = [
  { id: 'browser', name: 'Browser extension', description: 'Save pages and highlights to your vault.' },
  ...INTEGRATIONS.flatMap(i => i.library ? [{ id: i.id, name: i.name, description: i.library.description }] : []),
];
export function hasAccountPolicy(root:string,name:string,account:string):boolean {
  return existsSync(policyPath(root,name,account));
}
function installed(root:string):string[] {
  try { const value=JSON.parse(readFileSync(join(root,'.spool','integration-library.json'),'utf8'));return Array.isArray(value)?value.filter(v=>typeof v==='string'):[]; } catch { return []; }
}
export function integrationLibrary(root:string) {
  const saved=installed(root);
  return INTEGRATION_LIBRARY.map(i=>{
    const unavailable=integrationNamed(i.id)?.credential.signIn?.unavailable?.(root);
    return {...i,added:saved.includes(i.id)||(i.id==='browser'
      ? listTokens(tokenStorePath(root)).some(t=>t.via==='pair')
      : !!integrationNamed(i.id)?.library?.added(root)),...(unavailable?{unavailable}:{})};
  });
}
export function addLibraryIntegration(root:string,id:string) {
  if(!INTEGRATION_LIBRARY.some(i=>i.id===id))throw Error('Choose an available integration.');
  writeAtomic(join(root,'.spool','integration-library.json'),JSON.stringify([...new Set([...installed(root),id])])+'\n',0o600);
}
