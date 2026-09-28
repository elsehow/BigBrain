---
name: verify
description: How to run and verify web UI / config / engine changes against a sandbox vault instead of the real one
---

# Verifying engine changes

Never verify writes against a real vault. Viewer actions write to the root chosen
by `BIGBRAIN_VAULT`; tests must use fabricated data and an isolated worktree.
Reviewed against engine `38b78005` on 2026-09-26.

1. Create a scratch directory with `vault.yaml` from `vault.example.yaml`,
   invented record data, and a fresh git repository. Do not copy a real vault,
   its configuration, credentials, prompts, or excerpts. Prompts come from the
   engine; do not seed a vault-local `prompts/` directory.
2. In the isolated engine worktree, run `bun install --frozen-lockfile` and
   `bun run web:build`. `bun run ci:checks` covers plugin consistency, lint,
   engine types, the UI build, unit tests, and Svelte checks.
3. For server-backed checks, run
   `BIGBRAIN_VAULT=<scratch> PORT=4799 bun <engine>/web/server.ts` and drive
   `http://localhost:4799`. Keep machine configuration and provider stores in
   a disposable home too. Do not connect personal credentials for deterministic
   checks; use the suite's scripted Pi provider seam and scratch integration stores.
4. For fabricated whole-app previews, use `/sidebar-workbench.html`, which mounts
   production `AppShell.svelte`. `/dev.html` provides individual component scenes.
   Compare the installed app's `BUNDLE` revision before interpreting desktop bugs;
   report preview version, commit, and divergence from main.
5. Verify expected durable effects in the scratch vault, including git history,
   logs, `.spool/` pending data, conversations, and action receipts. Confirm restart
   does not replay uncertain effects. `.state/` is rebuildable; `.spool/` is not.

App-owned model work runs through embedded Pi, never a headless native Claude or
Codex runner. Deterministic tests exercise actual Pi sessions with scripted model
responses. External Connected Clients have a separate optional runtime and must
not be confused with BigBrain model authentication. A real provider smoke test
sends data to that provider and must use only deliberately configured scratch data.

The engine typecheck excludes tests and Svelte components; runtime tests and
`bun run --cwd web/ui check` cover those separate surfaces. The UI uses hashed
assets from `web/ui/dist`; hard-reload after rebuilding.

Packaged native verification requires the containment procedure in
[test/support/native-smoke](../../../test/support/native-smoke/README.md).
A HOME override alone does not contain macOS WebKit/XPC processes. Use its offline,
disposable VM procedure before launching a candidate app; browser previews do not
prove native WKWebView lifecycle, first-run, install, or shutdown behavior.
