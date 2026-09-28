/** Read-only OAuth account observations, using the exact Pi subscription token.
 * Compatibility endpoints verified against the provider; unavailable is normal. */
import { sha256hex } from '../hash';
import { quotaJson } from './quotaHttp';
import type { QuotaSample } from './monitorTypes';
export interface AnthropicQuota {
  account(token:string,signal:AbortSignal):Promise<string|undefined>;
  read(token:string,signal:AbortSignal):Promise<QuotaSample[]>;
}
export function anthropicWindows(value:any):QuotaSample[]{
  const out:QuotaSample[]=[];
  for(const window of ['five_hour','seven_day','seven_day_opus','seven_day_sonnet','seven_day_oauth_apps']){
    const w=value?.[window];
    if(typeof w?.utilization!=='number'||!Number.isFinite(w.utilization)||w.utilization<0||w.utilization>100||typeof w.resets_at!=='string'||!Number.isFinite(Date.parse(w.resets_at)))continue;
    out.push({kind:'quota',window,used:w.utilization/100,resetsAt:new Date(w.resets_at).toISOString()});
  }
  return out;
}
export function createAnthropicQuota(request:typeof fetch=fetch):AnthropicQuota{
  // Token hashes are only cache keys; account UUID + organization identify readings.
  const cache=new Map<string,{expires:number,value:Promise<any>}>();
  const read=async(token:string,path:string,signal:AbortSignal)=>{
    // Only the provider's subscription-token format is eligible for these endpoints.
    if(signal.aborted || !token.startsWith("sk-ant-oat"))return undefined;
    const key=sha256hex(`${path}:${token}`),prior=cache.get(key);
    if(prior&&prior.expires>Date.now())return prior.value;
    if(cache.size>=64)cache.delete(cache.keys().next().value!);
    const value=quotaJson(`https://api.anthropic.com/api/oauth/${path}`,{Authorization:`Bearer ${token}`,'anthropic-beta':'oauth-2025-04-20'},signal,request).then(body => ({ body, at: new Date().toISOString() }));
    cache.set(key,{expires:Date.now()+(path==='profile'?300000:60000),value});return value;
  };
  const account=async(token:string,signal:AbortSignal)=>{
    const profile=(await read(token,'profile',signal))?.body;
    const id=profile?.account?.uuid,organization=profile?.organization?.uuid;
    return typeof id==='string'&&id&&typeof organization==='string'&&organization?sha256hex(`anthropic:${id}:${organization}`):undefined;
  };
  return {account,read:async(token,signal)=>{
    const accountId=await account(token,signal);if(!accountId)return [];
    // Cache retains the observation timestamp: reused data must never look fresh.
    const result=await read(token,'usage',signal);
    if(!result?.body)return [];
    return anthropicWindows(result.body).map(q=>({...q,accountId,at:result.at}));
  }};
}
export const anthropicQuota=createAnthropicQuota();
