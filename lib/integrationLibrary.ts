/** Installation is local UI state. Account policies remain the source of access. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeAtomic } from './fsx';
import { listTokens, tokenStorePath } from './auth';
import { readEnvValues } from './envFile';
import { emailConfig, isGmailInbox } from './emailConfig';
import { loadManifest } from './manifest';
import { extraAccounts } from './integrationAccess';
import { configuredFeeds } from './rssConfig';
export const INTEGRATION_LIBRARY = [
  { id: 'browser', name: 'Browser extension', description: 'Save pages and highlights to your vault.' },
  { id: 'email', name: 'Gmail', description: 'Connect your email for live access; new mail is remembered.' },
  { id: 'granola', name: 'Granola', description: 'Bring your meeting transcripts into your vault.' },
  { id: 'rss', name: 'RSS feeds', description: 'Follow news and blogs; what matters reaches your feed.' },
];
export function hasAccountPolicy(root:string,name:string,account:string):boolean {
  return existsSync(join(root,'.spool','integration-accounts',name,createHash('sha256').update(account).digest('hex')+'.json'));
}
function installed(root:string):string[] {
  try { const value=JSON.parse(readFileSync(join(root,'.spool','integration-library.json'),'utf8'));return Array.isArray(value)?value.filter(v=>typeof v==='string'):[]; } catch { return []; }
}
export function integrationLibrary(root:string) {
  const saved=installed(root);
  return INTEGRATION_LIBRARY.map(i=>({...i,added:saved.includes(i.id)||(i.id==='browser'
    ? listTokens(tokenStorePath(root)).some(t=>t.via==='pair')
    : i.id==='email' ? emailConfig(loadManifest(root).integrations.email).inboxes.some(isGmailInbox)
    : i.id==='rss' ? configuredFeeds(root).length>0
    : hasAccountPolicy(root,'granola','granola')||extraAccounts(root,'granola').length>0||!!readEnvValues(root).GRANOLA_API_KEY)}));
}
export function addLibraryIntegration(root:string,id:string) {
  if(!INTEGRATION_LIBRARY.some(i=>i.id===id))throw Error('Choose an available integration.');
  writeAtomic(join(root,'.spool','integration-library.json'),JSON.stringify([...new Set([...installed(root),id])])+'\n',0o600);
}
