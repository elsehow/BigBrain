/** Private snapshot only. Prints aggregate timings and result digests, never content. */
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { heapStats } from 'bun:jsc';
import { createHash } from 'node:crypto';
import { scanSurface } from '../../lib/searchCore';
import { syncAssertionProjection } from '../../lib/assertionProjection';
import { primaryGraphCached, graphWithLayout, invalidateGraphCaches } from '../../lib/graphCache';
const root=process.argv[2];
if(!root || !basename(root).startsWith('bb-vault-scale-') || !existsSync(join(root,'.benchmark-snapshot'))) throw new Error('Marked snapshot required');
if(process.env.BIGBRAIN_ASSERTION_DB || process.env.BIGBRAIN_SEARCH_DB) throw new Error('External database override forbidden');
const sqlTimes=new Map<string,{ms:number,calls:number,rows:number}>();
const original=Database.prototype.query;
Database.prototype.query=function(sql: string){
 if(process.env.BB_PROFILE_LEGACY_HEADERS === '1') sql=sql.replace(/ INDEXED BY sources_headers/g,'').replace(/s\.envelope_source/g,"json_extract(s.event_json, '$.envelope.source')").replace(/s\.envelope_kind/g,"json_extract(s.event_json, '$.envelope.kind')").replace('envelope_kind AS kind',"json_extract(event_json, '$.envelope.kind') AS kind").replace('envelope_source AS source',"json_extract(event_json, '$.envelope.source') AS source");
 const statement=original.call(this,sql);
 return new Proxy(statement,{get(target,key){
  const value=Reflect.get(target,key,target);
  if(key==='all')return (...args:unknown[])=>{const start=performance.now();const result=value.apply(target,args);const label=sql.replace(/\s+/g,' ').replace(/\?(,\?)+/g,'?…').trim();const held=sqlTimes.get(label)??{ms:0,calls:0,rows:0};held.ms+=performance.now()-start;held.calls++;held.rows+=result.length;sqlTimes.set(label,held);return result;};
  return typeof value==='function'?value.bind(target):value;
 }}) as ReturnType<typeof original>;
} as typeof original;
const syncStart=performance.now();const counts=syncAssertionProjection(root);console.log(JSON.stringify({stage:'sync',ms:performance.now()-syncStart,counts}));
const queries=[{q:'project'},{q:'next steps'},{q:'memory'},{q:'a'},{q:'re'},{q:'project',filters:{source:'pilot'}},{q:'project',filters:{type:'entity' as const}}];
for(let pass=0;pass<(process.env.BB_PROFILE_MEMORY_ONLY ? 0 : 6);pass++)for(const [index,{q,filters}] of queries.entries()){
 sqlTimes.clear();const start=performance.now();const result=scanSurface(root,q,200,'web',{ledger:false,filters});if(!result.ok)throw new Error(result.reason);
 console.log(JSON.stringify({stage:'search',pass,query:index,ms:performance.now()-start,hits:result.ok?result.hits.length:0,digest:createHash('sha256').update(JSON.stringify(result)).digest('hex'),sql:[...sqlTimes].map(([query,v])=>({query,...v})).sort((a,b)=>b.ms-a.ms).slice(0,5)}));
}
Database.prototype.query=original;
for(let cycle=0;cycle<(process.env.BB_PROFILE_SEARCH_ONLY ? 0 : 8);cycle++){
 invalidateGraphCaches(root);const begin=performance.now();const graph=primaryGraphCached(root);const graphMs=performance.now()-begin;
 const layoutStart=performance.now();graphWithLayout(root,graph);const layoutMs=performance.now()-layoutStart;
 Bun.gc(true);await Bun.sleep(0);Bun.gc(true);const {heapSize,extraMemorySize,objectCount}=heapStats();console.log(JSON.stringify({stage:'graph-memory',cycle,nodes:graph.nodes.length,edges:graph.edges.length,graphMs,layoutMs,heapSize,extraMemorySize,objectCount,...process.memoryUsage()}));
}
if(process.env.BB_PROFILE_SEARCH_ONLY) process.exit(0);
const cpu=process.cpuUsage(),start=performance.now();await new Promise(r=>setTimeout(r,10000));
console.log(JSON.stringify({stage:'isolated-idle',ms:performance.now()-start,cpuMicros:process.cpuUsage(cpu),...process.memoryUsage()}));
