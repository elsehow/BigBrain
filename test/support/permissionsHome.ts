// Pilot folder and credential checks against a home folder of their own.
// Bun reads HOME once at startup, so the callers (test/workPermissions.test.ts,
// test/pilotAccess.test.ts) run this with HOME set to a fresh temp folder.
//   bun test/support/permissionsHome.ts folders|credentials
import { expect } from 'bun:test';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PilotAccess } from '../../lib/pilotAccess';
import { newPilotChatSession } from '../../lib/pilotChatTypes';
import { readEnvValues, writeEnvValues } from '../../lib/envFile';
import { normalizeWorkPermissions, readWorkPermissions, saveWorkPermissions } from '../../lib/workPermissions';
import { nativeVault } from './vault';

const home = realpathSync(homedir()), project = join(home, 'projects', 'app');
if (!home.includes('bb-permissions-home-')) throw new Error(`refusing to run outside a temp HOME: ${home}`);
mkdirSync(project, { recursive: true });
writeFileSync(join(project, 'README.md'), 'project readme');
const root = nativeVault({ files: { 'notes/a.md': 'Invented note' } });
const session = newPilotChatSession([]), signal = new AbortController().signal, access = new PilotAccess(root);
const read = (path: string) => access.tool(session, 'read_file', { path }, signal);
const grant = (path: string) => normalizeWorkPermissions({ version: 2, folders: [{ path, access: 'read' }] });

try {
  if (process.argv[2] === 'folders') {
    for (const dir of ['.config/gh', '.ssh/keys', 'Library/Keychains']) mkdirSync(join(home, dir), { recursive: true });
    symlinkSync(home, join(home, 'projects', 'home-link'));
    for (const [path, reason] of [
      ['/', 'whole disk'], ['~', 'whole home folder'], ['~/', 'whole home folder'], [home, 'whole home folder'],
      [join(home, 'projects', 'home-link'), 'whole home folder'], [dirname(home), 'contains your home folder'],
      ['~/.config', 'holds credentials'], ['~/Library', 'holds credentials'], ['~/.ssh/keys', 'holds credentials'],
    ]) expect(() => grant(path!)).toThrow(reason);
    expect(grant('~/projects/app').folders).toEqual([{ path: project, access: 'read' }]);
    expect(grant('~/projects').folders).toEqual([{ path: join(home, 'projects'), access: 'read' }]);

    // A grant saved before these refusals stops granting at once and is reported.
    writeFileSync(join(home, 'private.txt'), 'private');
    writeEnvValues(root, { BIGBRAIN_PILOT_AGENT_PERMISSIONS: JSON.stringify({ version: 2, folders: [{ path: home, access: 'read' }, { path: project, access: 'read' }] }) });
    const removed = [{ path: home, reason: expect.stringContaining('whole home folder') }];
    expect(readWorkPermissions(root)).toEqual({ version: 2, folders: [{ path: project, access: 'read' }], removed });
    await expect(read(join(home, 'private.txt'))).rejects.toThrow('not readable');
    expect(await read(join(project, 'README.md'))).toMatchObject({ text: 'project readme' });
    access.migrateSettings();
    expect(JSON.parse(readEnvValues(root).BIGBRAIN_PILOT_AGENT_PERMISSIONS!)).toEqual({ version: 2, folders: [{ path: project, access: 'read' }], removed });
    access.migrateSettings();
    expect(readWorkPermissions(root).removed).toEqual(removed);
    // The next save from Settings clears the notice.
    saveWorkPermissions(root, { version: 2, folders: [{ path: project, access: 'read' }] });
    expect(readWorkPermissions(root)).toEqual({ version: 2, folders: [{ path: project, access: 'read' }] });
    console.log('folders ok');
  } else if (process.argv[2] === 'credentials') {
    const stores = ['.config/gh/hosts.yml', '.config/gcloud/credentials.db', '.netrc', '.git-credentials', '.npmrc', '.pypirc', '.docker/config.json',
      '.kube/config', '.gnupg/private-keys', '.azure/msal_token_cache.json', 'Library/Keychains/login.keychain-db', 'Library/Cookies/Cookies.binarycookies',
      '.zsh_history', '.bash_history', '.ssh/config', '.aws/credentials', '.config/bigbrain/client-tokens.json'];
    stores.forEach((store, i) => {
      mkdirSync(dirname(join(home, store)), { recursive: true });
      writeFileSync(join(home, store), 'invented secret');
      symlinkSync(join(home, store), join(project, `link-${i}`));
    });
    symlinkSync(join(home, '.kube'), join(project, 'kube'));
    saveWorkPermissions(root, { version: 2, folders: [{ path: project, access: 'read' }] });
    for (const path of [...stores.map((_, i) => join(project, `link-${i}`)), join(project, 'kube', 'config'), ...stores.map(store => join(home, store))])
      await expect(read(path)).rejects.toThrow('not readable');
    expect(await read(join(project, 'README.md'))).toMatchObject({ text: 'project readme' });
    const listing = await access.tool(session, 'list_files', { path: project }, signal) as { entries: { name: string }[] };
    expect(listing.entries.map(e => e.name)).toEqual(['README.md']);
    // A vault kept at HOME is always readable, so only the denylist stands between Pilot and these.
    writeFileSync(join(home, 'notes.md'), 'Invented note');
    const atHome = new PilotAccess(home), readAtHome = (path: string) => atHome.tool(session, 'read_file', { path }, signal);
    for (const store of stores) await expect(readAtHome(join(home, store))).rejects.toThrow('not readable');
    expect(await readAtHome(join(home, 'notes.md'))).toMatchObject({ text: 'Invented note' });
    const names = (await atHome.tool(session, 'list_files', { path: home }, signal) as { entries: { name: string }[] }).entries.map(e => e.name);
    expect(names).toContain('notes.md');
    for (const hidden of ['.netrc', '.git-credentials', '.npmrc', '.pypirc', '.docker', '.kube', '.gnupg', '.azure', '.zsh_history', '.bash_history', '.ssh', '.aws']) expect(names).not.toContain(hidden);
    console.log('credentials ok');
  } else throw new Error(`unknown scenario ${process.argv[2]}`);
} finally { rmSync(root, { recursive: true, force: true }); }
