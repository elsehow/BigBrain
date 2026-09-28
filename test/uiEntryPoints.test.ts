import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../web/ui/src');
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(?:svelte|ts)$/.test(path) ? [path] : [];
  });
}

test('only the production shell can import the bare App', () => {
  const callers = sources(root).filter(path => /(?:from\s*|import\s*\()\s*['"][^'"]*\/App\.svelte['"]/.test(readFileSync(path, 'utf8')));
  expect(callers).toEqual([join(root, 'components/AppShell.svelte')]);
});

test('desktop and sidebar workbench share AppShell', () => {
  for (const path of ['main.ts', 'dev/SidebarWorkbench.svelte']) {
    expect(readFileSync(join(root, path), 'utf8')).toContain('components/AppShell.svelte');
  }
});
