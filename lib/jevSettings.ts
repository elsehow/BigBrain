/** Optional local model-service credentials. Never part of a vault or browser state. */
import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {writeAtomic} from './fsx';
const file=(store:string)=>join(dirname(store),'jev-settings.json');
export function optionalJevKey(store:string):string|undefined {
 // An explicit removal overrides legacy environment configuration too.
 if(existsSync(file(store)))return (JSON.parse(readFileSync(file(store),'utf8')) as {apiKey:string|null}).apiKey??undefined;
 if(process.env.TYPESAFE_API_KEY?.trim())return process.env.TYPESAFE_API_KEY.trim();
 const env=join(dirname(store),'.env');
 if(existsSync(env)){const match=/^TYPESAFE_API_KEY\s*=\s*(.+)$/m.exec(readFileSync(env,'utf8'));const key=match?.[1]?.trim().replace(/^['"]|['"]$/g,'');if(key)return key;}
 return undefined;
}
export function saveJevKey(store:string,key:string|null) {
 if(key!==null&&(typeof key!=='string'||!key.trim()||key.length>8192||/[\r\n]/.test(key)))throw Error('Enter a valid Jev API key.');
 mkdirSync(dirname(store),{recursive:true,mode:0o700});
 writeAtomic(file(store),JSON.stringify({apiKey:key?.trim()??null})+'\n',0o600);
}
export const jevSettingsStatus=(store:string)=>({configured:!!optionalJevKey(store),evaluator:optionalJevKey(store)?'jev':'quick'});
