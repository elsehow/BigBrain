import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

/** Explicit local fixture, never public/ (Vite copies public/ into releases). */
export function devGraphSnapshot(): Plugin {
  return {
    name: 'local-profile-graph', apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/__profile_graph.json') return next();
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
        try {
          const data = await readFile(new URL('./.profile-local/graph.json', import.meta.url));
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store'); res.end(data);
        } catch { res.statusCode = 404; res.end('No local profiling snapshot'); }
      });
    },
  };
}
