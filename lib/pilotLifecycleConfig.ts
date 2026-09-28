/** Text Pilot lifecycle timing. Change the product defaults HERE.
 * All idle deadlines count from semantic user/agent activity, not disk saves.
 * Working turns, open composers, and unsent drafts are exempt. */
export const PILOT_LIFECYCLE = {
  dormantAfterMs: 10 * 60_000,       // 10 minutes idle → neutral node
  ingestAfterMs: 24 * 60 * 60_000,   // 24 hours idle → ordinary source note
  sweepEveryMs: 30_000,             // Also sweep immediately on server start
  composerHeartbeatMs: 15_000,
  abandonedDraftAfterMs: 90_000,   // Empty sessions without a composer are removed
  composerLeaseMs: 90_000,          // A closed/crashed tab cannot pin forever
} as const;
