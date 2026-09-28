# In-app feedback (#952)

## Status and destination

Local implementation, external synthetic readback, and IP suppression are verified;
**#952 is not ready to close** pending the release gates below.
On 2026-09-25, read-only PostHog `project-get` matched the public token in
`lib/telemetryConfig.ts` exactly to **Default project, 619325 (US)**.
The user then explicitly authorized survey creation and one synthetic submission.
Survey: [BigBrain in-app feedback](https://us.posthog.com/project/619325/surveys/01a0d95f-185b-0000-c84e-7c408d388d77).

`lib/feedbackConfig.ts` now contains survey ID
`01a0d95f-185b-0000-c84e-7c408d388d77` and open-text question ID
`0d441200-c699-4b39-89e0-1b422647c158`. The survey remains a draft; draft status
did not prevent the verified API response from being stored and read back.
The public token and region reuse the shipped project configuration, independently
of environment overrides for optional analytics. No personal/admin key ships.

## Implementation and privacy

The lower-right Feedback action is mounted by production `AppShell.svelte`.
It follows the existing chrome visibility, is reachable by keyboard, and opens
a themed dialog. Closing/reopening and failed submissions retain the draft in
memory; restarting/reloading the app does not. Only success clears the draft.
The form captures generic panel/layout context when opening a new draft and
keeps it with retries. Escape returns focus to Feedback; modal keys cannot
trigger app navigation. The endpoint is available both before vault setup and
in the desktop viewer.

The local `POST /api/feedback` endpoint validates the complete request and sends
one `survey sent` event using PostHog's existing ingestion endpoint. The form
does not load a browser SDK or native widget. The browser contacts only its own
origin; the engine sends to the fixed PostHog US endpoint. CSP is unchanged.
The PostHog [custom survey documentation](https://posthog.com/docs/surveys/implementing-custom-surveys)
describes the `survey sent` event and ID-based response properties used here.

The request allowlist is message (1–4,000 characters), random submission UUID,
generic panel enum, standard/expanded layout, and validated app version (or
`unknown` in a browser). The engine adds platform, event timestamp, survey and
question identifiers, completion marker, and profile/geolocation suppression
flags. The submission UUID is also its one-use identity, never the telemetry
installation ID. There are no vault identifiers, note titles, content, paths,
queries, selected entities, chat text, screenshots, recordings, URLs, arbitrary
state, or error stacks attached. User-entered message text is intentionally sent.
The form now uses the short disclosure “Only your message and basic app diagnostics
are sent—not your vault contents.” and a Read more link to
`https://bigbrain.cool/privacy`. The local website privacy draft explains the
recipient, region, attached fields, user-entered sensitive text, and IP-discard
limits. Publishing the reviewed policy at that URL is a release gate; it currently
returns 404. The first readback showed `$geoip_disable: true` alone did not prevent `$ip` storage.
With subsequent explicit user authorization, project 619325 now has the
[documented IP discard setting](https://posthog.com/docs/privacy/data-storage)
enabled (`anonymize_ips: true`). This applies to all newly ingested events in
the project, not just feedback; it does not retroactively erase old event IPs.
The second synthetic readback confirmed effective non-retention. No actual IP
address is copied into this document.

This is stored-event IP suppression, not a guarantee that the network IP never
reaches PostHog or is absent from provider infrastructure logs. PostHog documents
that transformations may use the IP before discard. Feedback continues to send
`$geoip_disable: true`; its readback contained no geolocation or session data.
Keep `anonymize_ips: true` as a release requirement. The app's public ingestion
token cannot enforce or monitor this administrative setting; changes to the
project/destination require a fresh configuration check and synthetic readback.

Optional analytics stays off when off. Existing telemetry consent gates remain
unchanged and are covered by regression tests. Feedback uses a separate explicit
Send action, not `Telemetry.enqueue`, temporary opt-in, or an SDK opt-out override.
No browser SDK is initialized, so project recording/autocapture settings cannot
start recording through this feature. No extra service is needed.

The UI prevents duplicate submits while sending. The engine serializes delivery
and remembers up to 100 submission hashes/receipts in memory (not message text).
An unchanged retry uses the same UUID and event timestamp; success is deduplicated
within that bounded process lifetime. A modified draft gets a new UUID. There
are no background retries or persistent queues. A lost acknowledgement still
requires verifying PostHog's ingestion deduplication during external validation;
we do not claim durable exactly-once delivery across engine restarts.

## Verified external setup

With explicit user approval, this survey was created in **project 619325** as a
draft at 2026-09-25T16:21:23.167552Z:

```json
{
  "name": "BigBrain in-app feedback",
  "type": "api",
  "schedule": "always",
  "questions": [
    { "type": "open", "question": "What could we improve?", "optional": false }
  ]
}
```

PostHog automatically created its inactive internal survey-targeting flag. The
only separately authorized project-setting change was IP discard, documented
below. No existing flags, replay, analytics consent, or hosted widgets were changed.

A one-shot harness opened production AppShell in WebKit at the synthetic
`/sidebar-workbench.html` scene and submitted through the actual `feedbackRoutes`
and `Feedback` sender. It mounted only the feedback route on a temporary loopback
server, used a scratch telemetry consent file set to `enabled: false`, and verified
that consent stayed off. All other UI data was synthetic. The harness guarded
against more than one external transmission and recorded the allowlisted payload.

At **2026-09-25T16:22:51.236Z**, PostHog accepted event UUID
`12cc522d-1686-488c-8a51-fd961078dbec` with HTTP 200; the form displayed success.
`surveys-responses-list` then returned exactly one response, with this same UUID,
timestamp, stable question ID and exact text:

> SYNTHETIC TEST for BigBrain #952 - delivery verification only; no vault data.

The response had no session ID, URL, browser, or geolocation fields. A narrow
event lookup additionally confirmed `platform: darwin`, `panel: home`,
`layout: standard`, `app_version: unknown` (a browser preview, not a native app),
the suppression/completion markers, and the automatically stored `$ip`.
No vault data was included. No duplicate response was sent: local deduplication
is tested, but PostHog's behavior on a repeated network event remains unverified.

## IP suppression verification

On the user's explicit instruction that IP suppression is required, the exact
project update was `{"id":619325,"anonymize_ips":true}` at
**2026-09-25T16:50:23.272947Z**. A fresh `project-get` comparison against the full
pre-change snapshot showed only `anonymize_ips: false -> true` and `updated_at`
changed. No other settings were submitted or changed.

The same one-shot WebKit/production-AppShell/local-route harness sent one new
synthetic message, with scratch analytics consent still disabled:

> SYNTHETIC IP-DISCARD TEST for BigBrain #952 - no vault data.

PostHog returned HTTP 200 and the form showed success. Survey readback resolved
the exact message under the same stable question. A narrow event query compared
the two test UUIDs without returning either IP value:

| Test | Event UUID | Timestamp (UTC) | Stored `$ip` non-null |
| --- | --- | --- | --- |
| Original delivery | `12cc522d-1686-488c-8a51-fd961078dbec` | 2026-09-25 16:22:51.236 | Yes |
| IP discard | `9ed504f3-c0d0-40b9-8ecd-38ddf92ff72c` | 2026-09-25 16:51:00.106 | No |

Both retained the intended synthetic message and generic metadata; neither
included vault data. The new event kept `$geoip_disable: true`, `platform: darwin`,
`panel: home`, `layout: standard`, and browser-preview `app_version: unknown`.
There are now two authorized synthetic responses in this survey. No historical
event was deleted or modified; **the first test's IP remains stored**. Historical
cleanup requires separate user approval.

The IP-suppression release requirement is met with the current project setting
and verified new event. Remaining release gates: review and ship the code/config;
run a packaged native-app smoke test; decide when to launch the API survey from
draft with the release. No issue closure/comment, push, PR, or deployment occurred.

## Validation and provenance

Worktree: `.claude/worktrees/codex-issue-952-feedback`, branch
`codex/issue-952-feedback`. Baseline: fresh `origin/main` at `18f92906`, desktop
version `0.7.28`. Installed app BUNDLE: `565de2ec`, built 2026-09-25T15:48:03Z.
The installed app was not used as evidence for current behavior. During work,
cached main advanced one commit to `e58dd739` (#954); this preview is based on
`18f92906` plus only the feedback changes and does not include #954.

Automated regression validation uses synthetic data and mocked delivery. The two
separately authorized real PostHog submissions are documented above:

```sh
bun test test/feedback.test.ts test/telemetry.test.ts test/httpx.test.ts test/firstRun.test.ts test/desktopCommands.test.ts
bun run typecheck
bun run lint
cd web/ui
bun run check
bun run build
bun run dev --host 127.0.0.1 --port 5295 --strictPort
# From the worktree root, while Vite is running:
FEEDBACK_PREVIEW_URL=http://127.0.0.1:5295 node test/support/feedback.browser.cjs
FEEDBACK_BROWSER=webkit FEEDBACK_PREVIEW_URL=http://127.0.0.1:5295 node test/support/feedback.browser.cjs
FEEDBACK_PRODUCTION=1 FEEDBACK_PREVIEW_URL=http://127.0.0.1:5295 node test/support/feedback.browser.cjs
FEEDBACK_PRODUCTION=1 FEEDBACK_BROWSER=webkit FEEDBACK_PREVIEW_URL=http://127.0.0.1:5295 node test/support/feedback.browser.cjs
```

All 49 focused backend, telemetry, HTTP, first-run and desktop tests pass. Both browsers pass empty input, duplicate
submits, offline/server failure, draft retention, retry identity, keyboard/focus,
chrome visibility, and narrow-window layout checks through production AppShell.
Built-entry mode loads the actual production bundle with synthetic API responses
under the production CSP and asserts zero CSP violations. This is browser/WebKit
coverage, not a rebuilt native Tauri app test. TypeScript, lint, Svelte checks
(zero errors/warnings), and production build pass; Vite reports its large-chunk
advisory. Native packaged-app smoke testing remains outstanding; PostHog readback
is now verified. The ID wiring was followed by another passing 49-test run,
typecheck and lint. The disclosure addition is covered by the browser regression.

## Simplified disclosure and privacy draft

The website policy lives in `elsehow/bigbrain.cool`, isolated branch
`codex/privacy-page` based on `6fbc59e1`. Its `privacy.md` and `privacy-audit.md`
distinguish current website behavior from unreleased app feedback and record
owner questions about retention, infrastructure logs, contact, and deletion.
No blanket no-PII promise is made. The Read more link is included in the modal
focus cycle and tested in the production AppShell.

The synthetic sidebar workbench supports `?feedback=success` and a simulated
outcome selector; Send never reaches the server in those fixture modes.
No external submission was made for these copy and policy changes.

## Deletion verification gate

A subsequent bounded deletion investigation stopped before submitting a third
synthetic response: official docs and tool schemas did not establish supported
removal of our personless event. See [evidence, gated runbook and unsent support
question](feedback-deletion-verification.md). No historical records were changed.
Remote deletion remains unverified and must not be promised in the privacy page.
