import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SharedVault } from '../lib/sharedVault';
import { initMemberStore, verifyCredential } from '../lib/sharedMembers';

test('a prepared correction finishes after restart, without losing actor or adding duplicate feed entries', () => {
  const home=mkdtempSync(join(tmpdir(),'shared-recover-')),root=join(home,'vault'),store=join(home,'members.json');mkdirSync(root);
  const owner=initMemberStore(store,root,{handle:'owner'}), verified=verifyCredential(store,owner.token);
  if(!verified.ok)throw Error('credential');
  let vault=new SharedVault(root);
  const e=vault.dropEvidence(verified.actor,{title:'Example decision',body:'The experiment has three phases.'});
  const a=vault.assert(verified.actor,{text:'The experiment has two phases.',sources:[e.insertion.id]});
  const input={text:'The experiment has three phases.',sources:[e.insertion.id],reason:'Corrected the count'};
  const c=vault.correct(verified.actor,a.assertion.id,input);
  const all=vault.feed(0,200).entries;
  const prepared=all.slice(-2).map(({seq:_seq,...feed})=>({feed,event:JSON.parse(readFileSync(join(root,feed.path),'utf8'))}));
  // A crash after the new assertion landed but before its feed/revocation.
  writeFileSync(join(root,'.spool/shared-write.json'),JSON.stringify(prepared));
  rmSync(join(root,prepared[1]!.feed.path));
  writeFileSync(join(root,'log/shared-feed/feed.ndjson'),all.slice(0,2).map(x=>JSON.stringify(x)+'\n').join(''));
  vault=new SharedVault(root);vault.recoverPending();
  expect(vault.assertion(a.assertion.id)?.resolved_id).toBe(c.assertion.id);
  expect(vault.feed(0,200).entries).toEqual(all);
  expect(vault.missingFromFeed()).toEqual([]);
  expect(existsSync(join(root,'.spool/shared-write.json'))).toBe(false);
  expect(vault.correct(verified.actor,a.assertion.id,input)).toMatchObject({deduped:true,seq:c.seq});
  const r=vault.retract(verified.actor,c.assertion.id,{reason:'Withdrawn'});
  expect(vault.retract(verified.actor,c.assertion.id,{reason:'Withdrawn'})).toMatchObject({deduped:true,seq:r.seq});
  expect(()=>vault.correct(verified.actor,a.assertion.id,{...input,text:'A different change after retirement.'})).toThrow('already revoked');
});
