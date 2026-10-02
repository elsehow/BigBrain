/** Synthetic fresh-member fixture: a personal vault exactly as first run
 * creates it (bin/init.ts), a populated shared vault, and one member invite.
 * Fabricated content only; secrets and HOME stay in the temporary directory. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { initMemberStore } from '../../lib/sharedMembers';
import { makeSharedApiHandler } from '../../lib/sharedVaultApi';
import { SharedVault } from '../../lib/sharedVault';
import { createMemberInvite } from '../../lib/sharedInvites';

const home = mkdtempSync(join(tmpdir(), 'bb-fresh-member-')), personal = join(home, 'personal'), shared = join(home, 'shared');
const members = join(home, 'members.json'), connections = join(home, 'connections.json'), fakeHome = join(home, 'home');
mkdirSync(shared); mkdirSync(fakeHome);
const env = { ...process.env, HOME: fakeHome, BIGBRAIN_VAULT: personal };
const init = spawnSync(process.execPath, ['bin/init.ts', '--json'], { input: JSON.stringify({ auth: 'max', install: false }), encoding: 'utf8', env });
if (!init.stdout.includes('"ok":true')) throw Error('Fresh vault init failed: ' + init.stdout + init.stderr);

writeFileSync(join(shared, 'vault.yaml'), 'shared: true\n');
const owner = initMemberStore(members, shared, { handle: 'owner', display: 'Example Owner' });
const handler = makeSharedApiHandler({ root: shared, storePath: members, vault: new SharedVault(shared), log: () => {} });
const remote = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
const endpoint = `http://127.0.0.1:${remote.port}`;
const post = async (path: string, body: unknown) => (await handler(new Request(endpoint + path, { method: 'POST', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }))).json() as Promise<{ id: string }>;
const kickoff = await post('/v1/evidence', { title: 'Kickoff notes', body: 'The Example project kicked off with three workstreams.' });
const budget = await post('/v1/evidence', { title: 'Budget thread', body: 'Budget for the Example project was approved.' });
await post('/v1/evidence', { title: 'Uncited memo', body: 'A memo nobody has asserted anything about yet.' });
await post('/v1/assertions', { text: '[[Example project]] has three workstreams.', sources: [kickoff.id] });
await post('/v1/assertions', { text: '[[Example project]] budget was approved.', sources: [budget.id] });
writeFileSync(join(shared, '.shared-identity.json'), JSON.stringify({ id: 'example-vault', name: 'Example team' }));
const invite = `${endpoint}/invite#${createMemberInvite(members, 'Example Member', 'read').secret}`;

const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
const child = Bun.spawn(['bun', 'web/server.ts'], { env: { ...env, BIGBRAIN_WEB_PORT: String(port), BIGBRAIN_SHARED_CONNECTIONS: connections, PI_OFFLINE: '1', NODE_ENV: 'test' }, stdout: 'ignore', stderr: 'pipe' });
void new Response(child.stderr).text().then(log => { if (log) process.stderr.write(log); });
void child.exited.then(code => { if (code) console.error('Fixture web server exited with status ' + code); });
writeFileSync(join(home, 'browser.json'), JSON.stringify({ invite, base: `http://127.0.0.1:${port}`, home }), { mode: 0o600 });
console.log(join(home, 'browser.json'));
const close = () => { child.kill(); remote.stop(true); process.exit(); }; process.on('SIGTERM', close); process.on('SIGINT', close);
