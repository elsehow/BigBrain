/** Profile real search routes and watcher refresh on a marked disposable snapshot.
 * Arguments: engine checkout, snapshot, aggregate output. No model routes. */
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
const [engineArg, rootArg, output] = process.argv.slice(2);
if (!engineArg || !rootArg || !output) throw Error('engine snapshot output required');
const engine = realpathSync(engineArg), root = realpathSync(rootArg);
if (!/^bb-(vault-scale|gardener-profile)-/.test(basename(root)) || !existsSync(join(root, '.benchmark-snapshot'))) throw Error('Marked scratch snapshot required');
if (process.env.BIGBRAIN_ASSERTION_DB || process.env.BIGBRAIN_SEARCH_DB) throw Error('External database overrides forbidden');
process.env.BIGBRAIN_VAULT = root;
const { ROUTES } = await import(join(engine, 'web/server.ts'));
const { dispatch } = await import(join(engine, 'lib/httpx.ts'));
const { invalidateGraphCaches } = await import(join(engine, 'lib/graphCache.ts'));
// Engines before the notes door (#225) needed a hint to drop decoded records; later ones key them by revision.
const invalidateAssertionRecord: (root: string) => void = (await import(join(engine, 'lib/assertionEntityView.ts'))).invalidateAssertionRecord ?? (() => {});
const { createLive } = await import(join(engine, 'lib/liveEvents.ts'));
const samples: { phase: string; ms: number; hits: number; digest: string }[] = [];
async function search(phase: string, query: string) {
  const start = performance.now();
  const body = await new Promise<string>(resolve => {
    dispatch(ROUTES, { url: `/api/search?q=${query}&limit=6&offset=0`, method: 'GET' }, { writeHead: (status: number) => { if (status !== 200) throw Error('Search failed'); }, end: resolve });
  });
  const parsed = JSON.parse(body);
  samples.push({ phase, ms: performance.now() - start, hits: parsed.hits.length, digest: createHash('sha256').update(body).digest('hex') });
}
for (let i = 0; i < 3; i++) {
  invalidateGraphCaches(root); invalidateAssertionRecord(root);
  await search('invalidated', 'project');
}
for (const q of ['project','memory','research','work','meeting','model','planning','notes']) await search('warm', q);
// Exercise the actual filesystem watcher and its production refresh/warm path.
const live = createLive({ root });
const probe = join(root, 'memory', 'profile-search-refresh.md');
if (existsSync(probe)) throw Error('Probe already exists');
let changed: (() => void) | undefined;
const ping = new Promise<void>(resolve => { changed = resolve; });
live.addClient({ write: (text: string) => { if (text.includes('"changed":true')) changed?.(); } });
let timeout: ReturnType<typeof setTimeout> | undefined;
let watcherMs = 0;
try {
  live.start(); mkdirSync(join(root, 'memory'), { recursive: true });
  const start = performance.now();
  writeFileSync(probe, '# Searchwatcherprobe\n\nSynthetic disposable profiling note.\n');
  await Promise.race([ping, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Watcher did not refresh')), 20000); })]);
  watcherMs = performance.now() - start;
  await search('after-watcher', 'project');
  await search('new-note', 'Searchwatcherprobe');
  if (samples.at(-1)!.hits !== 1) throw Error('Watcher did not expose new note');
} finally { if (timeout) clearTimeout(timeout); live.stop(); rmSync(probe, { force: true }); }
writeFileSync(output, JSON.stringify({ samples, watcherMs }, null, 2));
console.log(JSON.stringify({ samples: samples.map(({ digest: _digest, ...sample }) => sample), watcherMs }));
