# Browser extension 0.9.5 — submission checklist

Updates #953. Existing listings and IDs must be preserved. Baseline: engine main e58dd739, desktop 0.7.28, installed engine 565de2ec. This is an extension release, not a desktop version bump.

Public listings audited 2026-09-25 both serve 0.6.3. Check publisher-only pending versions before reserving 0.9.5. If already used, bump once and rebuild both packages. No store upload or publication has been performed.

## Prepared assets and validation

- Three 1280×800 PNGs: `extension-0.9.5/screenshots/`. These are artboards containing real extension UI captures with fictional article/account data. Raw Chromium captures are in `source-captures/`; no full desktop-app preview is claimed. Source: this branch based on e58dd739, extension 0.9.5, including the cube-color fix; Chromium 153.0.8010.12.
- Listing text, release notes, permissions and reviewer steps below are ready to paste. Privacy-page draft: https://github.com/elsehow/bigbrain.cool/pull/15.
- Typecheck and lint pass; 62 focused pairing/extension/package tests pass (805 assertions). Website tests (5), build and mobile/desktop privacy-page layout checks pass.
- Packaged Mozilla lint: zero errors; one expected warning because Firefox ignores Chrome's `background.service_worker` and uses the supplied `background.scripts`.
- Chromium: real pairing, toolbar capture, note intake, and connection persistence across browser restart pass against a disposable vault. The Chrome store automatic-update path is still pending; replacing unpacked files did not reliably simulate it.
- Firefox 140.0, 141.0.3 and 156.0.1 (official Mozilla builds): both fresh temporary installs and upgrades from the published 0.6.3 pass pairing, toolbar capture, note intake, reopening without recapture, revoked-access refusal and reconnect. Upgrade tests confirm retired hosted credentials are cleared. The declared minimum remains 140.0.
- The earlier Firefox compatibility blocker was a test-installation defect: Selenium's base64 upload through geckodriver deleted the temporary XPI, while older Firefox content processes still needed it. The parent could serve cached options/scripts, masking the missing archive; injected files failed with `NS_ERROR_FILE_ACCESS_DENIED`. The retained test installs by persistent canonical path and asserts the backing archive exists. No security preferences are disabled in the passing runs.
- The extension now also handles Firefox's resolved per-frame injection errors, routing them through the existing failure/PDF path instead of waiting for the popup timeout. Regression tests cover both injection stages.
- Still pending: publisher-only version reservation, signed-store fresh/upgrade and restart checks, Chrome real-browser revoked-access/reconnect checks, review/signing and publication. Keep #953 open; Firefox compatibility is no longer a blocker.

Reproduce Chromium checks from the engine root: run `bun test/support/extensionStoreHarness.ts`, then use its printed loopback base as `EXTENSION_TEST_BASE` when running `node test/support/extensionStore.browser.cjs`. Optional `EXTENSION_SCREENSHOTS` writes raw captures. The harness creates a scratch vault and no supervisor/model jobs; stop it with Ctrl-C to delete it. Render artboards with `EXTENSION_SCREENSHOTS=docs/releases/extension-0.9.5/source-captures STORE_ARTWORK=/tmp/store-artwork node test/support/extensionStore.artwork.cjs`.

For Firefox, build with `bun run site:build`, install `selenium==4.49.0` in an isolated Python environment, and run `EXTENSION_TEST_BASE=<harness base> python test/support/extensionStore.firefox.py`. Set `FIREFOX_BINARY` to a test browser binary (defaults to the installed macOS Firefox). Set `EXTENSION_OLD_FIREFOX` to the published 0.6.3 XPI for the upgrade case. `EXTENSION_XPI` overrides the candidate package. Each run creates a fresh browser profile and removes it on exit. Run cases sequentially: the harness issues one pending pairing code and its revocation check invalidates all test credentials.

## Release order

