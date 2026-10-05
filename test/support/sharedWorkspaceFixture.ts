import {accountPolicy,writeAccountPolicy,accountFingerprint} from '../../lib/integrationAccess';
import {addLibraryIntegration} from '../../lib/integrationLibrary';
/** Synthetic full-shell fixture. Secrets stay in its temporary directory. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { initMemberStore, addMember, mintCredential, revokeCredential } from '../../lib/sharedMembers';
import { makeSharedApiHandler } from '../../lib/sharedVaultApi';
import { SharedVault } from '../../lib/sharedVault';
import {issueSharedInvite} from '../../lib/sharedInvites';
import { saveConnection } from '../../lib/sharedConnections';
import {saveJevKey} from '../../lib/jevSettings';
import {inclusionEvaluator} from '../../lib/inclusionEvaluation';
import {readSourceInsertionLog} from '../../lib/insertionLog';
import {serializeMentions} from '../../lib/pilotMentions';
import {searchRuleEntities} from '../../lib/sharedRuleMentions';
import { appendSourceInsertionEvent, sourceInsertion } from '../../lib/insertionLog';
const home = mkdtempSync(join(tmpdir(), 'bb-shell-browser-')), personal = join(home,'personal'), shared = join(home,'shared'), members = join(home,'members.json'), connections = join(home,'connections.json');
for (const root of [personal,shared]) { mkdirSync(root); writeFileSync(join(root,'vault.yaml'),root===shared?'shared: true\n':'integrations: {}\n'); }
appendSourceInsertionEvent(personal, sourceInsertion({id:'example-private',title:'Personal sentinel',from:'Example owner',from_kind:'person',date:'2026-09-29',source:'web'}, 'Private fixture text only.'));
const owner = initMemberStore(members,shared,{handle:'owner',display:'Example Owner'});
addMember(members,{handle:'reader',permissions:['read']});
const reader = mintCredential(members,'reader',{name:'reader',kind:'person',scopes:['read']});
const vault = new SharedVault(shared);
let handler = makeSharedApiHandler({root:shared,storePath:members,vault,log:()=>{}});
const remote = Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>handler(request)});
const endpoint = `http://127.0.0.1:${remote.port}`;
// BB_FIXTURE_EMAIL_INVITES: the door also runs the Claude connector with a (never-called) Google client, so the app sees email invitations.
if(process.env.BB_FIXTURE_EMAIL_INVITES)handler=makeSharedApiHandler({root:shared,storePath:members,vault,log:()=>{},connector:{publicUrl:endpoint,google:{clientId:'fixture.apps.example.com',clientSecret:'fixture-secret'}}});
const post = (path:string,body:unknown) => handler(new Request(endpoint+path,{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'application/json'},body:JSON.stringify(body)}));
const source = await (await post('/v1/evidence',{title:'Shared launch decision',body:'The Example project will launch next week.'})).json() as {id:string};
await post('/v1/assertions',{text:'[[Example project]] will launch next week.',sources:[source.id]});
writeFileSync(join(shared,'.shared-identity.json'),JSON.stringify({id:'example-vault',name:'Example team',recommended_rules:[{id:'example-rule',text:'Sources that mention @Example project. Audience: project collaborators.',mentions:['Example project']}]}));
const personalStore=join(home,'personal-members.json'),personalOwner=initMemberStore(personalStore,personal,{handle:'owner'});
const ph=makeSharedApiHandler({root:personal,storePath:personalStore,log:()=>{}});
const pr=await ph(new Request('http://fixture/v1/evidence',{method:'POST',headers:{authorization:`Bearer ${personalOwner.token}`,'content-type':'application/json'},body:JSON.stringify({title:'Local project note',body:'A fabricated project design discussion.'})}));
const pe=await pr.json() as {id:string};await ph(new Request('http://fixture/v1/assertions',{method:'POST',headers:{authorization:`Bearer ${personalOwner.token}`,'content-type':'application/json'},body:JSON.stringify({text:'[[Example project]] has a local design note.',sources:[pe.id]})}));
for(let i=0;i<8;i++)appendSourceInsertionEvent(personal,sourceInsertion({id:'example-review-'+i,title:(i<4?'Include':'Exclude')+' Example project '+i,from:'Example owner',from_kind:'person',date:'2026-09-29',source:'web'},'Fabricated complete source about Example project.'));
saveJevKey(connections,'example-only-key');
const mention=serializeMentions([{mention:searchRuleEntities(personal,'Example project')[0]!}]);
writeFileSync(join(personal,'vault.yaml'),'integrations:\n  email:\n    inboxes:\n      - address: fixture@example.test\n        host: imap.example.test\n');
writeFileSync(join(personal,'.env'),'BIGBRAIN_IMAP_PASSWORD__FIXTURE_EXAMPLE_TEST=fabricated\n',{mode:0o600});
writeAccountPolicy(personal,'email','fixture@example.test',{...accountPolicy(personal,'email','fixture@example.test'),connected:true,fingerprint:accountFingerprint(personal,'email','fixture@example.test')});addLibraryIntegration(personal,'email');
const fetchOriginal=globalThis.fetch;
globalThis.fetch=(async(_input,init)=>{const request=JSON.parse(String(init?.body));return Response.json({answers:{relevant:{noul:request.state.source.title.startsWith('Include')?.94:.15}}});}) as typeof fetch;
async function prime(rule:string,rows:import('../../lib/inclusionPolicy').InclusionSource[]){
 for(const labels of [[],...rows.map(source=>[{source,include:source.title.startsWith('Include')}])])
  for(const row of rows)await inclusionEvaluator(personal,connections,rule,labels).score(row);
}
try{
 const rows=readSourceInsertionLog(personal).map(s=>({id:s.id,title:s.title,body:s.body,origin:'Personal'}));
 for(const rule of ['Sources that mention '+mention+'. Audience: project collaborators.','Sources about '+mention])await prime(rule,rows);
}finally{globalThis.fetch=fetchOriginal;}
const invite=issueSharedInvite(members,'owner',endpoint);
const readonly = await saveConnection(connections,{name:'Example read only',endpoint,token:reader.token});
const probe=createServer(); await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as {port:number}).port;await new Promise<void>(r=>probe.close(()=>r()));
const child = Bun.spawn(['bun','web/server.ts'],{env:{...process.env,BIGBRAIN_VAULT:personal,BIGBRAIN_WEB_PORT:String(port),BIGBRAIN_SHARED_CONNECTIONS:connections,PI_OFFLINE:'1',NODE_ENV:'test'},stdout:'ignore',stderr:'pipe'});
void new Response(child.stderr).text().then(log=>{if(log)process.stderr.write(log);});
void child.exited.then(code=>{if(code)console.error('Fixture web server exited with status '+code);});
const metadata = {invite,base:`http://127.0.0.1:${port}`,endpoint,token:owner.token,readonly:readonly.id,source:source.id,home};
writeFileSync(join(home,'browser.json'),JSON.stringify(metadata),{mode:0o600});
console.log(join(home,'browser.json'));
process.stdin.on('data',data=>{ if(data.toString().trim()==='revoke') revokeCredential(members,owner.credential.id); });
const close=()=>{child.kill();remote.stop(true);process.exit()};process.on('SIGTERM',close);process.on('SIGINT',close);
