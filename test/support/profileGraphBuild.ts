/** Graph/evidence equivalence and latency on a marked disposable snapshot. */
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { buildAssertionGraph } from '../../lib/assertionGraph';
const root=process.argv[2];
if(!root || !basename(root).startsWith('bb-graph-profile-') || !existsSync(join(root,'.benchmark-snapshot'))) throw new Error('Marked graph snapshot required');
for(let run=0;run<6;run++){
 const evidence=createHash('sha256');let connections=0;const start=performance.now();
 const graph=buildAssertionGraph(root,(a,b,e)=>{evidence.update(JSON.stringify([a,b,e]));connections++;});
 const ms=performance.now()-start;
 console.log(JSON.stringify({run,ms,nodes:graph.nodes.length,edges:graph.edges.length,connections,graphDigest:createHash('sha256').update(JSON.stringify(graph)).digest('hex'),evidenceDigest:evidence.digest('hex'),rss:process.memoryUsage().rss}));
 Bun.gc(true);await Bun.sleep(0);
}
