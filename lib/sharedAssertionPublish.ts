/** Publish the gardener's claims about contributed sources to a shared vault.
 *
 * An assertion goes up only while EVERY source it cites is an active
 * contribution of exactly the revision it cites, so a shared claim never
 * points at different text than it came from, nor at anything private. It is
 * posted by the member's agent credential, never in the member's own voice,
 * and retracted once that stops being true (a source withdrawn, the claim
 * revoked or superseded at home). A retracted claim stays retracted: the
 * shared log is append-only, and re-posting the same body answers with the
 * revoked id. Receipts live beside the connection credentials, outside both
 * vaults. */
import {existsSync,readFileSync} from 'node:fs';
import {writeAtomic} from './fsx';
import {ENTITY_LINK,ENT_ID,norm} from './ids';
import {assertionSourceReferences,type AssertionEvent,type AssertionSourceReference,type IdentityAssertion} from './assertionLog';
import {projectedSource,vaultRecord,withVaultSnapshot} from './vaultReadModel';
import {identitiesPublishableTo,liveOf,publishableTo,type Publishable,type PublishableIdentities} from './views/scope';
import {readConnections,sharedRequest,updateConnection,SharedConnectionError,type SharedConnection} from './sharedConnections';
import {contributions,sourceKey,type Contribution} from './sharedRules';
import {DEFAULT_CUTOFF} from './sourceCopies';

/** Writes per connection per tick: under the door's 60/min per credential. */
export const PUBLISH_BUDGET=25;
const RETRY_UNSUPPORTED_MS=60*60*1000;
const MAX_SOURCES=20;

export interface PublishedAssertion {connection:string;personal_assertion_id:string;shared_assertion_id:string;status:'published'|'retracted';at:string}
type Body={text:string;sources:string[];confidence:AssertionEvent['confidence']};
/** An identity as the door takes it (step 7): copy or not of a pair, or the entity a landing is. */
type IdentityBody={identity:{says:'copy'|'not-copy'}|{says:'is-source';entity:{label:string}};sources:string[]};
type Wanted={path:'/v1/assertions';body:Body}|{path:'/v1/identities';body:IdentityBody};

