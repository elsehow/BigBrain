import {withMemberLock} from './sharedMemberLock';
/** Invitations are short-lived bootstrap secrets, distinct from device credentials.
 * Owner-created invitations create distinct identities on redemption. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeAtomic } from './fsx';
import { sha256hex } from './hash';
import { addMember, listMembers, mintCredential, verifyCredential, revokeCredential, type SharedActor, type SharedMember } from './sharedMembers';
export function sharedVaultIdentity(root:string) {
  const path=join(root,'.shared-identity.json');
  if(!existsSync(path))writeAtomic(path,JSON.stringify({id:randomUUID(),name:'Shared BigBrain'}),0o600);
  return JSON.parse(readFileSync(path,'utf8')) as {id:string;name:string;recommended_rules?:{id:string;text:string;mentions:string[]}[]};
}
/** Three kinds share one file: legacy handle-bound invites (`token` pre-minted),
 * owner-created invites (`id`, `display`, `permission`: a new member on use), and
 * app links (`member`: a handle that EXISTS, from the connector's personal page). */
type Invite={hash:string;token:string;expires:string;used?:boolean;id?:string;secret?:string;display?:string;permission?:'read'|'write';cancelled?:boolean;member?:string};
const read=(path:string):Invite[]=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):[];
function issueSharedInviteLocked(store:string,handle:string,endpoint:string,hours=24) {
  const url=new URL(endpoint);
  if(url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Invites require HTTPS');
  const secret=randomBytes(32).toString('base64url');
  const {token}=mintCredential(store,handle,{name:'Shared vault invitation'});
  const path=store+'.invites.json',items=read(path);
  items.push({hash:sha256hex(secret),token,expires:new Date(Date.now()+hours*3600000).toISOString()});
  writeAtomic(path,JSON.stringify(items),0o600);
  return `${url.origin}/invite#${secret}`;
}
type Consumed={kind:'member';member:SharedMember}|{kind:'existing';member:SharedMember}|{kind:'legacy';token:string;actor:SharedActor};
/** Consume an invitation and say whom it names, minting nothing: an owner-created
 * invitation becomes its new member here; a legacy handle-bound one hands back the
 * credential minted when it was issued. Shared by redemption and the connector's
 * invite-link sign-in (lib/sharedOAuth.ts). */
function consumeInviteLocked(store:string,secret:string,now:Date):Consumed|null {
  if(!/^[A-Za-z0-9_-]{43}$/.test(secret))return null;
  const path=store+'.invites.json',items=read(path),invite=items.find(i=>i.hash===sha256hex(secret));
  if(!invite||invite.used||invite.cancelled||Date.parse(invite.expires)<=now.getTime())return null;
  if(invite.member) {
    const member=listMembers(store).find(m=>m.handle===invite.member&&!m.revoked);
    invite.used=true;writeAtomic(path,JSON.stringify(items),0o600);
    return member?{kind:'existing',member}:null;
  }
  if(invite.display && invite.permission && invite.id) {
    // Consume before minting: a crash can burn a link, never redeem it twice.
    invite.used=true;delete invite.secret;writeAtomic(path,JSON.stringify(items),0o600);
    return {kind:'member',member:addMember(store,{handle:'invite-'+invite.id,display:invite.display,permissions:invite.permission==='write'?['read','write']:['read']})};
  }
  const verified=verifyCredential(store,invite.token);
  if(!verified.ok)return null;
  const token=invite.token;invite.used=true;invite.token='';writeAtomic(path,JSON.stringify(items),0o600);
  return {kind:'legacy',token,actor:verified.actor};
}
function redeemSharedInviteLocked(store:string,secret:string,now=new Date()) {
  const consumed=consumeInviteLocked(store,secret,now);
  if(!consumed)return null;
  if(consumed.kind==='legacy')return {token:consumed.token,identity:consumed.actor};
  // Full member-following scope allows a later owner upgrade to take effect —
  // for a new member and for an app link alike.
  const {token}=mintCredential(store,consumed.member.handle,{name:'BigBrain',followsMember:true});
  const verified=verifyCredential(store,token);
  return verified.ok?{token,identity:verified.actor}:null;
}
/** The connector's sign-in by invite link: the same single-use consumption, but no
 * person credential survives it — a legacy invitation's pre-minted one is revoked. */
function identifyBySharedInviteLocked(store:string,secret:string,now=new Date()):SharedMember|null {
  const consumed=consumeInviteLocked(store,secret,now);
  if(!consumed)return null;
  if(consumed.kind!=='legacy')return consumed.member;
  revokeCredential(store,consumed.actor.credential_id,now);
  return listMembers(store).find(m=>m.id===consumed.actor.member_id&&!m.revoked)??null;
}

export const issueSharedInvite=(...args:Parameters<typeof issueSharedInviteLocked>)=>withMemberLock(args[0],()=>issueSharedInviteLocked(...args));
export const redeemSharedInvite=(...args:Parameters<typeof redeemSharedInviteLocked>)=>withMemberLock(args[0],()=>redeemSharedInviteLocked(...args));
export const identifyBySharedInvite=(...args:Parameters<typeof identifyBySharedInviteLocked>)=>withMemberLock(args[0],()=>identifyBySharedInviteLocked(...args));
export function createMemberInvite(store:string,display:string,permission:'read'|'write',now=new Date()) {
 return withMemberLock(store,()=>{
  const secret=randomBytes(32).toString('base64url'),id=randomBytes(12).toString('hex');
  const path=store+'.invites.json',items=read(path);
  const invite:Invite={id,hash:sha256hex(secret),secret,token:'',display,permission,expires:new Date(now.getTime()+86400000).toISOString()};
  items.push(invite);writeAtomic(path,JSON.stringify(items),0o600);
  return {id,secret,display,permission,expires:invite.expires};
 });
}
/** An app link for an EXISTING member (the connector's personal page, lib/sharedOAuth.ts):
 * single use, one hour, redeemed by the app through `POST /v1/invites/redeem` like any
 * invite. Nothing is minted until then. Spent and expired app links are pruned here. */
export function createAppLink(store:string,handle:string,now=new Date()) {
 return withMemberLock(store,()=>{
  const secret=randomBytes(32).toString('base64url');
  const path=store+'.invites.json',items=read(path).filter(i=>!i.member||(!i.used&&Date.parse(i.expires)>now.getTime()));
  const expires=new Date(now.getTime()+3600000).toISOString();
  items.push({hash:sha256hex(secret),token:'',member:handle,expires});writeAtomic(path,JSON.stringify(items),0o600);
  return {secret,expires};
 });
}
/** Would this secret redeem now? Reads only — nothing is consumed or minted.
 * Lets the page an opened invite link shows name the vault to the link's
 * holder, and no one else (lib/sharedOAuth.ts). */
export function sharedInviteIsLive(store:string,secret:string,now=new Date()):boolean {
  if(!/^[A-Za-z0-9_-]{43}$/.test(secret))return false;
  const invite=read(store+'.invites.json').find(i=>i.hash===sha256hex(secret));
  if(!invite||invite.used||invite.cancelled||Date.parse(invite.expires)<=now.getTime())return false;
  if(invite.member)return listMembers(store).some(m=>m.handle===invite.member&&!m.revoked);
  if(invite.display&&invite.permission&&invite.id)return true;
  return verifyCredential(store,invite.token).ok;
}
export function pendingMemberInvites(store:string,now=new Date()) {
 return read(store+'.invites.json').filter(i=>i.id&&!i.used&&!i.cancelled&&Date.parse(i.expires)>now.getTime()).map(i=>({id:i.id!,secret:i.secret!,display:i.display!,permission:i.permission!,expires:i.expires}));
}
export function cancelMemberInvite(store:string,id:string) {
 return withMemberLock(store,()=>{
  const path=store+'.invites.json',items=read(path),invite=items.find(i=>i.id===id);
  if(!invite||invite.used)return false;
  invite.cancelled=true;delete invite.secret;
  if(invite.token){const verified=verifyCredential(store,invite.token);if(verified.ok)revokeCredential(store,verified.actor.credential_id);invite.token='';}
  writeAtomic(path,JSON.stringify(items),0o600);return true;
 });
}
