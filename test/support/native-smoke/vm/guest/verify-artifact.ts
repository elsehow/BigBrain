// Runs only after the shell's VirtualMac/offline checks. Reads the staged app,
// never imports its engine. No network, credentials or app initialization.
import { readFileSync, readdirSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const [input, app] = process.argv.slice(2);
if (!input || !app) throw new Error('Expected manifest and app paths');
const manifest = JSON.parse(readFileSync(input, 'utf8'));
const root = realpathSync(app);
const actual: string[] = [];
function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    actual.push(relative(root, path));
    if (lstatSync(path).isDirectory()) walk(path);
  }
}
walk(root);
if (JSON.stringify(actual.sort()) !== JSON.stringify(manifest.files.map((f: {path: string}) => f.path).sort())) throw new Error('Artifact file list differs');
for (const f of manifest.files) {
  const path = resolve(root, f.path);
  if (!path.startsWith(root + '/')) throw new Error('Escaping manifest path');
  const st = lstatSync(path);
  if ((st.mode & 0o7777) !== f.mode) throw new Error(`Mode changed: ${f.path}`);
  if (f.type === 'link') {
    if (!st.isSymbolicLink() || readlinkSync(path) !== f.target || !realpathSync(path).startsWith(root + '/')) throw new Error(`Link changed: ${f.path}`);
  } else if (f.type === 'directory') {
    if (!st.isDirectory()) throw new Error(`Directory changed: ${f.path}`);
  } else {
    if (!st.isFile() || st.size !== f.bytes || createHash('sha256').update(readFileSync(path)).digest('hex') !== f.sha256) throw new Error(`File changed: ${f.path}`);
  }
}
console.log(JSON.stringify({ artifactVerified: true, expected: manifest.expected, files: actual.length, inventorySHA256: manifest.inventorySHA256 }));
