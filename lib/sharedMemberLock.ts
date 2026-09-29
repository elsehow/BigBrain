/** Serializes membership/invitation mutations across the server and operator CLI. */
import {mkdirSync,rmdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';

export class SharedMemberBusyError extends Error {}
const active=new Set<string>();
export function withMemberLock<T>(store:string,fn:()=>T):T {
 const key=resolve(store),lock=key+'.lock';
 if(active.has(key))return fn(); // Synchronous nested membership operations only.
 mkdirSync(dirname(key),{recursive:true,mode:0o700});
 try { mkdirSync(lock,{mode:0o700}); } catch { throw new SharedMemberBusyError('Membership is being updated. Please retry.'); }
 active.add(key);
 try{return fn();}finally{active.delete(key);rmdirSync(lock);}
}
