import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/** Dev only: answer /api/squad from a real vault without a second engine on
 * it. Set BIGBRAIN_SQUAD_VAULT=<vault> beside BIGBRAIN_PREVIEW_READ_ONLY=1;
 * everything else under /api still proxies to the live engine, and this one
 * route reads the vault's projection read-only (bin/squadPreview.ts). */
export function devSquadLive(): Plugin {
  const script = fileURLToPath(new URL('../../bin/squadPreview.ts', import.meta.url));
  let held: { at: number; body: string } | null = null;
  return {
    name: 'squad-live-preview', apply: 'serve',
    configureServer(server) {
      const vault = process.env['BIGBRAIN_SQUAD_VAULT'];
      if (!vault) return;
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/api/squad') return next();
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
        const send = (body: string) => { res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(body); };
        if (held && Date.now() - held.at < 15000) return send(held.body);
        execFile('bun', [script, vault], { maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
          if (error) { res.statusCode = 500; res.end(JSON.stringify({ error: stderr || error.message })); return; }
          held = { at: Date.now(), body: stdout };
          send(stdout);
        });
      });
    },
  };
}
