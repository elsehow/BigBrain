import { integrationActive, integrationAccounts, integrationAccountKey } from "../../lib/integrationAccess";
import { stageIntegrationContent } from "../../lib/integrationStage";
/** Opt-in, read-only history and change capture. Never access a credential
 * or the network when disabled; curation happens after every event lands. */
import { VAULT_ROOT } from "../../lib/vaultRoot";
import { requireIntegrationEnabled } from "../../lib/integrationPoll";
import { PollError, withPollStatus } from "../../lib/integrationStatus";
import { pollThatTracks } from "../../lib/thatTracks";

requireIntegrationEnabled("that-tracks", VAULT_ROOT);
await withPollStatus(VAULT_ROOT, "that-tracks", async (progress) => {
  let arrivals=0;const failures:unknown[]=[];
  for(const account of integrationAccounts(VAULT_ROOT,"that-tracks")){
  if(!integrationActive(VAULT_ROOT,"that-tracks",account))continue;
  try {
  const key = integrationAccountKey(VAULT_ROOT,"that-tracks",account);
  if (!key) throw new PollError("Add a That Tracks API key in Integrations", "credentials");
  const result = await pollThatTracks(VAULT_ROOT, key, { progress, ...(account!=="that-tracks"?{accountInstance:account}:{}), authorize: () => { if (!integrationActive(VAULT_ROOT, "that-tracks",account)) throw new PollError("That Tracks became inactive; polling stopped."); }, stage: content => stageIntegrationContent(VAULT_ROOT, "that-tracks", content,account) });
  console.log(`that-tracks: ${result.arrivals} revision(s) staged`);
  arrivals+=result.arrivals;
  }catch(error){failures.push(error);}
  }
  if(failures.length)throw failures[0];
  return {arrivals};
});
