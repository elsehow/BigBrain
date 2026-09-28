/**
 * api.ts — the authenticated HTTP intake service (:4748, localhost-only)
 * for callers that hold a drop token: integrations, the browser extension,
 * the Claude Code plugin. The handler lives in lib/api.ts (testable
 * without a socket); this file is just the serve loop.
 *
 * Never expose 4748 directly; front it with a TLS proxy
 * Tokens are minted with `bigbrain auth create`.
 */

import { apiPort } from "../lib/env";
import { VAULT_ROOT } from "../lib/vaultRoot";
import { tokenStorePath } from "../lib/auth";
import { makeApiHandler, MAX_REQUEST_BYTES } from "../lib/api";
import { dieWithSupervisor } from "../lib/parentWatch";

// Under the desktop app: go when the supervisor goes (#597). Run by hand
// there is no supervisor pid and this watches nothing.
dieWithSupervisor("api");

// BIGBRAIN_API_PORT first: a bare PORT in the vault's .env reaches the web
// server too (bun autoloads .env; cwd = vault) and would collide the two.
const port = apiPort();
const storePath = tokenStorePath(VAULT_ROOT);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  maxRequestBodySize: MAX_REQUEST_BYTES,
  // Bun's default idleTimeout is 10s and a drop answers only after the
  // landing is written, linked and git-committed — seconds on a warm vault,
  // longer on a cold or large one. The control proxy in front allows 60;
  // this must not be the shorter fuse.
  idleTimeout: 60,
  fetch: makeApiHandler({
    root: VAULT_ROOT,
    storePath,
  }),
});

console.log(`api: listening on 127.0.0.1:${port} (vault ${VAULT_ROOT}, tokens ${storePath})`);
