/** TypeSafe's documented Noul API. No fallback to another provider. */
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
export const JEV_MODEL='jev-1.13.0';
export function jevKey(store:string):string {
 const env=process.env.TYPESAFE_API_KEY;
 if(env)return env;
 const path=join(dirname(store),'.env');
 if(existsSync(path)){const match=/^TYPESAFE_API_KEY\s*=\s*(.+)$/m.exec(readFileSync(path,'utf8'));if(match)return match[1]!.trim().replace(/^['"]|['"]$/g,'');}
 throw Error('Set TYPESAFE_API_KEY beside the local shared-vault connection store to evaluate rules with Jev.');
}
export interface JevDecision {include:boolean;relevant:number;model:string;inputTokens:number}
export async function evaluateJev(key:string,rule:string,entities:unknown,source:{title:string;body:string},transport:typeof fetch=fetch):Promise<JevDecision> {
 // Conservative byte bound is also a token upper bound for UTF-8 byte tokenizers.
 // Long sources are evaluated in complete overlapping chunks, never truncated.
 const chars=[...source.body],chunks:string[]=[];let chunk='',bytes=0;
 for(const char of chars){const n=Buffer.byteLength(char);if(bytes+n>22000){chunks.push(chunk);chunk=chunk.slice(-500);bytes=Buffer.byteLength(chunk);}chunk+=char;bytes+=n;}chunks.push(chunk);
 let relevant=0,inputTokens=0;
 for(const body of chunks){let result:any;
  for(let attempt=0;attempt<4;attempt++){
   const response=await transport('https://api.typesafe.ai/v1/systemone',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(60000),body:JSON.stringify({model:JEV_MODEL,state:{source:{title:source.title,body},entities},questions:{
    relevant:{type:'noul',instructions:{question:'Does the source contain substantive material that meets the inclusion rule for its intended audience?',rule},criteria:{true:'Relevant material for the specified topic and audience. Audience means intended readers, not people who must be mentioned.',false:'Unrelated or merely a passing mention; insufficient evidence of relevance.'}}

   }})});
   if((response.status===429||response.status>=500)&&attempt<3){const wait=Math.min(15000,Math.max(1000,Number(response.headers.get('retry-after'))*1000||1000*2**attempt));await new Promise(r=>setTimeout(r,wait));continue;}
   if(!response.ok)throw Error(`Jev request failed (${response.status}); no sources were selected from this request.`);result=await response.json();break;
  }
  const yes=result?.answers?.relevant?.noul;
  if(typeof yes!=='number'||!Number.isFinite(yes)||yes<0||yes>1)throw Error('Jev returned an invalid decision');
  relevant=Math.max(relevant,yes);inputTokens+=Number(result.usage?.input_tokens)||0;
  if(relevant>=0.8)break;
 }
 return {include:relevant>=0.8,relevant,model:JEV_MODEL,inputTokens};
}
