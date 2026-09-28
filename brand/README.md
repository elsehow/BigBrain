# brand/

Shipped brand assets — the files that leave this repo and land in front of
people who are not running the app. Right now that means HTML mail.

This is **not** `docs/design/`. That holds design *sources* (the cube's
`bigbrain-cube.html`). This holds *distributables*: bytes meant
to be served at a fixed public URL.

## The mark, moving

The mark's motion is not a file here — it is geometry
(`web/ui/src/lib/logomark.ts`, drawn by `Logomark.svelte`), and video of
it is cut on demand, in any of the app's themes, with or without the
wordmark:

```sh
bun run web:dev                                          # the workbench, on :5173
bun run logomark:render -- --list                        # the themes
bun run logomark:render -- --theme nurebairo --wordmark --out ~/Desktop/mark
```

`--theme` takes a theme by the name Settings › Theme shows — Light,
nurebairo, OG web blue, Phosphorus, Something's Gotta Give, yamabukiiro,
moegiiro, adzukiiro, asagiiro — or by its id; the default is Light, and
an unknown name prints the list. The render screenshots the workbench's
render stage frame by frame through this machine's Chrome (playwright-core
drives it) and leaves three things in `--out`: a transparent ProRes 4444
`.mov` (drop it over anything — CapCut takes it), an H.264 `.mp4` on the
theme's own background (the safe one), and the PNG frames. `--loop
flip|walk|column`, `--size`, `--fps`, `--seconds` (a whole number of
passes loops seamlessly) and `--turn`/`--hold` are the knobs; `--help`
has them all. Needs ffmpeg on PATH.

## brand/email/

The lockup and mark, plus the mail templates that hotlink them.

| File | Size | Use |
|---|---|---|
| `bigbrain-lockup-light.png` | 480×120 | Cube + wordmark, dark ink. For light backgrounds — the `#fcfcfa` card the templates use. |
| `bigbrain-lockup-ink.png` | 480×120 | Cube + wordmark, white. For dark backgrounds (`#141414`). |
| `bigbrain-mark-light.png` | 96×96 | Cube alone, dark ink. Avatars, tight headers. |
| `bigbrain-mark-ink.png` | 96×96 | Cube alone, white. Same, on dark. |

The lockups are exported at 2× and declared at `width="240" height="60"` in
the templates, so they stay sharp on retina. Keep both numbers on every
`<img>`: Outlook lays out from the attributes, not the CSS, and an image with
no declared height reflows the whole card while it loads.

Only `bigbrain-lockup-light.png` is used today. The other three are staged —
`ink` exists for a future `prefers-color-scheme: dark` swap, which is
deliberately **not** wired up yet because dark-mode support across mail
clients is inconsistent enough that a wrong guess looks worse than a light
card in a dark inbox.

### How they were served — and the gap now

The hosted control plane served this directory at
`https://bigbrain.cool/email/*` (public, `GET` only, `.png` only,
prefix-jailed, `Cache-Control: max-age=31536000, immutable`) until it was
retired on 2026-08-26 (#566; the code is at tag `hosted-multitenant-final`).
Since 2026-08-28 `bigbrain.cool` points at the static site (`site/`),
which serves this directory at the same URLs, immutable — already-sent
mail resolves again. Whatever serves them must be public and unauthenticated —
a mail client fetches from a cold cache with no cookie, and Gmail through
`googleusercontent` — and must serve only the `.png`s; the `.html` files are
source for whoever is sending, never something the origin hands out.

### The rule that matters

**An asset URL that has shipped is permanent. Never rename, never delete, and
never change the bytes behind an existing filename.**

A sent email is a frozen copy on someone else's machine. It will re-fetch
`/email/bigbrain-lockup-light.png` months from now, and it is served
`immutable` for a year, so a replacement would reach some readers and not
others. To revise the artwork, add a new filename and point new templates at
it. Old mail keeps resolving to the old bytes, which is correct — that is what
those readers were sent.

The asset test that pinned every template `src`/`href` to a served route
went with `control/`; when a host returns, bring the check back with it.

## The templates

Both are single-file, table-based, inline-styled — the boring construction
that survives Outlook. Both carry an MSO conditional forcing Arial, a
preheader span, and one breakpoint at 620px.

- **`alpha-invite.html`** — the hand-sent invite. Leads with *sign in with
  Google using the address this mail reached you at*, because the allowlist is
  keyed on exactly that and a different Google account gets refused at the
  door.
- **`welcome.html`** — post-signup onboarding: connect a source, install the
  extension, check the queue tomorrow.

Editing copy is safe. If you touch a URL, check it by hand — the asset test
went with `control/`.

## Sending invites

The hosted alpha this runbook served (allowlist via `bb-invite`, sign-in at
bigbrain.cool) is retired (#566); there is no door to invite people through,
and `alpha-invite.html` still says "sign in with Google" — recut it before
reuse. What still applies when mail goes out by hand from a personal
address: paste the rendered page into Gmail's compose window (it keeps the
table layout), send one to yourself first and check it on a phone, and send
**individually or Bcc** — a visible recipient list leaks the roster to
everyone on it.