1. Publish the reviewed website privacy page at https://bigbrain.cool/privacy/ (separate elsehow/bigbrain.cool PR). Confirm HTTP 200.
2. Build packages with `bun run site:build`; `site/dist/plugins/bigbrain-chrome-0.9.5.zip` and the identical unsigned XPI are store-upload inputs. The XPI is NOT a signed public install. Inspect archive contents; include LICENSE, vendored notices and fonts/OFL.txt; exclude preview.html and local test artifacts.
3. In Chrome Developer Dashboard, open item ddnflabpbjfcakilfjmbinhblgbmckpb → Package → Upload New Package. Update Store listing and Privacy practices. Supply current screenshots and reviewer steps. Submit for review; choose deferred publication if coordinating launch.
4. In AMO Developer Hub, open send-to-bigbrain → Manage Status & Versions → Upload a New Version. Keep GUID extension@bigbrain.cool. Update listing, privacy policy, license (AGPL-3.0; vendors/fonts retain their notices), release notes and reviewer notes. Follow source-submission prompts: explain no application build step and include upstream source/version references for vendored minified libraries when requested. Do not upload the private engine repository or its history.
5. Verify clean store installs and updates from 0.6.3. Old hosted credentials are intentionally cleared; returning users must pair with the desktop app. Check page capture, note enqueue, repeat capture, revoked access, reconnect and browser restart.
6. After BOTH stores offer the approved desktop-compatible version, publish this PR's release-assets /plugins page using `bun run site:deploy extensions`. Until then retain the existing manual downloads page. The app already opens this chooser; no app release is needed for its links to change.

No store review approval, signing, automatic-update delivery or paid/authenticated account access can be inferred from local temporary-addon tests. Re-check store manifests and pages after publication. Desktop support claims must match the available desktop download; do not advertise Android support merely because the manifest accepts it.

## Suggested listing text

Short description: Save web pages and notes to your BigBrain vault. Requires the BigBrain desktop app.

Save the page. Keep the context.

Send to BigBrain saves web pages as Markdown in your BigBrain vault. Add a note about why a page matters, then let the BigBrain desktop app organize and connect what you save using your configured model provider.

- Capture the page you are reading with the toolbar button or context menu.
- Add your own note alongside the capture.
- Copy a discussion prompt to use with your connected assistant.
- Pair with your desktop app using a one-time code.

Requires the BigBrain desktop app, a configured vault, and a running app when capturing. Page capture starts when you invoke the extension; it does not upload your browsing history. By default captures go to BigBrain on your computer. If you choose another endpoint, they go there instead. Your desktop app may send saved material to the model provider you configure for processing.

Updating from the earlier hosted version? Install the desktop app and pair your browser again. The old hosted Google sign-in is no longer used.

## Release notes

Connect directly to the BigBrain desktop app with a one-time pairing code. Refreshed extension styling, page-title handling and capture workflow. Includes page and note capture and a copyable discussion prompt. Old hosted connections are removed; please pair again after updating.

## Permission and data explanations (review against dashboard questions)

Single purpose: save user-selected web content and accompanying notes to the user's configured BigBrain vault.

- activeTab + scripting: read the invoked tab and convert its content to Markdown when the user captures it.
- contextMenus: provide the Send to BigBrain context-menu action.
- storage: retain the endpoint/pairing credential locally and keep capture/note state; not browser-account sync.
- loopback host access: pair and send to the local desktop intake API.
- optional host access: user-configured remote endpoints and supported PDF capture when the browser requires site permission. No blanket browsing-history upload.
- Website content and URLs/titles, user-entered notes, and page metadata can include personal information. Do not declare that no data is handled merely because the default destination is local.
- Authentication token is stored locally and sent to the selected intake endpoint. Pairing exchanges browser type and receives an account/display label. No extension analytics SDK, ads, or remotely hosted executable code; browser-store update checks are browser-managed.

## Reviewer steps

Install BigBrain for supported macOS from https://bigbrain.cool. Open it and create a disposable vault. In Settings → Integrations → Browser extension choose PAIR A BROWSER. In the extension options, keep http://127.0.0.1:4748, paste the one-use code, and Connect. Open a public article and click the extension: expect IN THE VAULT. Enter a note and press Enter: expect NOTE QUEUED and the popup to close. The desktop app must remain running. Model-provider configuration is needed for subsequent AI processing, not transport pairing/capture. Use only fabricated/public material. Revoking the browser in BigBrain should refuse future captures until re-paired.

Chrome update docs: https://developer.chrome.com/docs/webstore/update
AMO submission docs: https://extensionworkshop.com/documentation/publish/submitting-an-add-on/
