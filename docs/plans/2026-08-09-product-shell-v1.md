# Product shell v1 — landing + vault-filling-in view (#42, absorbs #74)

> **RETIRED 2026-08-26 with the hosted product (#566).** The product shell went with the control plane; code at tag `hosted-multitenant-final`.

Decision record, 2026-08-09. Scope agreed with Nick in session; build follows
on branch `product-shell`. The viewer (`web/`) stays what it is — the
operator's window. The product shell is a fresh surface that steals the
viewer's parts (design tokens, note renderer) but owns its own story.

## Goal

Close the funnel's last gap: *encounter → install extension → sign in → add
stuff → **watch things link together***. Steps 1–4 exist. This ships step 5,
plus a landing page worth encountering.

## Non-goals (v1 refuses)

- No Config/prompt editing, no search, no live-updating tiles (refresh is
  fine for alpha), no mobile-first pass.
- No visual redesign of the viewer. No self-hosted story.
- No MCP endpoint. **The landing copy promises one and the engine has none
  today** — the copy is the product's thesis (#38 is the feature). Flagged,
  not blocked; see Open items.

## The screens

### 1. Landing — `GET /` (replaces the bare sign-in page)

Copy (Nick's, verbatim minus typo):

> **BigBrain.** An MCP server for your whole life.
>
> Alpha user? **Sign in with Google**
> Curious? **Join the waitlist.**

- Look: the Adventrous design system, verbatim — `web/ui/src/design/tokens.css`
  (paper `#fcfcfa`, ink scale, Hanken Grotesk) — plus the animated cube mark.
  The cube is a self-contained HTML/CSS/JS drop-in (no libraries; honors
  `prefers-reduced-motion`; `.webm` fallback exists). Its face colors ARE the
  app accents (`#4f46e5`/`#d99a2b`/`#d857a8` on `#141414`), so the mark and
  the page share one palette by construction. Assets land in
  `docs/design/mark/` and are copied into the shell at build.
- Layout (Nick, 2026-08-09): the **"BigBrain" wordmark sits to the LEFT of
  the cube animation**; keep the whole page quite minimal — lockup, tagline,
  the two calls to action, nothing else.
- Server-rendered static HTML from the control plane (`pages.ts` style):
  instant load, no framework, no build step for the one page that must never
  be slow.
- "Sign in with Google" → the existing Better Auth social flow; callback now
  lands on `/app` (not `/welcome`).
- Waitlist: email input → `POST /waitlist` → thanks state.
  - Control-plane SQLite: `waitlist(email PK, added_at)` in the registry,
    `INSERT OR IGNORE`, lowercase+trim. Honeypot field, no CAPTCHA.
  - No mailer, no confirmation. It is a list Nick reads
    (`bigbrain`-side: `sqlite3 control.db 'select * from waitlist'`).
- Allowlist rejection stops being a dead end: "Alpha is invite-only — join
  the waitlist," same form.

### 2. Home — `GET /app` (signed in): the recent-adds tiles

- Session required; no session → redirect to `/`.
- Provisioning is idempotent on arrival (same `doProvision` seam `/ext/finish`
  uses), so first web sign-in and first extension sign-in converge.
- **Empty state = onboarding**: the cube, one line of what happens next, and
  the extension install button (CWS link once 0.6.1 clears review; unlisted
  link/zip until then).
- **Tiles** (initial proposal — iterate after it renders real data):
  - Grid of cards, newest first, from the tenant's journal. Each card:
    - note title;
    - tree chip, colored by tree (references → accent-1, entities → accent-5,
      domains → accent-2, library → accent-4);
    - time-ago;
    - two-line excerpt;
    - the editor's story, one line: "filed to references/, linked
      [[bigbrain]], [[pi]]" — each link a chip that opens that note.
  - **Build deviation (recorded):** the tiles derive from the curated trees
    themselves — newest `.md` by mtime, title/excerpt/links parsed from the
    note — not from the journal. Same story ("filed to X, linked Y"), no
    coupling to the run-record shape; the journal-narrated version can come
    later if the tiles want more voice.

### 3. Note view — `GET /app/note/<path>`

- Click a tile (or a link chip), read the note. Wikilinks resolve within the
  read jail. Back returns to the grid.
- Steals the viewer's markdown/wikilink renderer (`web/ui`), not its chrome.

### 4. Connect — `GET /app/connect`

- Where the drop token moves (off the first screen, per #74).
- "Mint an API token" button → existing `mintToken` seam → shown once.
  The provision-time token stops being displayed anywhere.
- Extension install link lives here too, plus a placeholder for the MCP
  endpoint (#38) when it exists.

## Architecture

- **Shell app** (*build deviation, recorded*): static no-build ES modules
  under `shell/` — index.html + app.js + app.css, marked vendored, the
  viewer's `tokens.css` served from its one source. Reason: the box never
  runs a bundler today, and adding one for three views is the wrong trade;
  Svelte returns when the surface earns it. Served by control at `/app/*`.
  Landing stays server-rendered in control (no SPA on the front door).
- **Session → tenant**: control resolves the Better Auth session →
  `registry.tenantByUser` → proxies reads to the tenant instance on
  loopback. Same seam as `/ext/finish`; no new auth surface.
- **Data plane**: one new tenant-API route, `GET /v1/recent?n=20` —
  tile-ready JSON (journal entry + note title/path/excerpt/links), built
  from `journal/` + the note files, all inside the existing read jail.
  Everything else uses the existing `/v1/file` (note view).
- **Internal credential**: the shell's reads go through the tenant API, which
  is Bearer-token-gated. Provisioner mints a per-tenant "web shell" token
  (`vault:read` only), recorded in `token_ids` like any token, with its
  plaintext stored in the registry (new column) — an internal, loopback-only
  credential no human ever sees. Lazy-minted on first `/app` visit for
  tenants that predate this. Going through the API (not the filesystem)
  keeps the read jail as the single enforcement point.

## Deploy

- Box build gains `bun run shell:build` (deploy README + bootstrap updated).
- Caddy/router untouched: control already fronts everything on :4700.
- The old `/welcome` page dies in the same PR that ships `/app` — the
  replacement and the removal are one cutover (#74's "keep until replaced").
- Google Fonts loads client-side (`@import` in tokens.css) — fine for a
  website; self-host later if it bothers us.

## Open items

- **MCP claim vs. reality**: landing says "an MCP server for your whole
  life"; there is no MCP server. Nick owns the copy; #38 (connect your
  agent) is the feature that makes it true. v1 ships the copy as thesis.
- **CWS link**: 0.6.1 in review (unlisted). Button points at the unlisted
  listing or a .zip until it clears, then flips public after this ships.
- **#36 instrumentation** rides this surface later; not in v1.
- Tile design is explicitly a starting point — Nick iterates once real data
  renders.
