# Pilot mentions and two-height conversation tab

The live Pilot composer and workbench share `PilotMentionComposer.svelte`.

- Bare `@` offers the search bar’s cached first page of recents, interleaved with Pilot sessions. Current-session rows and ingested aliases are excluded.
- Typing filters those titles first. Only zero recent matches triggers vault search: the same endpoint as the search bar, with independent state, a 100ms debounce, superseded-request cancellation, and a 12s deadline. The menu shows up to 50 remote search results, plus matching Pilot sessions.
- Arrow keys navigate, Enter/Tab insert a chip, Escape dismisses the menu before the Pilot panel handles it. Shift-Enter inserts a newline. Plain Enter sends when no menu is open.
- Draft/message strings retain exact references as `[[path|title]]` links; reserved delimiter characters are percent-escaped. The shared parser restores chips on reopen, including failed/queued-send recovery. No wire-schema migration or per-keystroke backend work was added.
- The backend receives decoded mention paths as reference data. Existing `read_note` handles vault paths; its Pilot adapter reads another session’s saved messages with `start`/`chars` windows and optional `q` filtering. It excludes unfinished drafts and does not reactivate the mentioned Pilot. Merely inserting a mention does not mutate the graph’s context; the Pilot may attach read evidence through its existing tools.

The text tab has exactly two heights. Shift-Up expands to the available area below the view bar; Shift-Down returns to the standard height. Both arrows are idempotent. Height animates for 260ms, respects reduced motion, and can reverse mid-transition. Expanding overlays the graph without shrinking/refitting it underneath. Both states use 65% theme background and 12px backdrop blur. The composer remains at the bottom, grows with text, and scrolls at 150px. Its divider belongs to the composer rather than the last message.

The header uses matching neutral icons and shortcut text. X is “Stop,” with Shift-Esc in its tooltip when idle. While generating, a separate Shift-Esc Interrupt action remains; Shift-Esc again stops. Esc always returns to the graph.

Validation: shared serialization and backend tool tests; live-UI browser regressions for recents fallback, current-session exclusion, cancelled searches, chips surviving draft reopen/send, Escape precedence, fixed heights across backend polling, multiline composer bounds, existing queued-send/lifecycle behavior; UI check, root typecheck, lint, production build.

Pilot navigation uses `#/session/<pilot-id>` history entries. Explicit graph/search/mention visits push one entry; membership reconciliation replaces that same entry. Back/forward restores the session's own context and draft without focusing the composer, so h/l remain navigation keys. Reload waits for the initial Pilot list before resolving the route. Ordinary graph-node clicks use the note router, preserving the preceding Pilot entry. `pilotHistory.browser.cjs` covers actual canvas clicks, h/l, multiple sessions, duplicate visits, delayed reload and deselected Escape.
