// Compile both the normal shipped entry and an isolated fixture entry together.
// No development server or alternate app shell is used by the native check.
import { build } from '../../web/ui/node_modules/vite/dist/node/index.js';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../web/ui/', import.meta.url));
await build({ root, build: { outDir: process.env.GRAPH_BUILD_DIR || '/tmp/bigbrain-graph-built', emptyOutDir: true,
  rollupOptions: { input: { index: `${root}index.html`, graph: `${root}graph-production.html` } } } });
