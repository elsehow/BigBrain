/** Local-only benchmark against an explicitly marked disposable snapshot.
 * bun test/support/profileVaultScale.ts <snapshot-root> <private-selection-json>
 * Outputs counts/timings only. Its model seam cannot make inference requests. */
import { existsSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { performance } from "node:perf_hooks";
import { primaryGraphCached, graphWithLayout } from "../../lib/graphCache";
import { assertionEntityView } from "../../lib/assertionEntityView";
import { noteBriefingInput, briefingPrompt, createNoteBriefingService } from "../../lib/noteBriefing";
import { syncAssertionProjection } from "../../lib/assertionProjection";
import { scanSurface } from "../../lib/searchCore";
import { sha256hex } from "../../lib/hash";
import { isUserNode } from "../../lib/userNote";
const [root, selectionFile] = process.argv.slice(2);
if (!root || !selectionFile || !basename(root).startsWith("bb-vault-scale-") || !existsSync(join(root,".benchmark-snapshot"))) throw new Error("Marked disposable snapshot required");
if (process.env.BIGBRAIN_ASSERTION_DB || process.env.BIGBRAIN_SEARCH_DB) throw new Error("Remove external database overrides");
const started=performance.now();
const sync=syncAssertionProjection(root);
console.log(JSON.stringify({stage:"projection-sync",ms:performance.now()-started,counts:sync}));
let begin=performance.now(); const graph=primaryGraphCached(root);
console.log(JSON.stringify({stage:"graph-build",ms:performance.now()-begin,nodes:graph.nodes.length,edges:graph.edges.length}));
begin=performance.now();graphWithLayout(root,graph);
console.log(JSON.stringify({stage:"graph-layout",ms:performance.now()-begin}));
const entities=graph.nodes.filter(n=>n.entity&&n.path&&!isUserNode(n,graph.userNote)).sort((a,b)=>b.degree-a.degree);
const cached=entities.find(n=>existsSync(join(root,".state","note-briefings",`${sha256hex(JSON.stringify([[n.id],[],undefined]))}.json`)));
const samples=[{label:"dense-entity",node:entities[0]!},{label:"typical-entity",node:entities[Math.floor(entities.length/2)]!},...(cached&&cached.id!==entities[0]!.id?[{label:"previously-cached-entity",node:cached}]:[])];
writeFileSync(selectionFile,JSON.stringify({root,samples:samples.map(({label,node})=>({label,path:node.path,title:node.title})),queries:[{label:"common-term",q:"project"},{label:"phrase",q:"next steps"},{label:"entity-name",q:entities[0]!.title}]}),{mode:0o600});
for(const {label,node} of samples){
 for(let run=0;run<5;run++){
  begin=performance.now();const entity=assertionEntityView(root,node.path!);const entityMs=performance.now()-begin;
  const full=noteBriefingInput(root,{selected:[node.path!],excluded:[]});const inputMs=performance.now()-begin-entityMs;
  const prompt=briefingPrompt(full);
  console.log(JSON.stringify({stage:"note-preparation",label,run,entityMs,inputMs,totalMs:performance.now()-begin,assertions:entity?.assertions.length,links:full.links.length,promptCharacters:prompt.prompt.length}));
 }
 let generations=0;
 // Cold cache misses use a deterministic stub, never the user's provider.
 const service=createNoteBriefingService(async (_root,prompt)=>{generations++;const data=JSON.parse(prompt);return {model:"benchmark-stub",text:JSON.stringify({summary:"Local cache benchmark.",links:Object.fromEntries(data.links.map((l:any)=>[l.id,{description:"related record",evidence:[1]}]))})};});
 for(let run=0;run<5;run++){
  const before=generations;begin=performance.now();const result=await service(root,{selected:[node.path!],excluded:[]});
  console.log(JSON.stringify({stage:"briefing-cache",label,run,ms:performance.now()-begin,cacheHit:generations===before,links:result.links.length}));
 }
}
const queries=[{label:"common-term",q:"project"},{label:"phrase",q:"next steps"},{label:"entity-name",q:entities[0]!.title}];
for(const {label,q} of queries)for(let run=0;run<5;run++){
 begin=performance.now();const result=scanSurface(root,q,200,"web",{ledger:false});
 console.log(JSON.stringify({stage:"search-core",label,run,ms:performance.now()-begin,ok:result.ok,hits:result.ok?result.hits.length:0}));
}
console.log(JSON.stringify({stage:"memory",rssBytes:process.memoryUsage().rss}));