const readJson=<T>(path:string):T=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')) as T:{} as T;
export const publishedPath=(store:string)=>store+'.assertions.json';
const escapeRegExp=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const mentions=(haystack:string,label:string)=>new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(norm(label))}($|[^\\p{L}\\p{N}])`,'u').test(haystack);

/** The shared door's form of a personal claim. An entity keeps its label only
 * when the cited sources say it: the personal vault may have resolved "mom"
 * to a name the shared record never contained, and that resolution is not
 * the contributor's to publish. Otherwise the display text stands alone. */
export function publishableText(a:Pick<AssertionEvent,'text'|'entities'>,sourceText:string):string|null {
  const haystack=norm(sourceText);
  const text=a.text.replace(ENTITY_LINK,(_,target:string,display?:string)=>{
    const shown=display??target,label=ENT_ID.test(target)?a.entities.find(e=>e.id===target)?.label:target;
    if(!label||/[|[\]\n]/u.test(label)||!mentions(haystack,label))return shown;
    return norm(label)===norm(shown)?`[[${shown}]]`:`[[${label}|${shown}]]`;
  });
  return text.includes('\n')||text.length<12||text.length>2000?null:text;
}

/** Where a cited revision went on the server, or null when it is not an
 * active contribution of that exact revision. */
const sharedAs=(c:SharedConnection,active:Map<string,string>,sent:Record<string,{shared_insertion_id?:string}>)=>(ref:AssertionSourceReference):string|null=>{
  const shared=active.get('origin:'+sourceKey(ref));
  return shared&&sent[`${c.id}:${ref.insertion_id}`]?.shared_insertion_id===shared?shared:null;
};

/** The claims as the door takes them. Only Publishable ones: every source
 * each cites is shared there (lib/views/scope.ts publishableTo). */
function bodiesOf<S extends string>(root:string,claims:Publishable<S>,sharedId:(ref:AssertionSourceReference)=>string|null):Map<string,Body> {
  const out=new Map<string,Body>();
  for(const a of claims){
    const sources=[...new Set(assertionSourceReferences(a).map(ref=>sharedId(ref)!))].sort();
    if(sources.length>MAX_SOURCES)continue;
    const cited=assertionSourceReferences(a).map(ref=>projectedSource(root,ref.insertion_id));
    if(cited.some(s=>!s))continue;
    const text=publishableText(a,cited.map(s=>`${s!.title}\n${s!.body}`).join('\n'));
    if(text)out.set(a.id,{text,sources,confidence:a.confidence});
  }
  return out;
}

/** The identities as the server's door takes them: only Publishable ones,
 * every landing each cites shared there. */
function identityBodiesOf<S extends string>(claims:PublishableIdentities<S>,sharedId:(ref:AssertionSourceReference)=>string|null):Map<string,IdentityBody>{
  const out=new Map<string,IdentityBody>();
  for(const e of claims){
    const sources=e.sources.map(ref=>sharedId(ref)!);
    const said=e.identity;
    // a server takes a member's word: a model's judgment goes only once it clears the cut-off, as a copy
    if(said.says==='copy'&&(said.score===undefined||said.score>=DEFAULT_CUTOFF))out.set(e.id,{identity:{says:'copy'},sources});
    else if(said.says==='not-copy')out.set(e.id,{identity:{says:'not-copy'},sources});
    else if(said.says==='is-source')out.set(e.id,{identity:{says:'is-source',entity:{label:said.entity.label}},sources});
  }
  return out;
}

/** Your identity assertions that stand and cite sources: what a server may be told. */
function liveIdentities(root:string):IdentityAssertion[]{
  return withVaultSnapshot(root,db=>(db.query(`SELECT event_json FROM assertion_kinds k WHERE kind = 'identity'
    AND NOT EXISTS (SELECT 1 FROM retractions r WHERE r.retracts = k.id)`).all() as {event_json:string}[])
    .map(r=>JSON.parse(r.event_json) as IdentityAssertion).filter(e=>e.sources.length>0));
}

const unsupported=new Map<string,number>(),identitiesUnsupported=new Map<string,number>();
/** The member's agent delegate, minted once with their person credential. An
 * older door has no route for it (404), and a read-only member may not (403):
 * both simply leave this connection unpublished for a while. */
async function agentOf(store:string,c:SharedConnection):Promise<SharedConnection|null> {
  if(c.agentToken)return {...c,token:c.agentToken};
  if((unsupported.get(c.id)??0)>Date.now())return null;
  try{const {token}=await sharedRequest<{token:string}>(c,'/v1/credentials/agent',{});updateConnection(store,c.id,{agentToken:token});return {...c,token};}
  catch(e){if(e instanceof SharedConnectionError&&(e.status===404||e.status===403)){unsupported.set(c.id,Date.now()+RETRY_UNSUPPORTED_MS);return null;}throw e;}
}

/** Bring one connection's published claims in line with what is eligible now:
 * retractions first, then new claims, within the write budget. */
export async function publishAssertions(root:string,store:string,c:SharedConnection,contributed:Contribution[],budget=PUBLISH_BUDGET):Promise<{published:number;retracted:number}> {
  const done={published:0,retracted:0};
  const record=readJson<Record<string,PublishedAssertion>>(publishedPath(store));
  const published=Object.entries(record).filter(([,p])=>p.connection===c.id&&p.status==='published');
  // The server lists every contribution it holds, withdrawn ones too, so none
  // at all beside claims published there is a server that lost them, or a
  // reply misread: retracting on it would take every claim down for good.
  if(!contributed.length&&published.length)return done;
  const active=new Map(contributed.filter(x=>x.status==='active').map(x=>[x.source_id,x.insertion_id]));
  const sent=readJson<Record<string,{shared_insertion_id?:string}>>(store+'.receipts.json');
  const shared=sharedAs(c,active,sent);
  const wanted=new Map<string,Wanted>();
  if(active.size){
    for(const [id,body] of bodiesOf(root,publishableTo(liveOf(vaultRecord(root)),c.id,ref=>shared(ref)!==null),shared))wanted.set(id,{path:'/v1/assertions',body});
    if((identitiesUnsupported.get(c.id)??0)<=Date.now())
      for(const [id,body] of identityBodiesOf(identitiesPublishableTo(liveIdentities(root),c.id,ref=>shared(ref)!==null),shared))wanted.set(id,{path:'/v1/identities',body});
  }
  const stale=published.filter(([,p])=>!wanted.has(p.personal_assertion_id));
  const fresh=[...wanted].filter(([id])=>!record[`${c.id}:${id}`]);
  if(!stale.length&&!fresh.length)return done;
  const agent=await agentOf(store,c);if(!agent)return done;
  const save=(key:string,p:PublishedAssertion)=>{const latest=readJson<Record<string,PublishedAssertion>>(publishedPath(store));latest[key]=p;writeAtomic(publishedPath(store),JSON.stringify(latest),0o600);};
  try{
    for(const [key,p] of stale){
      if(done.published+done.retracted>=budget)return done;
      try{await sharedRequest(agent,`/v1/assertions/${p.shared_assertion_id}/retract`,{reason:'Its sources are no longer all shared by the contributor, or the contributor withdrew the claim.'});}
      catch(e){if(!(e instanceof SharedConnectionError&&e.status===409))throw e;} // already revoked: by its author, or moderated
      save(key,{...p,status:'retracted',at:new Date().toISOString()});done.retracted++;
    }
    for(const [id,{path,body}] of fresh){
      if(done.published+done.retracted>=budget)return done;
      let posted:{id:string};
      try{posted=await sharedRequest<{id:string}>(agent,path,body);}
      catch(e){
        // a server from before identity has no door for it: leave identity be there a while
        if(path==='/v1/identities'&&e instanceof SharedConnectionError&&e.status===404){identitiesUnsupported.set(c.id,Date.now()+RETRY_UNSUPPORTED_MS);continue;}
        throw e;
      }
      save(`${c.id}:${id}`,{connection:c.id,personal_assertion_id:id,shared_assertion_id:posted.id,status:'published',at:new Date().toISOString()});done.published++;
    }
  }catch(e){
    if(e instanceof SharedConnectionError&&e.status===401)updateConnection(store,c.id,{agentToken:undefined}); // revoked delegate: mint anew next tick
    else if(!(e instanceof SharedConnectionError&&e.status===429))throw e; // rate-limited: the next tick resumes
  }
  return done;
}

const locks=new Set<string>();
/** One pass over every connection (or one), beside the contribution tick. */
export async function tickPublishing(root:string,store:string,only?:string) {
  if(locks.has(store))return;locks.add(store);
  // Only a server's own vault (lib/lensSync.ts vaultOf) publishes to it: another vault holds none of its claims, and would retract them all.
  try{for(const c of readConnections(store)){if((only&&c.id!==only)||c.root!==root)continue;try{await publishAssertions(root,store,c,await contributions(c));}catch{/* unavailable or refused: the next tick retries */}}}
  finally{locks.delete(store);}
}
