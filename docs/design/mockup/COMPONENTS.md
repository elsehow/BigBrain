# Mockup component specs (from the claude.ai/design project)

Extracted essentials of the three composable components the mockup's
screens build from. Tokens live in `web/ui/src/design/tokens.css`; the
original standalone HTML was retired during publication cleanup because its
example content mixed personal context with invented material. These geometry
notes remain as historical design reference. Use the synthetic
`/sidebar-workbench.html` for the current production shell.

## ItemRow (feed rows)

Grid row, `padding: 13px 12px; margin: 0 -12px; border-radius: var(--r-sm)`,
hover `background: var(--well)`.

- Columns (with filer): `92px minmax(220px,1fr) 150px 232px 104px`
  = TIME · ITEM · FILED BY · DOMAIN/TYPE · actions.
  No-filer variant: `18px 92px minmax(220px,1fr) 232px 104px` (lead gutter).
- Timestamp: `font: var(--type-meta); font-variant-numeric: tabular-nums`,
  Gmail rule — same calendar day → `1:04 PM`, older → `Jul 23`.
  Unread rows render the stamp at weight 600.
- Title: `font: var(--type-chip); color: var(--text-strong);
  letter-spacing: -0.012em`, ellipsis overflow.
- Chips (filed-by and domain/type):
  `font: var(--type-meta); color: var(--text); padding: 4px 9px;
  border-radius: var(--r-sm);
  background: color-mix(in oklab, var(--accent-N) 24%, var(--bg))`
  (neutral fallback `rgba(26,26,26,0.06)`). Accent index is stable per
  filer/domain.
- Filing-in-progress ("unfiled"): 15px spinner in place of the chip —
  circle stroke `var(--ink-050)` + quarter-arc `var(--ink-300)`,
  `0.9s linear infinite` rotation.
- Row actions (right-aligned, revealed on hover/selection):
  `⇧↵` in `var(--type-mono)` + the DISCUSS PromptChip.
- Aged rows dim via `opacity` (mockup uses 1 → 0.55 → 0.28 bands).

## PromptChip (DISCUSS button)

`font: var(--type-eyebrow); letter-spacing: 0.12em; color: var(--text-note);
background: rgba(26,26,26,0.06); padding: 6px 9px;
border-radius: var(--r-sm)`. Hover: bg `rgba(26,26,26,0.13)` + strong
text; active `0.18`. On click: copies the discuss prompt, label flips to
`COPIED` for 1.6s. (Keep the viewer's existing prompt payload.)

## KeyHint (screen-footer shortcuts)

`font: var(--type-mono); letter-spacing: 0.08em; color: var(--text-muted)`,
segments split on `·` with `gap: var(--sp-7)`,
e.g. `↑↓ / J K MOVE · ⇧J K SWITCH · ↵ OPEN · ⇧↵ DISCUSS`.

## Historical screen chrome

- App frame: `background: var(--bg); border-radius 14px` on
  `var(--paper-desk)` canvas (browser build: just `var(--bg)` full-bleed).
- Sidebar: 236px, `border-right: 1px solid var(--rule)`; "BigBrain" in
  `var(--type-heading)`; nav rows `var(--type-body)` (active
  `--text-strong`, inactive `--text-faint`); OPEN section with a 2px
  `var(--accent-5)` bar + `ESC TO CLOSE` in `--type-mono`; footer =
  40px round gear button on `var(--surface)` + user line in
  `var(--type-meta)`.
- Omnibox: 52px field, `background: var(--well);
  border-radius: var(--r-chip)`, magnifier svg, placeholder
  "capture, or search everything…", `⌘K` hint in `--type-mono`; toast
  text right of the field in `--type-mono` (e.g. `CAPTURED — FILING`).
- Section labels ("eyebrows"): `font: var(--type-eyebrow);
  letter-spacing: var(--ls-eyebrow); color: var(--text-faint)` —
  RECENT / WORK QUEUE / CAPTURE / TOUCHED BY / NEIGHBOURHOOD / DOMAINS.
- Work-queue rows: cols `18px 92px minmax(220px,1fr) 232px 104px` =
  status · ADDED · JOB · CAPABILITY · (spacer); status = spinner
  (running) / 6px dot `var(--ink-300)` (waiting) / check `var(--ink-100)`
  (done); capability chip accents: low→accent-3, med→accent-2,
  high→accent-5; done rows fade 0.62 → 0.22 with age.
- Graphs: dashed edges `stroke: var(--dash); stroke-dasharray: 3 4`;
  domain nodes filled with their accent, satellites at 0.55 opacity;
  labels `var(--font-app)` 11–13px in `--text-muted`. Note view has a
  radial NEIGHBOURHOOD panel (320px, center node + ~7 ring nodes with
  hover-reveal outer labels).
- Note view: title `var(--type-hero)`; DISCUSS chip + type chip
  (`--accent-5` mix) under it; prose `var(--type-prose)` max-width
  ~620px; TOUCHED BY = `132px 1fr` grid in `--type-meta`.
- End-of-list: three 3px dots `var(--ink-100)` (loading) or
  "beginning of the log" in `--type-meta` `--text-faint`.
