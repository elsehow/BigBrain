# Shared application scenarios

Run `bun run test:scenarios`. The suite already runs under `bun run ci:checks`;
AppShell render coverage is in the existing `ci:browser` manifest. There is no new
CI matrix. Live provider, Pi, sandbox, process cancellation, filesystem watcher
and packaged-app tests remain in their existing homes.

`web/ui/src/dev/applicationScenarios.ts` contains five invented traces and a small
Pilot driver. Events supply fixed IDs and a seeded clock to the production
`transitionPilot` reducer. The driver records effects without executing arbitrary
work, writes state through a supplied persistence boundary, and delivers each
completion only at its declared position. Tests supply atomic scratch-file writes
and the real saved-record validator; previews substitute serialized memory.
The driver checks input immutability, expected refusals and final outcomes. Failure
messages include the seed, input sequence and actual/expected state and effects.

The same trace produces byte-equivalent application frames through both persistence
adapters. Cancellation-before-completion and completion-before-cancellation are
separate orderings. The catalog also covers queued follow-up, explicit resumption,
duplicate/conflicting delivery, restart with pending input, and a report after
archival. These replace three overlapping transition fixtures; publication
invariants and the full production Pilot host tests remain separate.

Use `bun run web:dev`, then open:

- `/sidebar-workbench.html?scenario=cancel-queued&seed=41`
- `/sidebar-workbench.html?scenario=restart-pending&seed=41`
- `/sidebar-workbench.html?scenario=archived-report&seed=41`

The scenario selector offers the complete catalog. `step=0` (or another zero-based
index) renders an intermediate frame. These previews mount production **AppShell**,
with public responses produced by the same view builders as HTTP. They are
read-only, entirely fabricated, and perform no inference or provider actions.
Only development entry points import the scenario catalog. The browser regression
asserts visible queued/answered states and absence of late/stale text.

`applicationScenarioEffects.test.ts` crosses boundaries that cannot run in a browser:

- The real AgentOrchestrator and Pi session use controlled inference promises.
  An explicit sequence attempts a stale approval, approves read access, widens
  saved policy, revokes it, delivers a late result, and restarts. It awaits request
  entry and resource settlement rather than sleeping. Two executions compare
  public outcomes; ephemeral runtime IDs, scratch paths and wall-clock timestamps
  are excluded from this semantic comparison.
- The same cancelled-Pilot trace accompanies controlled application receipt
  failures before dispatch and after the effect. Restart retains pending input,
  never starts a turn, and executes the contribution at most once.
- Ordered stream deliveries exercise gaps, duplicates, delayed batches, restart,
  stale HTTP epochs and entity revisions using the production cursor and view
  acceptance functions. Unsent text remains browser-owned throughout.

The real worker path also writes model-usage journals. Its `usage` SSE signal now
refreshes usage alone; application and accounting activity cannot invalidate vault
notes or topology. External vault writes still use the original watcher/projection
path. The existing two-view AppShell traffic regression remains in CI.

These scenarios establish application ordering and authority invariants. They do
not substitute for actual external provider behavior or OS containment tests.
