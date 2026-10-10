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
import {assertionSourceReferences,type AssertionEvent} from './assertionLog';
import {projectedSource} from './vaultReadModel';
import {readMemoryInputs} from './memoryInputs';
import {readConnections,sharedRequest,updateConnection,SharedConnectionError,type SharedConnection} from './sharedConnections';
import {contributions,sourceKey,type Contribution} from './sharedRules';

/** Writes per connection per tick: under the door's 60/min per credential. */
export const PUBLISH_BUDGET=25;
const RETRY_UNSUPPORTED_MS=60*60*1000;
const MAX_SOURCES=20;

export interface PublishedAssertion {connection:string;personal_assertion_id:string;shared_assertion_id:string;status:'published'|'retracted';at:string}
type Body={text:string;sources:string[];confidence:AssertionEvent['confidence']};

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

/** Where each cited revision went, or null when any of them is not an active
 * contribution of that exact revision. */
function sharedSources(c:SharedConnection,a:AssertionEvent,active:Map<string,string>,sent:Record<string,{shared_insertion_id?:string}>):string[]|null {
  const refs=assertionSourceReferences(a);
  const ids=refs.map(ref=>{const shared=active.get('origin:'+sourceKey(ref));return shared&&sent[`${c.id}:${ref.insertion_id}`]?.shared_insertion_id===shared?shared:null;});
  const unique=[...new Set(ids)].sort();
  return ids.length&&!ids.includes(null)&&unique.length<=MAX_SOURCES?unique as string[]:null;
}

function publishable(root:string,c:SharedConnection,a:AssertionEvent,active:Map<string,string>,sent:Record<string,{shared_insertion_id?:string}>):Body|null {
  const sources=sharedSources(c,a,active,sent);if(!sources)return null;
  const cited=assertionSourceReferences(a).map(ref=>projectedSource(root,ref.insertion_id));
  if(cited.some(s=>!s))return null;
  const text=publishableText(a,cited.map(s=>`${s!.title}\n${s!.body}`).join('\n'));
  return text?{text,sources,confidence:a.confidence}:null;
}

const unsupported=new Map<string,number>();
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
  const active=new Map(contributed.filter(x=>x.status==='active').map(x=>[x.source_id,x.insertion_id]));
  const sent=readJson<Record<string,{shared_insertion_id?:string}>>(store+'.receipts.json');
  const wanted=new Map<string,Body>();
  if(active.size)for(const a of readMemoryInputs(root).asts){const body=publishable(root,c,a,active,sent);if(body)wanted.set(a.id,body);}
  const record=readJson<Record<string,PublishedAssertion>>(publishedPath(store));
  const stale=Object.entries(record).filter(([,p])=>p.connection===c.id&&p.status==='published'&&!wanted.has(p.personal_assertion_id));
  const fresh=[...wanted].filter(([id])=>!record[`${c.id}:${id}`]);
  const done={published:0,retracted:0};
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
    for(const [id,body] of fresh){
      if(done.published+done.retracted>=budget)return done;
      const posted=await sharedRequest<{id:string}>(agent,'/v1/assertions',body);
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
