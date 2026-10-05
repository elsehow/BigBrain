import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../web/ui/src');

test('the desktop and the sidebar workbench mount the same base, whose view is Field', () => {
  for (const path of ['main.ts', 'dev/SidebarWorkbench.svelte']) expect(readFileSync(join(root, path), 'utf8')).toContain('components/Base.svelte');
  expect(readFileSync(join(root, 'components/Base.svelte'), 'utf8')).toContain('<FieldView />');
});

test('Classic is gone: no app shell for a view to fall back to', () => {
  for (const path of ['App.svelte', 'components/AppShell.svelte', 'lib/viewChoice.ts']) expect(existsSync(join(root, path))).toBe(false);
});
