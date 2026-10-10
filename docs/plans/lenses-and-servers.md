# Lenses and servers

Status: plan, 2026-10-09. Mockups: the "BigBrain Lenses" design canvas
(Settings, Joining a server; superseded screens on its Archive page).

## The model

- **Lenses are yours.** A lens is a named rule over your vault, plus the notes
  you added or removed by hand. It is always exact: editing the rule both adds
  and removes, and you see which before saving. Lenses live on your computer.
- **Servers collect lenses.** A server (today's "shared vault") holds the notes
  that members' lenses send it. Its admin invites people with read or
  read-and-write access. Anyone can read every server they belong to; with write
  access they can share any of their lenses there.
- **Sharing is deliberate.** A lens is shared with one server at a time, inside
  Edit a lens or on the server's page, and confirmed by typing the lens's name.
  Joining a server shares nothing.
- **Rules stay private.** Other members see your notes, never your rule.

## Phase 0: no data-model change (start now)

**0a. Settings sidebar and copy.** The sidebar becomes GENERAL (general, models,
integrations, lenses), AGENTS (connected agents), SERVERS (each server,
`+ Connect a server`), SYSTEM (security, diagnostics). "lenses" can land with
Phase 1; the renames don't need to wait.
- Tabs and rail: `web/ui/src/lib/settingsViews.ts:5-14`,
  `components/SettingsRail.svelte:32-40`.
- Route conflict: `lib/store.svelte.ts:103` already sends `connectedAgents` to
  `pilotSettings`. Repoint it to the connected-clients screen.
- Strings: `ConnectedClientsView.svelte:5`, `ExpiredClientNotices.svelte:40`,
  `IntegrationReads.svelte:36`, `ConnectedClientList.svelte:43`,
  `lib/auth.ts:199`; shared-vault copy in `SharedVaultSettings.svelte:28,42,44`,
  `SharedVaultMembers.svelte:57,66,76`, `FirstRun.svelte:112-116`.
- Tests that pin the old labels: `pilotExecutionRetired.browser.cjs:16-17`,
  `settingsLists.browser.cjs:21`, `connectedClients.browser.cjs:40,69-70`,
  `test/tokenExpiry.test.ts:14,176`, and four browser tests that click
  `+ Connect vault` (`sharedWorkspace`, `sharedMembership`,
  `sharedMembershipEmail`, `sharedFreshMember`).

**0b. Server page** (replaces `SharedVaultSettings.svelte`'s three tabs), all on
existing endpoints:
- People: circles from `GET /v1/members` (any reader may list; only the admin
  also sees pending invites), admin first and inverted, `+N` opens a searchable
  list.
- On this server: a table with search. Everything comes from `GET /v1/evidence`
  and `/v1/search`, with Added by from each insertion's `submitted_by`. Yours
  comes from the local contribution receipts.
- Until Phase 1, the server's single rule stays editable below the table.

**0c. Say where shared notes come from.** Search, graph and notes already merge
every server into personal reads (`lib/sharedReadUnion.ts`), with no label.
`node.vaults` exists and nothing renders it. Show the server name on shared
records. Depends on E2.

## Phase 1: lenses (the refactor)

**1a. Lens store.** One local file per lens: name, rule text, teaching labels,
pins, exclusions, calibration, version; plus an attachments map from lens to
servers. This replaces two copies keyed by connection: the policy at
`inclusion-rules/sha(root)/sha(scope)` (`lib/inclusionPolicy.ts:9-10`) and the
rule in `store.rules.json` (`lib/sharedRules.ts:16-23`). Migration: each
server's rule and labels become a lens named after the server, shared with it;
withdrawn contributions become exclusions.

**1b. Membership.** pins ∪ (score ≥ threshold) − exclusions. Pins and
exclusions are hard overrides and do not teach the model. Today every label does
both (`lib/inclusionEvaluation.ts:24`, `lib/inclusionExamples.ts:6`). Take pins
and exclusions out of the score-cache identity
(`lib/inclusionEvaluation.ts:12`), so adding or removing a note by hand doesn't
discard every cached score.

**1c. Exact on edit.** Saving a rule rescores a candidate pool (ranked
prefilter, top K, plus the lens's current members), shows joins and leaves, and
applies them on save. If the lens is shared, Save first asks: "Every member of
[server] will be able to read every item in this lens. **Check the items you're
sharing.** Proceed?" and stays locked until the lens's name is typed. New
arrivals are scored once per lens, not per server.
Today nothing is withdrawn when a rule changes, and forward sharing stops with
"Review this inclusion rule again" whenever the model or an entity alias changes
(`lib/inclusionEvaluation.ts:23`). Replace that stop with the policy from D3.

**1d. Publishing per server.** Joins contribute; leaves withdraw. A save sends
its whole diff in one request: today each note is its own `POST /v1/evidence`
and each withdrawal its own `/v1/contributions/:id/withdraw`, so the server
needs a batch route. A note matched by two lenses
shared with the same server is contributed once. Local receipts (keyed
`${connection}:${insertion}` today, `lib/sharedRules.ts:70`) gain the lens id,
for the server page's Yours tab.

**1e. Screens.** Settings › lenses; Edit a lens (reuses
`InclusionRuleEditor`, `InclusionRuleReview` and its note picker; table with
Everything, Joining, Leaving, Removed); the type-the-name dialog; "Lenses you
are sharing" on the server page; the feed items from D2 and D3, D3's
warning and what-changed popup on the lens, and the Sharing setting.

## Phase 2: joining

**2a. Invite page.** Today `/invite` is mounted only in the connector's route
table (`lib/sharedOAuth.ts:938`), so without `--public-url` every path is 401.
Serve it always (D4), with Open in BigBrain and Get it for Mac. `/invite/check` already reports
the server's name without using up the invite.

**2b. Links into the app.** Nothing is registered today (Tauri 2.11; plugins:
updater, dialog, opener, log). Add `tauri-plugin-deep-link` and
`tauri-plugin-single-instance`. `bigbrain://connect?invite=…` opens Connect a
server with the link filled in. The invite is still used up only on Connect
(`lib/sharedConnections.ts:43-53`).

**2c. First run.** "Join a server" sits under Create and Open. Today it is in
step 4, and the app cannot run without a vault (`lib/vaultRoot.ts:28`; the
setup-only server doesn't mount the shared APIs, `bin/desktop.ts:193`). See D1.
Connections are already stored per machine, not per vault
(`~/.config/bigbrain/shared-connections.json`).

**2d. Connect your AI.** Not part of joining (D5): offered the first time
someone tries to add something or connect an integration, reusing first run's
providers step (`SubscriptionConnect`) and clients step (`ClientChecklist`).
Setup counts as done only once something powers the vault
(`web/ui/src/lib/setup.ts:100`), so a joiner with no provider needs that gate
relaxed. See D5.

## Decide

- **D1. Joining without a vault. Decided:** "Join a server" quietly creates an
  empty vault at the default `~/vault` (`bin/desktop.ts:449`), connects, and
  opens the app. A mode with no vault at all would touch server startup, setup
  and every read path.
- **D2. Consent for future matches. Decided:** typing the lens's name when
  sharing covers future matches too; the dialog already says "every item in
  this lens". Rule edits always preview joins and leaves. Each future match adds
  a feed item, "[truncated title…] is shared with [server]", that opens the lens
  responsible. Feed rows are assertions today (`lib/v2Feed.ts`); this is a new
  row kind, read from the local share receipts (1d).
- **D3. When scores shift without an edit** (the model is upgraded, or an
  entity's aliases change). **Decided:** leaves always apply automatically.
  When a change makes a shared lens include notes it didn't before, a setting
  at the bottom of Settings › general picks what happens:

  > # Sharing
  >
  > Sometimes, a model upgrade or vault change will cause a Lens to include
  > items that weren't included before. If you've shared that Lens to a Server,
  > old items may be suddenly shared. When this happens, **Conservative** mode
  > pauses all new additions to Lens until you review the changes. In
  > **Yee-haw** mode, the lens will keep adding items (but alert you, so you
  > can review the change).
  >
  > Yee-haw [toggle] Conservative

  Conservative is the default. It pauses every addition to the lens, new notes
  included, so a rule that has become too liberal can't keep sharing while the
  review waits. This is today's behaviour, per lens instead of per connection
  (`lib/inclusionEvaluation.ts:23`). Its feed item: "A [model upgrade/vault
  change] would cause you to share new items with [server]. Lens is paused
  until you review." Yee-haw shares the new matches, with the feed item "A
  [model upgrade/vault change] has caused you to share new items with
  [server]." Either item opens the lens. In both modes the lens shows a warning, and a
  popup lists what changed since the last upgrade. "Looks OK" dismisses the
  warning for good and, in Conservative, resumes the lens. "Edit rule" opens
  the rule editor, and the warning stays until a new rule is saved. E4 tells us
  how often this happens.
- **D4. Invite page always on. Decided:** every server serves `/invite` and
  `/invite/check`, whether or not it runs the Claude connector. Servers still
  support the connector; when it's on, the invite page says so at the bottom.
- **D5. Connecting an AI. Decided:** someone who joins read-only goes straight
  to the server's notes, with no AI or integration step. BigBrain asks only when
  they first try to add something or connect an integration. It then asks for
  what first run's steps 2 and 3 ask for today: a provider (a Claude or ChatGPT
  subscription), which is what runs the gardener and so is required before
  anything added gets filed, then the clients Claude Code and Codex. No Claude
  Desktop, Cursor or Windsurf for now; Claude Desktop only if someone needs it,
  and it would be a client, never what powers the vault. claude.ai stays out:
  it can't reach the app, only a server's read-only connector.
- **D6. Drop the Sources column and the Sources filter for now.** The app has no
  user-facing source field; "source" in the code means any item. Envelope `kind`
  and `source` exist if we want them later.
- **D8. Notes too big to score. Decided:** lenses only (not the forward rule
  path or anything else) score a stand-in for notes over the limit: a Quick
  summary of the whole note. One summary per note serves every lens. Cache it
  keyed on the note's digest, the Quick model, and a summary-prompt version, so
  a model change or a prompt change refreshes it and a rule change never does.
  Summaries of the largest notes cost more than today's $0.05 cap per Quick
  call, so they need their own cap, and retries (E1 saw 20 to 28% of Quick
  calls fail). A note whose summary fails stays out. Edit a lens marks notes
  that were judged from a summary. Scoring a fragment of a note stays out: a
  matching fragment is never permission to share the whole. E1b measures what
  the summary loses.
- **D7. The suggested rule** (rewriting the rule to cover hand-added notes)
  needs a new model call. Ship it after 1e.

## Measure first

- **E1. Cost of exact lenses.** On the real vault, rescore it in full for three
  realistic rules: with Jev (`jev-1.13.0`) and with the quick-model fallback
  (capped at $0.05 a call). Record dollars, wall time at the current concurrency
  (3), agreement between the two, and how many matches a top-K prefilter misses
  at K = 100, 300, 1000. The design note estimated about $0.84 to score 10,000
  sources with Jev; the fallback could cost far more. This sets K and whether
  lenses require a Jev key.
  **Result (2026-10-09).** A real vault of about 4,500 notes, three rules: two
  real server rules with 20 and 57 thumbs labels, and one written for the test
  with no labels.
  - *Jev is cheap and fast enough to rescore everything on every save:* $0.49 to
    $1.04 per full pass (labels add about 3k tokens of examples per call), p50
    about 100 ms, a full pass in about 3 minutes at concurrency 3.
  - *The prefilter isn't safe:* the top 300 ranked notes held 42% to 92% of the
    matches; catching all of them needed the top 321 to 2,247. Drop ranking from
    exact lenses (keep it for ordering review cards).
  - *The fixed 0.8 cut-off is too strict for Jev:* it missed 7 of 13 and 18 of 24
    thumbs-up notes, with no false positives. A cut-off of 0.6 agreed with 15 of
    20 and 51 of 57 labels. Fit the cut-off per lens from its labels; each label
    already stores the score it got (`prediction`), and nothing reads it.
  - *About 200 notes (4.4%) are too big for Jev* (over about 84k characters) and
    fail closed, so no lens can ever include them: 186 agent-chat transcripts,
    plus a few PDFs and web clips. Decide: leave them out on purpose and say so,
    or score something smaller for them (D8).
  - *The quick-model fallback isn't usable for exact lenses as it stands:* 20 to
    28% of calls ended with no answer or invalid JSON (subscription transport).
    When it did answer, it agreed with Jev on 95 to 100% of sampled notes. It
    would cost about $2 to $4.40 per pass at Haiku 5.5's API price, and take
    about an hour at concurrency 3. Recommendation: exact lenses require a Jev
    key; revisit the fallback only if its failure rate is fixed.

- **E1b. What a summary loses.** On notes just under the size limit, where Jev
  can read the whole thing, compare Jev on the full note with Jev on its Quick
  summary, for the same rules. Then summarize the notes over the limit and
  record the one-time cost and the failure rate.

  **Result (2026-10-09).** Same vault and rules as E1.
  - *Summaries keep most of the signal.* On 129 notes Jev could read whole, a
    summary (median about 4k characters) agreed with the full note on 92 to
    100% of notes at a 0.6 cut-off. It lost 0 to 16% of matches (6 of 41, 0 of
    11, 7 of 43) and added 0 to 3. Scores moved by 0.05 to 0.08 on average.
  - *Summarizing is reliable.* 329 of 329 summaries succeeded; 2 needed a
    retry. Quick's failures in E1 were in the JSON-scored call, not in Haiku
    itself.
  - *It costs a one-time pass:* all 200 notes over the limit took about $16 at
    Haiku 5.5's API price (an upper bound: 157 prompts were over 100K tokens
    and were priced whole at the higher rate). One call cost $0.31, so the
    summary cap has to sit well above the $0.05 Quick cap. Median 28 s a note.
  - *It matters for some lenses.* Scored on their summaries, 36, 3 and 83 of
    the 200 oversized notes would join the three lenses at 0.6, mostly agent
    chats.

- **E2. Read speed with servers.** Every request pages through all of every
  server's evidence and assertions, uncached (`lib/sharedReadUnion.ts:25`). Time
  search, graph and note with 0, 1, 2 and 5 servers of realistic size. This
  decides whether 0c needs a cache first.
- **E3. Links on macOS.** In a dev build, check that `bigbrain://` reaches the
  running app (not a second copy) from Safari, Chrome and Mail, and what each
  browser shows first.
- **E4. Drift.** Rescore an existing rule's members with the next model
  version: how many flip in and out. This settles D3.
- **E5. Claims that outlive a withdrawal.** On a few real servers, count other members' assertions that cite a member's evidence.
  Withdrawal hides evidence but those claims stay (`lib/sharedVault.ts:716-723`).
  If the count is high, decide whether to flag them.

Settled: withdrawal hides a note from what people see; it does not wipe it from
the server (`docs/plans/shared-source-withdrawal.md`).

## Order

1. 0a now (one PR). Then 0b. Run E2 and E3 alongside (E1 and E1b are done).
2. Phase 1 in three PRs: store and migration (1a, 1b); exact edits and
   publishing (1c, 1d); screens (1e).
3. Phase 2 in two PRs: invite page and links (2a, 2b); first run and the AI
   prompt (2c, 2d). These can start once 0a lands.

Later: the suggested rule; server admin screens (inviting, roles); browsing a
single lens in the main app.
