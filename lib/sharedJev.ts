/** TypeSafe's documented Noul API. No fallback to another provider. */
import {optionalJevKey} from './jevSettings';
export const JEV_MODEL='jev-1.13.0';
export function jevKey(store:string):string {
 const key=optionalJevKey(store);if(!key)throw Error('Add a Jev API key in model settings.');return key;
}
export interface JevDecision {include:boolean;relevant:number;model:string;inputTokens:number}
export async function evaluateJev(key:string,rule:string,entities:unknown,source:{title:string;body:string},transport:typeof fetch=fetch):Promise<JevDecision> {
 // Evaluate the complete source once. Provider size errors fail closed; never
 // turn a matching fragment into permission to share the whole source.
 let result:any;
  for(let attempt=0;attempt<4;attempt++){
   const response=await transport('https://api.typesafe.ai/v1/systemone',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(60000),body:JSON.stringify({model:JEV_MODEL,state:{source:{title:source.title,body:source.body},entities},questions:{
    relevant:{type:'noul',instructions:{question:'Does this meet the inclusion rule?',rule},criteria:{true:'Meets the inclusion rule.',false:'Does not meet the inclusion rule.'}}

   }})});
   if((response.status===429||response.status>=500)&&attempt<3){const wait=Math.min(15000,Math.max(1000,Number(response.headers.get('retry-after'))*1000||1000*2**attempt));await new Promise(r=>setTimeout(r,wait));continue;}
   if(!response.ok)throw Error(`Jev request failed (${response.status}); no sources were selected from this request.`);result=await response.json();break;
  }
  const yes=result?.answers?.relevant?.noul;
  if(typeof yes!=='number'||!Number.isFinite(yes)||yes<0||yes>1)throw Error('Jev returned an invalid decision');
 return {include:yes>=0.8,relevant:yes,model:JEV_MODEL,inputTokens:Number(result.usage?.input_tokens)||0};
}
