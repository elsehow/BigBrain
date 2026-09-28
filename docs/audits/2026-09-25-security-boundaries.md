# Security boundary review — 2026-09-25

Baseline: `05ee37b05164494b2f0d101072b28cb943fa8ca8` (`origin/main`),
desktop version 0.7.27. This focused source review uses synthetic data and
scratch vaults. It does not certify the application or include a penetration
test of an installed release. The changes described here require a new release
before they protect installed apps.

## Reporting

[SECURITY.md](../../SECURITY.md) directs private reports to
`security@bigbrain.cool`, the address supplied by the maintainer. Mail delivery
was not tested. GitHub's private-vulnerability-reporting API returned 404 for
this private repository, so the policy does not depend on that feature.

## Finding fixed: inconsistent browser request checks

The unauthenticated viewer and first-run server bound to `127.0.0.1`, but did
not reject arbitrary Host headers. Some individual POST routes checked Origin,
while configuration, pairing, source opening and other routes did not share
that check. Some parsed JSON regardless of Content-Type. Consequently loopback
binding was being treated as authority without a consistent browser boundary:
a hostile website could attempt simple cross-origin writes, and arbitrary Host
values left the read surface exposed to DNS-rebinding attempts. Browser-specific
private-network protections must not be the application's only defense.

`allowLoopbackRequest` in `lib/httpx.ts` now runs before routing in:

- `web/server.ts`: the production viewer and local control API;
- `bin/desktop.ts`: the first-run setup door;
- `bin/pilotDev.ts`: the development server, including its proxy fallback.

The guard allows only `localhost`, `127.0.0.1` and `[::1]` authorities with valid
optional ports. If supplied, Origin must be the exact HTTP origin of that Host.
Fetch Metadata must indicate same-origin or direct navigation, not cross-site
or same-site requests. Mutating requests require `application/json`, preventing
simple form/no-cors payloads even when browser metadata is absent. Forwarded
headers never grant access. Reads and static files are guarded too. Responses
also suppress outgoing referrers.

Local tools may omit Origin. The guard deliberately does not authenticate
programs running as the OS user. A local Vite proxy or SSH tunnel may preserve
its own loopback Host/Origin pair with a different port from the backend's
listener. Existing bodyless UI POST calls now send an empty JSON object.
The separate bearer-authenticated integration API is unchanged.

## Other boundaries reviewed

| Boundary | Existing enforcement and relevant checks |
| --- | --- |
| Imported content rendered in the viewer | `web/ui/src/lib/markdown.ts` sanitizes generated HTML with DOMPurify. Note, Pilot and worker renderers use sanitization. `lib/httpx.ts` supplies CSP and nosniff headers. Vault downloads use attachment disposition in `web/server.ts` / `lib/staticServe.ts`. The browser regression exercises hostile HTML in the actual sanitizer and checks that ordinary Markdown survives. |
| Vault reads | `lib/noteRead.ts` combines allowed content trees with lexical and realpath containment. `test/mcp.test.ts`, `test/browsePaths.test.ts` and API tests exercise the reading boundary. Source URLs in `lib/sourceOrigin.ts` accept only HTTP/HTTPS; opening a downloaded original uses its native application and is not a safe-content preview or malware scan. |
| HTTP / local MCP capabilities | `lib/auth.ts` generates random bearer tokens, stores hashes on the host, compares digests with timing-safe comparison, and checks revocation. `lib/api.ts` enforces scopes before authenticated handlers. `bin/mcp.ts` authenticates each external call, and `lib/mcp.ts` exposes a bounded public tool list rather than maintenance tools. Auth, API, MCP and connected-client tests cover these contracts. |
| Integration accounts | `lib/integrationAccess.ts` and `lib/integrationTools.ts` enforce caller/account grants, distinguish reads from writes, and recheck access during/after asynchronous operations. Integration and Granola MCP tests cover revoked access and OAuth cancellation. |
| Pilot / gardener / external agents | `lib/pilotAccess.ts` restricts local writes to scratch, resolves paths, excludes credential locations, and rejects symlink/hard-link escapes. Pi sessions receive host-selected tools with extensions/skills/context-file discovery disabled (`lib/run/piSession.ts`); role-specific tools and the other provider adapter have their own tests. External connected agents retain their own harness authority and are not sandboxed by these BigBrain restrictions. |
| Credential persistence | Host/client tokens, named-client credentials, Granola credentials and vault `.env` writes use private file modes. `lib/fsx.ts` applies a requested mode before atomic publication. Config tests cover shell metacharacters, control-character refusal and `.env` mode; auth/connection tests cover revocation. Provider runtime credential storage remains owned by the respective runtime, not a universal BigBrain credential store. |

## Validation

- Full suite: **2,021 passed, zero failures** across 238 files.
- New loopback regressions: 44 assertions across the shared guard and real
  production viewer / first-run subprocesses. Rebinding Host values, foreign
  and opaque origins, cross-site/same-site metadata, and simple POST content
  types are refused; native JSON calls and loopback proxy origins remain usable.
- TypeScript, lint, production viewer build, and Svelte checks passed.
- The hostile-Markdown browser regression runs in the synthetic
  `/sidebar-workbench.html` production shell and is included in browser CI.
  Preview provenance: 0.7.27, baseline above plus this security branch's changes.
  It verifies DOM rendering, not parity with the installed native application.
- No real vault mutation, paid model request, external message, or installed-app
  replacement was used for verification.

## Limits and follow-up scope

Prompt injection can still influence a model within its granted capabilities;
validation and citations do not establish that a saved claim is true. Granting
an external agent terminal/filesystem access can bypass application-only
restrictions. Revocation cannot retract data a client already read or undo an
external write that completed before access changed.

This pass did not audit every dependency, native IPC permission, updater/build
supply chain, provider credential implementation, attachment decoder, or OS-level
race. Large uploads and resource exhaustion by authorized/local callers need a
separate availability review. Same-user malicious processes are outside the
application's authentication boundary. Vault data, journals, Git history and
backups remain plaintext unless the user protects them separately.

Before a public release, rerun these checks on the exact release candidate and
verify native WebKit/first-run behavior on a clean Mac. Repository-history and
GitHub-content publication hygiene remain a separate workstream.

## Pre-merge review

Reviewed again after integrating main at `ef778624` (desktop 0.7.28), on
combined code commit `db2469aa`. No blocking findings remained. Full local
validation passed: 2,022 tests, typecheck, lint, plugin consistency, viewer build,
and Svelte checks. Browser checks passed for hostile Markdown, connected-client
setup and first-run onboarding in the synthetic production shell. GitHub Actions
could not start because of the account billing/spending restriction; its failed
statuses are not reported as passing CI. The installed app was not changed.
