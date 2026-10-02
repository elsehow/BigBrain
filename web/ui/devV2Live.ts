import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/** Dev only: answer /api/v2 from a real vault without a second engine on
 * it. Set BIGBRAIN_V2_VAULT=<vault> beside BIGBRAIN_PREVIEW_READ_ONLY=1;
 * everything else under /api still proxies to the live engine, and this one
 * route reads the vault's projection read-only (bin/v2Preview.ts). */
export function devV2Live(): Plugin {
  const script = fileURLToPath(new URL('../../bin/v2Preview.ts', import.meta.url));
  const held = new Map<string, { at: number; body: string }>();
  return {
    name: 'v2-live-preview', apply: 'serve',
    configureServer(server) {
      const vault = process.env['BIGBRAIN_V2_VAULT'];
      if (!vault) return;
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://dev');
        if (url.pathname !== '/api/v2' && url.pathname !== '/api/v2/entity') return next();
        const entity = url.pathname === '/api/v2/entity' ? url.searchParams.get('id') : null;
        if (url.pathname === '/api/v2/entity' && !entity) { res.statusCode = 400; res.end('{"error":"Which entity? Pass ?id=."}'); return; }
        const key = entity ?? '';
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
        const send = (body: string) => { res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(body); };
        const hit = held.get(key);
        if (hit && Date.now() - hit.at < 15000) return send(hit.body);
        execFile('bun', entity ? [script, vault, entity] : [script, vault], { maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
          if (error) { res.statusCode = 500; res.end(JSON.stringify({ error: stderr || error.message })); return; }
          held.set(key, { at: Date.now(), body: stdout });
          send(stdout);
        });
      });
    },
  };
}
