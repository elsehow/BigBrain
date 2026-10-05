# Integration activation study

Dev-only prototype: Settings → Integrations shows active/inactive rows. Activate
requires account access, an editable suggested remembering rule, and a final
confirmation. Cancel, failed/incomplete access, and blank rules remain inactive.
Deactivation keeps the saved rule; reactivation requires account access again.
History scope belongs in the rule, not a separate import-mode selector.

## Agreed boundaries

- **Integrations** consume external sources through their MCP tools.
- **BYO agents** consume BigBrain MCP, aided by skills/plugins, independently.
- **Connected agents** are agents BigBrain can pilot.

Integration tools are intended for the gardener, Pilot and authorized agents,
with caller-scoped grants. Reading does not automatically drop evidence or
remember anything. Source writes need separate approval. Skills describe tool
use; they are not independent authorization. These are design commitments, not
capabilities implemented by this PR. That Tracks MCP remains proposed.

Later work includes provider authentication, tool exposure and grant enforcement,
evidence admission, rule interpretation, bounded historical reads, durable
checkpoints and recurring sync with honest coverage reporting. None is wired up
here; all accounts, authorization, state and saves are fabricated and page-local.

## Review the preview

From `web/ui`, run `bun install --frozen-lockfile` and `bun run build:integrations`.
Serve `web/ui/dist-integrations` as static files. Its entry is `index.html`.

- `/index.html?scene=inactive&theme=default#/integrations`
- `/index.html?scene=inactive&theme=dusk#/integrations`
- `/index.html?scene=active&theme=default#/integrations`
- `/index.html?scene=inactive&auth=fail&theme=dusk#/integrations` (retry succeeds)

The real production AppShell, SettingsPage/Rail and theme picker are used. Only
the preview build aliases IntegrationsView. No production behavior changes.
General → Themes or the single simulation badge opens the real palette picker;
no personal-theme match is claimed. Build version/commit appears in that badge.
The remote font import is removed for offline system fonts. Storage and fetch
are substituted before app modules load; unknown APIs never fall back to network.
The entry selects the Integrations route before AppShell initializes. CSP blocks
connections; no live vault, credentials, provider, OAuth or model is accessed.

Verify from the repository root:

```
bun test test/integrationActivation.test.ts test/settingsViews.test.ts
node test/support/integrationActivation.browser.cjs
```

The browser test serves the actual static build on loopback and uses headless
Chrome. It covers initialization, activation gates, cancellation, failure/retry,
deactivation/re-entry, real themes and static-asset-only traffic. Chrome must be
installed; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select a different binary.

The current production Settings rail remains unchanged. At phone width it
leaves a cramped content column and can overflow (also measured in unmodified
General settings); this PR does not carry the older study's custom rail layout.
Desktop/tablet layout and both theme palettes are covered. Production and preview
builds retain Vite's large-chunk advisory.

### Granola source contract

Granola remembering imports provider attendee metadata (`known_participants`) and
verbatim transcript text, with the meeting title, date and link. Vendor summaries
and enhanced notes are discarded before staging. Transcript access is required;
a missing or empty transcript leaves the meeting retryable, never a summary-only
substitute. No model corrects ASR or infers speakers during ingestion.

Per-account inclusion rules were retired on 2026-10-05 (#80). Remembering is
on or off; what a remembering account stages is admitted unless the worth gate
(`lib/worthGate.ts`) passes it. A `rule` or `inactiveRule` left in an older
policy file is ignored. Older pending Granola payloads remain retained until
refreshed as transcript-only payloads and are never admitted automatically.
