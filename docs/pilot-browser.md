# Pilot previews and browser testing

Pilot can show and test a self-contained static site or built web app without
launching Chrome from its shell sandbox. This uses MIT-licensed Playwright and
its matching Chromium build. Pi and Claude receive the same tools and approvals;
neither model provider owns the capability or launches the browser.

1. Build the app with `run_command`, using the existing folder grants and sandbox.
2. Request `request_browser(reason)`. BigBrain pauses for an explicit per-session
   Allow/Decline decision. This grants browser testing, not additional file access.
3. Call `start_preview(directory, title)` for a granted folder containing
   `index.html`. BigBrain copies a snapshot inside the command sandbox, then
   serves that snapshot on an authenticated, randomly chosen loopback port.
4. Use `browser` to navigate local paths, inspect an accessibility snapshot,
   click/fill/press controls, assert text, or save a screenshot. Screenshots appear
   in the conversation's browser panel.
5. The user can select **Open preview** to open the same snapshot in their normal
   browser. Its cookies, form inputs, and storage are independent of automation.
   Call `start_preview` again after edits; refresh replaces the URL and test profile.

**Stop preview and browser** revokes this session's capability and closes its
server/browser. Stopping an individual model turn cancels an in-flight browser
operation; an already idle preview stays available. Deactivating the Pilot,
revoking its folder access, or shutting down the engine closes the capability.
Adding a folder grant preserves browser approval. Approval does not survive an
engine restart. Decline is remembered until the user clears the decision.

## Scope and trust

- Arbitrary commands continue to use the OS command sandbox. The browser runs as
  application-owned host software, with Chromium's native renderer sandbox
  explicitly enabled. It receives a private profile and a minimal environment,
  never personal browser cookies or inherited provider credentials.
- Tools expose fixed actions, with no host JavaScript evaluation, shell/launch
  arguments, personal profiles, uploads, remote browser endpoints, or arbitrary
  URLs. At most four sessions may have previews. Operations have timeouts and
  respond to cancellation.
- The snapshot copy uses a fresh, restricted sandbox even for a session with
  unrestricted command access. Hidden entries, symlinks, and `node_modules` are
  omitted. Limits: 100 MB, 5,000 files, 32 directory levels. Choose a build output
  folder; all nonhidden regular files in that folder are included.
- The app stores snapshots/profiles under protected `.spool/pilot-browser/`.
  Snapshot staging uses protected `.spool/pilot-preview-staging/` on the same
  filesystem, so external-drive vaults can publish with an atomic rename. Only
  the fixed copy script gets access to its private staging directory; ordinary
  agent commands cannot edit it. Publishing rejects a symlink as the snapshot root.
  Browser sockets use a short private directory beneath protected
  `/tmp/bb-browser-<uid>/`, independent of the vault path's length.
  The server checks its Host header, serves only GET/HEAD, and requires a random
  HttpOnly SameSite cookie bootstrapped by the private Open preview URL. It rejects
  cross-origin requests, hidden paths, traversal, and symlinks. Links are local to
  this machine; keep them private. A preview is not publicly hosted.
- CSP restricts the served app's resources, frames, workers, and connections.
  The automated browser additionally routes HTTP requests only to its own preview
  origin, rejects WebSockets, blocks service workers/downloads, and closes popups.
  These are defense-in-depth restrictions for self-contained previews, **not an
  OS-enforced network isolation boundary**. The user's normal browser is outside
  the automation capability; opening a preview there does not authorize agents to
  control that browser. Normal links can still navigate the user's tab elsewhere.
- This does not support arbitrary native apps, external websites, backend/dev
  servers, API-dependent apps, live reload, or sharing automation's live browser
  window. “Show test browser” is deferred. Unsupported apps should report the
  limitation rather than request broader shell access to Chrome.

## Build and verification

`playwright-core` is an exact production dependency. `bun run browser:install`
installs its matching Chromium into that package. Desktop resource assembly does
this at build time; a packaged app never downloads a browser on demand or searches
for the user's Chrome. This adds Chromium's size to the desktop bundle. Updating
Playwright/browser is a desktop release change, including security updates.

Run `BIGBRAIN_TEST_BROWSER=1 bun test test/pilotBrowser.test.ts` after installation
to exercise the real command sandbox, browser, forms, screenshots, cancellation,
profile isolation, blocked outside requests, refresh, and teardown. CI runs this
on macOS and Linux. `test/pilotAccess.test.ts` covers provider-neutral approval,
folder changes, and restart. The workbench has approval/ready scenes at
`/dev.html?c=permissions&s=pilot-browser-request` and `pilot-browser-preview`.
Run `test/support/pilotBrowser.browser.cjs` against a Vite workbench to exercise
the actual approval, decline, opening, and stop controls without any vault.
