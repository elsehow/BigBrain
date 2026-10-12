/** A lens scores a note with the claims the gardener drew from it
 * (lib/inclusionEvaluation.ts, lib/sharedRuleMentions.ts noteClaims). Every
 * name and note is invented. */
import {afterEach,expect,setSystemTime,test} from 'bun:test';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {appendAssertionEvent,assertionEntityId,createAssertionEvent} from '../lib/assertionLog';
import {appendSourceInsertionEvent,sourceInsertion} from '../lib/insertionLog';
import {saveJevKey} from '../lib/jevSettings';
import {lensNotes,scorePass} from '../lib/lensScoring';
import {CLAIMS_GUIDANCE} from '../lib/sharedJev';

const realFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=realFetch;setSystemTime();});

test("a note is scored with its claims and the entities they name; new claims score it again, a note without claims keeps its score",async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bb-inclusion-')),root=join(dir,'personal'),store=join(dir,'connections.json');
 try{
  mkdirSync(root);writeFileSync(join(root,'vault.yaml'),'integrations: {}\n');saveJevKey(store,'example-jev-key');
  const note=(id:string,title:string,body:string)=>{const s=sourceInsertion({id,title,from:'Example',from_kind:'person',source:'web',date:'2026-09-29'},body);appendSourceInsertionEvent(root,s);return s;};
  const walk=note('example-walk','Saturday','Walked the dog along the canal.'),groceries=note('example-groceries','Groceries','Apples and bread.');
  const kit={id:assertionEntityId('Kit Marlowe'),label:'Kit Marlowe'};
  const claim=(text:string,minute:number)=>appendAssertionEvent(root,createAssertionEvent({text,entities:[kit],sources:[walk.id],author:{kind:'model',id:'test',invocation_id:`run-${minute}`},confidence:'direct',
   created_at:`2026-09-29T12:0${minute}:00.000Z`,produced_by:{procedure:'test',version:'v1'}},new Map([[walk.id,walk]])));
  claim(`[[${kit.id}|Kit]] walked the dog along the canal.`,1);
  const sent:{state:{source:Record<string,unknown>};questions:{relevant:{instructions:{guidance?:string}}}}[]=[];
  globalThis.fetch=(async(_url:unknown,init?:RequestInit)=>{sent.push(JSON.parse(String(init!.body)));return Response.json({answers:{relevant:{noul:.9}}});}) as unknown as typeof fetch;
  const pass=()=>scorePass(root,store,{text:'Everything about Kit.',labels:[]},lensNotes(root));

  expect((await pass()).scores.size).toBe(2);
  const of=(title:string)=>sent.find(b=>b.state.source.title===title)!;
  expect(of('Saturday').state.source).toEqual({title:'Saturday',body:walk.body,claims:['Kit walked the dog along the canal.'],claim_entities:['Kit Marlowe']});
  expect(of('Saturday').questions.relevant.instructions.guidance).toBe(CLAIMS_GUIDANCE);
  expect(of('Groceries').state.source).toEqual({title:'Groceries',body:groceries.body});
  expect(of('Groceries').questions.relevant.instructions.guidance).toBeUndefined();

  await pass();expect(sent).toHaveLength(2);
  // the claims are read again after 30 seconds
  claim(`[[${kit.id}|Kit]] lost a glove by the canal.`,2);setSystemTime(Date.now()+31_000);
  sent.length=0;await pass();
  expect(sent.map(b=>b.state.source.title)).toEqual(['Saturday']);
  expect(sent[0]!.state.source.claims).toEqual(['Kit walked the dog along the canal.','Kit lost a glove by the canal.']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
