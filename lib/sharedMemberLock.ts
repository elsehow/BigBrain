/** Serializes membership/invitation mutations across the server and operator CLI.
 * A SQLite lock (lib/sqliteLock.ts): a process killed mid-change frees it at once,
 * where the directory earlier versions took stayed until removed by hand. */
import {resolve} from 'node:path';
import {tryHold} from './sqliteLock';

export class SharedMemberBusyError extends Error {}
const active=new Set<string>();
export function withMemberLock<T>(store:string,fn:()=>T):T {
 const key=resolve(store);
 if(active.has(key))return fn(); // Synchronous nested membership operations only.
 const lock=tryHold(key+'.lock.sqlite',{retired:key+'.lock'});
 if(!lock)throw new SharedMemberBusyError('Membership is being updated. Please retry.');
 active.add(key);
 try{return fn();}finally{active.delete(key);lock.release();}
}
