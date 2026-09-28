/** Real-provider ingestion benchmark, only on a newly copied, marked scratch vault.
 * prepare <source-vault> creates a private replay fixture without credentials.
 * run <snapshot> --live [--concurrency=2] uses the normal gardener and shared MCP handlers.
 * Output is aggregates only; raw journals and source identifiers stay in the copy. */
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { loadManifest } from '../../lib/manifest';
import { syncAssertionProjection, openAssertionProjectionReadonly } from '../../lib/assertionProjection';
import { dueIntakeIds, submitWire } from '../../lib/work';
import { stagedHeads } from '../../lib/stage';
import { instrumentVaultTools } from './profileVaultTools';
import { runTend } from '../../lib/tend';
import { runConcurrentGardener, gardenerLane } from './concurrentGardener';
import { MODEL_DEFAULTS } from '../../lib/modelDefaults';

const [mode, input, flag, effort] = process.argv.slice(2);
if (process.env.BIGBRAIN_ASSERTION_DB || process.env.BIGBRAIN_SEARCH_DB) throw new Error('External database overrides forbidden');
function noLinks(path: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error('Snapshot trees must not contain symlinks');
  if (stat.isDirectory()) for (const name of readdirSync(path)) noLinks(join(path, name));
}
function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode) throw new Error('Scratch git operation failed');
}
function events(root: string, kind: string) {
  const dir = join(root, 'log', kind);
  return readdirSync(dir).flatMap(month => readdirSync(join(dir, month)).filter(n => n.endsWith('.json')).map(n => join(dir, month, n)));
}
const stats = (values: number[]) => {
  const sorted = [...values].sort((a,b) => a-b);
  return { count: values.length, totalMs: values.reduce((a,b) => a+b,0), meanMs: values.length ? values.reduce((a,b) => a+b,0)/values.length : null,
    p50Ms: sorted[Math.ceil(sorted.length*.5)-1] ?? null, p95Ms: sorted[Math.ceil(sorted.length*.95)-1] ?? null, maxMs: sorted.at(-1) ?? null };
};
if (mode === 'prepare' && input) {
  const source = realpathSync(input);
  const manifest = loadManifest(source);
  if (manifest.auth !== 'max') throw new Error('This live benchmark requires subscription authentication');
  const root = mkdtempSync(join(tmpdir(), 'bb-gardener-profile-'));
  for (const rel of ['log', '.spool/stage']) if (existsSync(join(source, rel))) {
    noLinks(join(source, rel)); cpSync(join(source, rel), join(root, rel), { recursive: true });
  }
  writeFileSync(join(root, '.benchmark-snapshot'), 'gardener-replay-v1\n');
  writeFileSync(join(root, 'vault.yaml'), stringify({ auth: manifest.auth, gardener: manifest.gardener, memory: manifest.gardener, integrations: {} }));
  writeFileSync(join(root, '.gitignore'), '.state/\n.spool/\n.profile-*\n');
  syncAssertionProjection(root);
  const db = openAssertionProjectionReadonly(root);
  // Use live, eligible insertions; avoid superseded records and identity declarations.
  const eligible = db.query(`SELECT s.insertion_id AS id, s.intake_class AS class, s.event_json AS json FROM sources s
    WHERE s.intake_priority IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sources newer WHERE newer.supersedes = s.insertion_id AND newer.source_id = s.source_id)
    ORDER BY s.intake_at DESC, s.insertion_id DESC`).all() as {id:string;class:string;json:string}[];
  db.close();
  const chosen: typeof eligible = [];
  for (const kind of ['meeting','reading','mail','agent-chat']) {
    const row = eligible.find(r => r.class===kind && JSON.parse(r.json).body.length >= 300 && JSON.parse(r.json).body.length <= 60000);
    if (row) chosen.push(row);
  }
  for (const row of eligible) { if(chosen.length>=6)break; if(!chosen.some(r=>r.id===row.id) && row.class!=='voice' && JSON.parse(row.json).body.length>=300 && JSON.parse(row.json).body.length<=60000)chosen.push(row); }
  if(chosen.length<3)throw new Error('Insufficient eligible replay items');
  const ids = new Set(chosen.map(r=>r.id));
  const removed: Record<string,number> = {};
  for (const kind of ['assertions','declines']) for(const path of events(root,kind)) {
    const event=JSON.parse(readFileSync(path,'utf8'));
    if((event.sources ?? event.insertions ?? []).some((r: {insertion_id:string})=>ids.has(r.insertion_id))) {
      if(event.produced_by?.procedure==='user-identity-bootstrap')throw new Error('Refusing to remove identity');
      rmSync(path);removed[kind]=(removed[kind]??0)+1;
    }
  }
  rmSync(join(root,'.state'),{recursive:true,force:true}); syncAssertionProjection(root);
  git(root,'init','-q');git(root,'config','user.name','Benchmark');git(root,'config','user.email','benchmark@localhost');git(root,'config','core.hooksPath','/dev/null');
  git(root,'add','log','vault.yaml','.gitignore','.benchmark-snapshot');git(root,'commit','-qm','Private replay baseline');
  const others=dueIntakeIds(root).filter(id=>!ids.has(id));
  if(others.length)submitWire(root,[{submit:'decline',insertion_ids:others,reason:'Excluded from bounded replay benchmark'}],{author:{kind:'system',id:'benchmark'},produced_by:{procedure:'benchmark',version:'v1'}});
  const staged=stagedHeads(root, Infinity);
  const fixture={version:1,root:realpathSync(root),source,selected:[...ids],staged:staged.map(s=>s.id),removed,suppressed:others.length,
    intake:chosen.map(r=>({class:r.class,bodyCharacters:JSON.parse(r.json).body.length})),model:manifest.gardener};
  writeFileSync(join(root,'.profile-fixture.json'),JSON.stringify(fixture),{mode:0o600});
  console.log(JSON.stringify({root,intake:fixture.intake,staged:staged.length,removed,suppressed:others.length,model:fixture.model}));
} else if(mode==='clone' && input && (flag==='openai'||flag==='anthropic')) {
  const baseline=realpathSync(input);
  if(!basename(baseline).startsWith('bb-gardener-profile-') || !existsSync(join(baseline,'.benchmark-snapshot')))throw new Error('Marked scratch snapshot required');
  noLinks(baseline);
  const fixture=JSON.parse(readFileSync(join(baseline,'.profile-fixture.json'),'utf8'));
  if(fixture.root!==baseline || fixture.source===baseline)throw new Error('Prepared baseline required');
  const due=dueIntakeIds(baseline),stage=stagedHeads(baseline,Infinity).map(s=>s.id);
  if(due.length!==fixture.selected.length || due.some(id=>!fixture.selected.includes(id)) || stage.length!==fixture.staged.length || stage.some(id=>!fixture.staged.includes(id)))throw new Error('Baseline has already processed work');
  const root=realpathSync(mkdtempSync(join(tmpdir(),'bb-gardener-profile-')));
  for(const rel of ['log','.spool/stage'])if(existsSync(join(baseline,rel)))cpSync(join(baseline,rel),join(root,rel),{recursive:true});
  if(effort && (flag!=='openai' || !['low','medium'].includes(effort)))throw new Error('Effort comparison supports OpenAI low or medium');
  const gardener={agent:flag==='openai'?'pi':'claude',...MODEL_DEFAULTS[flag].gardener,...(effort?{reasoning:effort}:{})};
  writeFileSync(join(root,'vault.yaml'),stringify({auth:'max',gardener,memory:gardener,integrations:{}}));
  writeFileSync(join(root,'.benchmark-snapshot'),'gardener-replay-v1\n');
  writeFileSync(join(root,'.gitignore'),'.state/\n.spool/\n.profile-*\n');
  git(root,'init','-q');git(root,'config','user.name','Benchmark');git(root,'config','user.email','benchmark@localhost');git(root,'config','core.hooksPath','/dev/null');
  git(root,'add','log','vault.yaml','.gitignore','.benchmark-snapshot');git(root,'commit','-qm','Private replay baseline');
  writeFileSync(join(root,'.profile-fixture.json'),JSON.stringify({...fixture,root,model:gardener}),{mode:0o600});
  console.log(JSON.stringify({root,model:gardener}));
} else if(mode==='run' && input && flag==='--live') {
  if(effort && effort!=='--concurrency=2')throw new Error('Only --concurrency=2 is supported for this experiment');
  const concurrency=effort==='--concurrency=2'?2:1;
  const root=realpathSync(input);
  if(!basename(root).startsWith('bb-gardener-profile-') || !existsSync(join(root,'.benchmark-snapshot')))throw new Error('Marked scratch snapshot required');
  noLinks(root);
  const fixture=JSON.parse(readFileSync(join(root,'.profile-fixture.json'),'utf8'));
  if(fixture.root!==root || fixture.source===root || existsSync(join(root,'.profile-started')))throw new Error('Fresh prepared snapshot required');
  const manifest=loadManifest(root);
  if(manifest.auth!=='max' || !['claude','pi'].includes(manifest.gardener.adapter) || (manifest.gardener.adapter==='pi' && manifest.gardener.provider!=='openai-codex'))throw new Error('Benchmark requires Claude or Pi subscription runtime');
  if(manifest.gardener.adapter==='pi') {
    const {ModelRuntime}=await import('@earendil-works/pi-coding-agent');
    const signal=AbortSignal.timeout(10000);
    const runtime=await ModelRuntime.create({allowModelNetwork:false,signal});
    const available=await runtime.getAvailable('openai-codex',{signal});
    if(!runtime.isUsingSubscription('openai-codex') || !available.some(m=>m.id===manifest.gardener.model))throw new Error('Connect ChatGPT and select an available subscription model');
  }
  const projection=syncAssertionProjection(root);
  const before=dueIntakeIds(root),stageBefore=stagedHeads(root,Infinity).map(s=>s.id);
  if(before.length!==fixture.selected.length || before.some(id=>!fixture.selected.includes(id)) || stageBefore.length!==fixture.staged.length || stageBefore.some(id=>!fixture.staged.includes(id)))throw new Error('Fixture queue changed');
  writeFileSync(join(root,'.profile-started'),'started\n');
  const tools: Record<string,{times:number[];errors:number;requestBytes:number;responseBytes:number}>={};
  const intervals: [number,number][]=[];
  const timeline: {lane:number;tool:string;startMs:number;endMs:number;appended?:number;rejected?:number}[]=[];
  let firstFilingMs:number|null=null;
  const submitted: Record<string,{attempts:number;ok:number;rejected:number}>={};
  const repeated=new Set<string>();let repeatedItems=0,rejectedItems=0,admitted=0,passed=0,appended=0,deduped=0;
  const admittedAt=new Map<string,number>(),firstFiled=new Set<string>(),admissionToAssertion:number[]=[];
  const resourceFile=join(root,'.profile-resources.json');
  const sampler=process.platform==='darwin' ? Bun.spawn(['python3','-B',new URL('./profileGardenerResources.py',import.meta.url).pathname,String(process.pid),resourceFile],{stdin:'pipe',stdout:'ignore',stderr:'pipe'}) : null;
  const begin=performance.now(),cpu=process.cpuUsage();
  let peakRss=process.memoryUsage().rss,expected=performance.now()+100;
  const lag:number[]=[];let ticks=0;
  const timer=setInterval(()=>{const now=performance.now();lag.push(Math.max(0,now-expected));expected=now+100;peakRss=Math.max(peakRss,process.memoryUsage().rss);ticks++;},100);
  const restoreTools=instrumentVaultTools((t,handler)=>async(ctx,args)=>{
    if(realpathSync(ctx.root)!==root)throw new Error('Tool escaped benchmark root');
    const record=tools[t.name]??={times:[],errors:0,requestBytes:0,responseBytes:0};
    const start=performance.now();record.requestBytes+=Buffer.byteLength(JSON.stringify(args));
    try {
      const result:any=await handler(ctx,args);
      // Timing excludes instrumentation serialization, but includes the complete shared handler.
      const end=performance.now();record.times.push(end-start);intervals.push([start,end]);
      record.responseBytes+=Buffer.byteLength(JSON.stringify(result)??'');
      timeline.push({lane:gardenerLane.getStore()??0,tool:t.name,startMs:start-begin,endMs:end-begin,...(t.name==='submit'?{appended:result.appended??0,rejected:result.rejected??0}:{})});
      if(t.name==='submit') {
        if(firstFilingMs===null && result.results?.some((row:any)=>row.ok&&!row.deduped&&(args.items as any[])?.[row.index]?.submit==='assertion'))firstFilingMs=end-begin;
        const items=args.items as any[];
        for(const [index,item] of items.entries()) {
          const kind=['assertion','decline','admit','pass'].includes(item.submit)?item.submit:'invalid';
          const summary=submitted[kind]??={attempts:0,ok:0,rejected:0};summary.attempts++;
          const key=JSON.stringify(item);if(repeated.has(key))repeatedItems++;repeated.add(key);
          const row=result.results?.find((r:any)=>r.index===index);
          if(row?.ok) {
            summary.ok++;
            for(const staged of row.staged??[])if(staged.ok&&staged.insertion_id)admittedAt.set(staged.insertion_id,end);
            if(kind==='assertion')for(const id of item.sources??[])if(admittedAt.has(id)&&!firstFiled.has(id)){firstFiled.add(id);admissionToAssertion.push(end-admittedAt.get(id)!);}
          } else {summary.rejected++;rejectedItems++;}
        }
        admitted+=result.admitted??0;passed+=result.passed??0;appended+=result.appended??0;deduped+=result.deduped??0;
      }
      console.log(JSON.stringify({stage:'tool',tool:t.name,ms:end-start,elapsedMs:end-begin}));
      return result;
    } catch(error) {record.errors++;const end=performance.now();record.times.push(end-start);intervals.push([start,end]);throw error;}
  });
  console.log(JSON.stringify({stage:'started',pid:process.pid,model:manifest.gardener,intake:before.length,staged:stageBefore.length}));
  let result: Awaited<ReturnType<typeof runTend>>;
  try {result=concurrency===2?await runConcurrentGardener(root,manifest):await runTend({root,manifest,maxRounds:1,memoryRunner:async()=>({ran:false,reason:'Excluded from ingestion-only benchmark'})});}
  finally {clearInterval(timer);restoreTools();if(sampler)sampler.stdin.end();}
  const elapsedMs=performance.now()-begin;
  if(sampler)await sampler.exited;
  let toolUnionMs=0,last=begin;
  for(const [a,b] of intervals.sort((a,b)=>a[0]-b[0])){toolUnionMs+=Math.max(0,b-Math.max(a,last));last=Math.max(last,b);}
  const after=dueIntakeIds(root),stageAfter=stagedHeads(root,Infinity).map(s=>s.id);
  const completed=before.filter(id=>!after.includes(id)).length+stageBefore.filter(id=>!stageAfter.includes(id)).length;
  const report={stage:'summary',concurrency,model:manifest.gardener,fixture:{projection,intake:fixture.intake,staged:stageBefore.length,removed:fixture.removed,suppressed:fixture.suppressed},
    firstFilingMs,timeline,elapsedMs,toolUnionMs,outsideToolHandlersMs:elapsedMs-toolUnionMs,completedInitialItems:completed,initialItemsPerMinute:completed/(elapsedMs/60000),
    remainingIntake:after.length,remainingStaged:stageAfter.length,admitted,passed,appended,deduped,rejectedItems,repeatedIdenticalItems:repeatedItems,submitted,
    admissionToFirstAssertion:stats(admissionToAssertion),tools:Object.fromEntries(Object.entries(tools).map(([k,v])=>[k,{...stats(v.times),errors:v.errors,requestBytes:v.requestBytes,responseBytes:v.responseBytes}])),
    processTree:existsSync(resourceFile)?JSON.parse(readFileSync(resourceFile,'utf8')):null,
    host:{cpuMicros:process.cpuUsage(cpu),peakRssBytes:peakRss,eventLoopDelay:stats(lag),samples:ticks},
    rounds:result.rounds.map(r=>({settled:r.settled,remaining:r.remaining,usage:r.usage,failed:!!r.error})),failed:!!result.error||result.rounds.some(r=>!!r.error)};
  writeFileSync(join(root,'.profile-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  if(report.failed||after.length||stageAfter.length)process.exitCode=1;
} else throw new Error('Usage: prepare <vault> | clone <unprocessed-snapshot> openai|anthropic [low|medium] | run <snapshot> --live [--concurrency=2]');
