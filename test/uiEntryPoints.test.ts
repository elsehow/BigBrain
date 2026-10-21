import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../web/ui/src');

test('desktop and full-app workbenches mount the production shell, whose base is Field', () => {
  for (const path of ['main.ts', 'v2.ts', 'dev/SidebarWorkbench.svelte', 'dev/fieldWorkbench.ts'])
    expect(readFileSync(join(root, path), 'utf8')).toContain('components/AppShell.svelte');
  const shell = readFileSync(join(root, 'components/AppShell.svelte'), 'utf8');
  expect(shell).toContain('<Base />');
  expect(shell).not.toContain('sourceStudy');
  expect(readFileSync(join(root, 'components/Base.svelte'), 'utf8')).toContain('<FieldView />');
});

test('Classic is gone: the shell has no alternate view to fall back to', () => {
  for (const path of ['App.svelte', 'lib/viewChoice.ts']) expect(existsSync(join(root, path))).toBe(false);
});
