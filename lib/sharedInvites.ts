/** Invitations are short-lived bootstrap secrets, distinct from device credentials.
 * Minted only by the host operator; the HTTP door can only redeem them. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeAtomic } from './fsx';
import { sha256hex } from './hash';
import { mintCredential, verifyCredential } from './sharedMembers';
export function sharedVaultIdentity(root:string) {
  const path=join(root,'.shared-identity.json');
  if(!existsSync(path))writeAtomic(path,JSON.stringify({id:randomUUID(),name:'Shared BigBrain'}),0o600);
  return JSON.parse(readFileSync(path,'utf8')) as {id:string;name:string;recommended_rules?:{id:string;text:string;mentions:string[]}[]};
}
type Invite={hash:string;token:string;expires:string;used?:boolean};
const read=(path:string):Invite[]=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):[];
export function issueSharedInvite(store:string,handle:string,endpoint:string,hours=24) {
  const url=new URL(endpoint);
  if(url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Invites require HTTPS');
  const secret=randomBytes(32).toString('base64url');
  const {token}=mintCredential(store,handle,{name:'Shared vault invitation'});
  const path=store+'.invites.json',items=read(path);
  items.push({hash:sha256hex(secret),token,expires:new Date(Date.now()+hours*3600000).toISOString()});
  writeAtomic(path,JSON.stringify(items),0o600);
  return `${url.origin}/invite#${secret}`;
}
export function redeemSharedInvite(store:string,secret:string,now=new Date()) {
  if(!/^[A-Za-z0-9_-]{43}$/.test(secret))return null;
  const path=store+'.invites.json',items=read(path),invite=items.find(i=>i.hash===sha256hex(secret));
  if(!invite||invite.used||Date.parse(invite.expires)<=now.getTime())return null;
  const verified=verifyCredential(store,invite.token);
  if(!verified.ok)return null;
  const token=invite.token;invite.used=true;invite.token='';writeAtomic(path,JSON.stringify(items),0o600);
  return {token,identity:verified.actor};
}
