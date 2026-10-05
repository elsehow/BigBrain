# Development baseline and UI previews

Setting up a shared vault on a server, not developing? Follow
`deploy/shared-vault/README.md` and stop reading here.

- Read `CLAUDE.md` for repository workflow and architecture. Work in an isolated
  worktree; the shared checkout may be parked on an experiment, not main.
- Before creating a worktree, inspect the current branch and fetch `origin/main`.
  Start new fixes from `origin/main`, never implicitly from the checkout's `HEAD`.
  Continue an experiment only when the task explicitly concerns that experiment.
  If fetching is unavailable, state the baseline commit and the uncertainty.
- For desktop UI bugs, compare the installed app's `BUNDLE` engine revision with
  the worktree baseline before editing. On macOS it is under
  `/Applications/BigBrain.app/Contents/Resources/resources/engine/BUNDLE`.
  A preview of an older version is not evidence about the current desktop.
- Full-app previews must mount `components/AppShell.svelte`, the production entry
  shell. Only that shell may import `App.svelte`. Component-only scenes may mount
  individual production components, but must not claim whole-app parity.
- Prefer `/sidebar-workbench.html` for desktop interaction checks. Its default
  shell is production; `?layout=original` is an explicitly legacy comparison.
- Report preview provenance (version, commit, and any divergence from main).
  Keep regression coverage for the real shell and the interaction being changed.
