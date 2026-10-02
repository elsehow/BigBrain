import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assertionEntityId} from '../lib/assertionLog';
import {searchRuleEntities,resolveRuleMentions,ruleCandidateFilter} from '../lib/sharedRuleMentions';
import {serializeMentions,parseMentions} from '../lib/pilotMentions';
import {initMemberStore,verifyCredential} from '../lib/sharedMembers';
import {SharedVault} from '../lib/sharedVault';
test('inclusion mentions resolve IDs, reject forged entities, and retain literal/linked source candidates',()=>{
 const base=mkdtempSync(join(tmpdir(),'rule-entities-')),root=join(base,'vault');mkdirSync(root);const store=join(base,'members.json'),owner=initMemberStore(store,root,{handle:'owner'}),v=verifyCredential(store,owner.token);if(!v.ok)throw Error('auth');const vault=new SharedVault(root);
 const e=vault.dropEvidence(v.actor,{title:'Planning note',body:'The system needs a settings panel.'}).insertion;
 vault.assert(v.actor,{text:'[[Example project]] needs a settings panel.',sources:[e.id]});
 const items=searchRuleEntities(root,'Example');expect(items).toHaveLength(1);expect(items[0]!.id).toBe(`projection/entities/${assertionEntityId('Example project')}.md`);
 const text=serializeMentions([{text:'Sources that mention '},{mention:items[0]!},{text:'. Audience: collaborators.'}]);expect(resolveRuleMentions(root,text)[0]!.title).toBe('Example project');expect(parseMentions(text).length).toBe(3);expect(ruleCandidateFilter(root,text)(e)).toBe(true);
 expect(()=>resolveRuleMentions(root,'Sources about @Unknown')).toThrow();expect(()=>resolveRuleMentions(root,'[[projection/entities/ent_deadbeef.md|Fake]]')).toThrow();
 // No rules or publishing follow merely from reading entity suggestions.
 expect(vault.listEvidence({limit:10}).items).toHaveLength(1);
 writeFileSync(join(root,'vault.yaml'),'integrations: {}\n');
});
