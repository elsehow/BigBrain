# UI preview parity audit — 2026-09-22

## What happened

The shared checkout was on `experiment/memory-sidebar-workbench` at `d849221`,
not main. The hover fix inherited that revision. The installed desktop was
0.7.25, built from `9f915ef` (confirmed through its bundled `BUNDLE` file).
The old preview mounted a separate sidebar controller and older text-tab code.
That version mismatch caused the visual discrepancy; it was not evidence of
current desktop behavior.

The fix branch now includes `9f915ef` and preserves the hover and pilot fixes.
The workbench and desktop both use `components/AppShell.svelte`.

## Safeguards

- Root `AGENTS.md` requires an isolated worktree based on freshly fetched
  `origin/main`, plus a comparison with the installed desktop revision for UI bugs.
- `test/uiEntryPoints.test.ts` rejects imports of bare `App.svelte` outside
  `AppShell.svelte`. It runs with the existing CI test suite.
- Full-app scenes in Workbench, typography, context, inbox, and meeting demos
  now use AppShell. Store initialization is idempotent across scene remounts.
- Every Vite development HTML page displays version, revision, tracked edit
  status, branch, and divergence from cached origin/main. This is read again on
  page load, not frozen at server startup. It does not fetch the remote or claim
  that the cached remote-tracking ref is current.
- Customized visual studies and the explicit original-layout comparison are
  labeled as studies. `left-sidebar.html` and `text-sidebar.html` deliberately
  request the baseline shell for their historical controller/CSS experiments.
- `test/support/uiEntryPoints.browser.cjs` checks the production shell and
  provenance badge across six full-app entries. The focused hover browser test
  also runs against this shell.

## Dead paths and intentional studies

Removed `RecentTab.svelte` and `SearchTab.svelte`: neither had an import anywhere
in the source tree. Removed `Doors.svelte` and `DiscussChip.svelte`: their only
caller was RecentTab. Updated the old source-inspection test that kept referring
to the retired components.

`NoteTab.svelte` is current production code, not a dead duplicate.
`PilotSessionWorkbench.svelte` is an explicitly dev-only component specimen,
not the production chat; it remains useful for isolated visual experiments.
The original-layout option and historical styling studies remain comparisons,
not evidence of desktop parity. Use `/sidebar-workbench.html` without
`layout=original` for whole-app interaction verification.
