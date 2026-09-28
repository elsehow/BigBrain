# That Tracks integration

Enable That Tracks in Integrations and paste a read-only personal key from the
phone's Settings → Account & sync → API keys. All history and future trackers
permitted by that key are imported, including archived trackers and full notes.
The first run backfills; subsequent runs poll every minute. The phone must sync
its entries to That Tracks, and BigBrain catches up whenever it is running.

The key uses the existing write-only credential UI and gitignored `.env`
(`THAT_TRACKS_API_KEY`). The shipped API endpoint is fixed; no additional account,
webhook, URL field or tracker selection is needed. Scoped keys are honored by the
API. Replacing a key restarts discovery for its grant without duplicating sources.

The connector consumes `/changes`, preserving string cursors and all source
revisions. Each category, tracker and event becomes a readable source through
`receive()`, carrying the exact original change in its envelope. Source identity
includes account, record kind and UUID. Revisions use `seq` and explicit
`supersedes`; a deletion is a withdrawal revision. Source history is never erased.
All permitted events land before curation: the gardener can decline to extract an
assertion, but cannot discard the raw event through email-style admission.

Curation distinguishes the subject of an entry from its source app. Dreams,
reflections, and activity entries are filed under their substantive subjects;
That Tracks is linked when a claim actually concerns the app. Routine tracker
configuration and unchanged sync state normally receive a decline, retaining
the readable source without adding entity assertions. A revision still needs
settlement so earlier evidence can retire; old low-value claims need not be
reasserted. Configuration changes alone do not establish behavioral changes.

`.spool/that-tracks/checkpoint.json` holds the cursor and metadata needed to render
names/units. It advances after a whole page lands. A crash can replay a page;
source heads are recovered from the shared projection, rebuilt from the log if
necessary. A missing/corrupt checkpoint restarts discovery from zero. Each run
is bounded to 50 pages, resuming at the next scheduled check.

Granola and That Tracks share disposable poll receipts under
`.state/integrations/`. Settings refreshes health every 15 seconds while open.
A receipt distinguishes successful checks from arrivals and exposes safe errors;
an interrupted poll becomes waiting rather than spinning indefinitely.

Verification: `bun test test/thatTracks.test.ts test/granolaPoll.test.ts
 test/integrationStatus.test.ts test/configWrite.test.ts` (one command).
The release was also exercised against the hosted API with a temporary synthetic
account, through credential validation and the actual runner: full historical
text, quiet deduplication, old-event edits, deletion and key revocation. The test
account and scratch vault were removed afterward; no personal API key was used.
