import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
function git(...args: string[]): string {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

/** Development pages identify their actual source, including stale branches.
 * Read on each page load rather than caching the revision at server startup. */
export function devProvenance(): Plugin {
  return {
    name: 'preview-provenance',
    apply: 'serve',
    transformIndexHtml() {
      const version = JSON.parse(readFileSync(new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8')).version;
      const commit = git('rev-parse', '--short', 'HEAD') || 'unknown commit';
      const branch = git('branch', '--show-current') || 'detached';
      const behind = git('rev-list', '--count', 'HEAD..origin/main');
      const dirty = !!git('status', '--porcelain', '--untracked-files=no');
      const status = behind === '' ? 'main baseline unknown' : Number(behind) ? `${behind} commits behind cached origin/main` : 'includes cached origin/main';
      const label = `PREVIEW · ${version} · ${commit}${dirty ? ' + edits' : ''} · ${branch} · ${status}`;
      return [{ tag: 'script', attrs: { type: 'module' }, injectTo: 'body', children: `
        const badge = document.createElement('aside');
        badge.id = 'preview-provenance';
        badge.setAttribute('aria-label', 'Preview source');
        const studies = ['type-app.html','typography.html','context-demo.html','inbox-demo.html','meeting-demo.html','meeting-action-demo.html','left-sidebar.html','text-sidebar.html'];
        const study = studies.includes(location.pathname.split('/').pop()) || new URLSearchParams(location.search).get('layout') === 'original' || new URLSearchParams(location.search).get('home') === 'center';
        badge.textContent = (study ? 'VISUAL STUDY (custom styling) · ' : '') + ${JSON.stringify(label).replace(/</g, '\\u003c')};
        badge.style.cssText = 'position:fixed;bottom:0;left:0;z-index:99999;max-width:100vw;box-sizing:border-box;padding:3px 8px;background:#222;color:#fff;font:10px/1.4 monospace;pointer-events:none';
        document.body.append(badge);
      ` }];
    },
  };
}
