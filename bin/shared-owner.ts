#!/usr/bin/env bun
import { resolve, join } from 'node:path';
import { sharedOwner } from '../lib/sharedOwner';
import { flagValue, hasFlag } from '../lib/cliflags';
import { writeAtomic } from '../lib/fsx';
const args = process.argv.slice(2), dir = flagValue(args, 'home');
if (!dir) { console.error('usage: bun bin/shared-owner.ts --home <new-or-existing-owner-directory> [--port 4750] [--open]'); process.exit(1); }
const home = resolve(dir), port = Number(flagValue(args, 'port') ?? 4750);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid port');
const app = sharedOwner(home, resolve(import.meta.dir, '../web/shared-owner'));
try {
  const server = Bun.serve({ hostname: '127.0.0.1', port, maxRequestBodySize: 1100000, fetch: app.fetch });
  const url = `http://127.0.0.1:${server.port}/#${app.token()}`;
  const launchFile = join(home, 'launch-url');
  writeAtomic(launchFile, url + '\n', 0o600);
  console.log(`Shared vault owner interface: http://127.0.0.1:${server.port}/\nPrivate launch link: ${launchFile}`);
  if (hasFlag(args, 'open')) Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', url], { stdout: 'ignore', stderr: 'ignore' });
  const stop = () => { server.stop(true); app.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
} catch (e) { app.close(); throw e; }
