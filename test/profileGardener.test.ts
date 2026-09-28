import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const scratch=(prefix='bb-gardener-profile-')=>{const root=realpathSync(mkdtempSync(join(tmpdir(),prefix)));roots.push(root);return root;};
function invoke(root: string, live=true) {
  const result=Bun.spawnSync([process.execPath,'test/support/profileGardener.ts','run',root,...(live?['--live']:[])],{cwd:join(import.meta.dir,'..'),stdout:'pipe',stderr:'pipe'});
  expect(result.exitCode).not.toBe(0);
  expect(existsSync(join(root,'.profile-started'))).toBe(false);
  return result.stderr.toString();
}
test('profiling requires explicit live mode',()=>{const root=scratch();expect(invoke(root,false)).toContain('Usage:');});
test('profiling refuses an unmarked vault before starting a provider',()=>{const root=scratch('ordinary-vault-');writeFileSync(join(root,'vault.yaml'),'auth: max\n');expect(invoke(root)).toContain('Marked scratch snapshot required');});
test('profiling refuses symlinks into another vault',()=>{const root=scratch(),other=scratch('ordinary-vault-');writeFileSync(join(root,'.benchmark-snapshot'),'gardener-replay-v1');symlinkSync(other,join(root,'log'));expect(invoke(root)).toContain('must not contain symlinks');expect(existsSync(join(other,'.profile-started'))).toBe(false);});
test('a marker cannot make the original source writable by the profiler',()=>{const root=scratch();writeFileSync(join(root,'.benchmark-snapshot'),'gardener-replay-v1');writeFileSync(join(root,'.profile-fixture.json'),JSON.stringify({root,source:root}));expect(invoke(root)).toContain('Fresh prepared snapshot required');});


test('profiler observes gardener maintenance calls and restores shared handlers', async () => {
  const { instrumentVaultTools } = await import('./support/profileVaultTools');
  const { machineTools } = await import('../lib/run/machineTools');
  const { nativeVault } = await import('./support/vault');
  const root = nativeVault(); roots.push(root);
  const calls: string[] = [];
  const restore = instrumentVaultTools((tool, handler) => async (ctx, args) => {
    calls.push(tool.name);
    return handler(ctx, args);
  });
  const tools = machineTools(root, 'tend');
  try {
    await tools.find(t => t.name === 'next')!.call({});
    await tools.find(t => t.name === 'open')!.call({ ids: ['missing-profile-item'] });
    await expect(tools.find(t => t.name === 'submit')!.call({ items: [] })).rejects.toThrow('items must be a non-empty array');
    expect(calls).toEqual(['next', 'open', 'submit']);
  } finally { restore(); }
  await tools.find(t => t.name === 'next')!.call({});
  expect(calls).toEqual(['next', 'open', 'submit']);
});


test('provider comparison refuses an unmarked baseline', () => {
  const root = scratch('ordinary-vault-');
  const result = Bun.spawnSync([process.execPath, 'test/support/profileGardener.ts', 'clone', root, 'openai'],
    { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('Marked scratch snapshot required');
});

test('provider comparison refuses a baseline whose work is already processed', async () => {
  const { nativeVault } = await import('./support/vault');
  const root = realpathSync(nativeVault({ prefix: 'bb-gardener-profile-' })); roots.push(root);
  writeFileSync(join(root, '.benchmark-snapshot'), 'gardener-replay-v1');
  writeFileSync(join(root, '.profile-fixture.json'), JSON.stringify({ root, source: '/unused-original', selected: ['already-processed'], staged: [] }));
  const result = Bun.spawnSync([process.execPath, 'test/support/profileGardener.ts', 'clone', root, 'anthropic'],
    { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('Baseline has already processed work');
});
