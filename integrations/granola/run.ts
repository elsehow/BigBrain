/** Granola MCP poller: stage current meeting material for the worth gate.
 * A first connection starts now unless --since is given or Settings asks to
 * import earlier meetings; a reconnect resumes from the last poll. */
import {VAULT_ROOT} from '../../lib/vaultRoot';
import {integrationActive,integrationAccounts} from '../../lib/integrationAccess';
import {requireIntegrationEnabled} from '../../lib/integrationPoll';
import {withPollStatus} from '../../lib/integrationStatus';
import {pollGranolaMcp} from '../../lib/granolaMcpPoll';
import {flagValue} from '../../lib/cliflags';
requireIntegrationEnabled('granola',VAULT_ROOT);
await withPollStatus(VAULT_ROOT,'granola',async progress=>{
 let arrivals=0;const errors:unknown[]=[];
 for(const account of integrationAccounts(VAULT_ROOT,'granola')){
  if(!integrationActive(VAULT_ROOT,'granola',account))continue;
  try{progress('checking');arrivals+=(await pollGranolaMcp(VAULT_ROOT,account,{since:flagValue(process.argv,'since')})).arrivals;}catch(error){errors.push(error);}
 }
 if(errors.length)throw errors[0];return {arrivals};
});
