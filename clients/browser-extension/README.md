# Send to BigBrain — browser extension

Captures the current page as **clean markdown** and drops it into your
vault's inbox over the authenticated HTTP intake (`deploy/HTTP.md`). One
click, no text-selecting. Plain MV3, no build step, one codebase for
**Chrome** and **Firefox** (incl. Zen and other Firefox-based browsers).
The `browser ?? chrome` alias in the JS and the dual
`service_worker`/`scripts` background in the manifest are what let a single
directory load in both.

## What it captures

The page as rendered (SPAs and lazy content included), converted to
markdown by [Turndown](https://github.com/mixmark-io/turndown) + its GFM
plugin (vendored under `vendor/`, MIT — the notices ride beside them as
`vendor/LICENSE-*.txt`, because MIT asks for the notice in every copy and
neither rolled-up bundle carries its own). It honors the author's own
`<main>`/`<article>` landmark and strips non-content by *semantics*
(`nav`/`footer`/`aside`/`script`/hidden), rather than guessing which block
is "the article" — that judgment is left to the gardener downstream, which
can handle boilerplate but can't recover content discarded at capture
time. A frontmatter block carries title, canonical URL, site, author,
published date, and description pulled from the page's `<meta>`/`og:` tags.
On a client-rendered page with no semantic markup it falls back to the
rendered text, so a capture is never empty.

## Install

**Chrome:** `chrome://extensions` → **Developer mode** → **Load unpacked**
→ pick this directory.

**Firefox / Zen:** `about:debugging#/runtime/this-firefox` → **Load
Temporary Add-on** → pick this directory's `manifest.json`. (Temporary
add-ons unload on restart — the parallel to Chrome's "load unpacked." For
a permanent install, self-distribute a signed `.xpi` via `web-ext sign`;
see the note below.)

The existing store items are Chrome `ddnflabpbjfcakilfjmbinhblgbmckpb` and
Firefox `extension@bigbrain.cool` (slug `send-to-bigbrain`). See
`docs/releases/extension-0.9.5.md` for the store-update checklist.
The app links to https://bigbrain.exe.xyz/plugins; deploy its store-link
update only after both stores serve the current desktop-compatible release.

## Pair (#486)

The engine cannot see a browser extension (the desktop app is a webview,
not a browser), so a browser exists, from the vault's side, exactly when
its credential does. Pairing is how it gets one, and it takes one paste:

1. In BigBrain: **settings → integrations → PAIR A BROWSER**. A code
   appears — eight characters, ten minutes, works once.
2. In the extension's **options**: leave the address at
   `http://127.0.0.1:4748` (the intake API on this machine), enter the
   code, **CONNECT**.

Under the hood: `POST {endpoint}/v1/pair {code, client}` — unauthenticated
by nature, since it is how a client gets a token; a wrong code answers 403
after a deliberate delay and says nothing about why. The engine mints the
browser a `person-device` token in the owner's name (clips land as *yours*),
scoped `inbox:write`, named `<browser> on <machine>` — `client` is what the
browser calls itself (`navigator.userAgentData`, else the UA string), the
engine adds the machine, so the label in the app was minted, never typed.
The result lands in `storage.local {endpoint, token}` (the shape
background.js reads) plus `{account}` for the options page's status line.

The same card lists every paired browser with its last capture (the
token's `last_used`) and a **REVOKE** — that is the whole of "disconnect";
the extension finds out on its next capture (`!` badge) and its options
page offers to pair again. Pairing the same browser twice supersedes the
first credential on the engine's side.

`host_permissions` names loopback only (`http://127.0.0.1/*`,
`http://localhost/*`). Any other address — a vault over an ssh tunnel on
another port still counts as loopback; a remote host does not — is asked
for at CONNECT as a runtime grant (`optional_host_permissions`), and the
engine answers CORS for any origin regardless, so a refused grant is not
fatal.

**The hosted service is gone.** `bigbrain.cool`'s multi-tenant product
was retired on 2026-08-26 (#566). An install that still holds a credential
pointing there has it cleared on the next update (`dropRetiredCredential`
in background.js), which puts the options page back to NOT CONNECTED — the
true statement, and the one that offers the fix.

## Use

Click the toolbar button: the page is sent **immediately** (no confirm
step) and a small popup opens offering an optional note. Type and hit
Enter to send it, or just close the popup — the page is already on its
way. Right-click → **Send page to BigBrain** captures without the popup. A
badge flashes ✓ on success, `!` on failure, `?` if you haven't set the
endpoint/token yet. Reopen the popup on a page this tab already clipped
and it does not clip again: it opens on **IN THE VAULT** with the note
well focused, and a note you had half-typed is back (#300). Both are
per tab and keyed to the exact URL — navigate, reload, or close the tab
and they reset, since the page may no longer be what landed. (Browser-internal
pages — `chrome://`, `about:`, the extension store — can't
be captured; that's a browser restriction, not a bug.)

A tab showing a **PDF** still captures, by a different road per engine:
Firefox's pdf.js viewer refuses injection outright, while Chrome's viewer
*accepts* it — into a textless wrapper document around the `<embed>`, which
`extract.js` recognizes by `document.contentType` and reports back rather
than faithfully capturing an empty page. Both roads end at the same place:
the background re-fetches the PDF's own URL and ships the document as an
attachment — the same `{ content, attachments }` wire shape the web drop
zone uses, landing the original in the CAS with a small `kind: pdf-import`
reference naming it. The fetch tries the user's cookies first (a
login-gated PDF lands the bytes the tab is showing, where the browser's
`activeTab` grant waives CORS — Chrome), then retries anonymously (Firefox,
where the grant does not reach a background fetch and public hosts like
arXiv allow plain CORS). A host that offers no CORS at all still fails in
Firefox — there the popup offers **ALLOW THIS SITE**, which asks for a
permanent host grant (`optional_host_permissions`; the browser requires the
click, since a permission prompt only rises from a user gesture) and
retries. One click per host, ever. No text extraction happens at capture
time (#63): pdf.js is ~400kB plus a worker an MV3 background can't spawn.
The HOST extracts the text layer on landing (`lib/pdfText.ts`, pure JS —
nothing to install), and the attached original is the record either way.

Three surfaces in the popup carry state, and they carry DIFFERENT state —
which is the point, because "is it still going?" and "did it work?" are
different questions:

| | says | vouches for |
|---|---|---|
| the **mark** (the turning cube) | work is in flight | nothing — it is the progress, not the result |
| the **eyebrow** | `SENDING` → `IN THE VAULT`, or `SEND FAILED` | the page is **committed** to the insertion log |
| the **hint row** | `NOTE QUEUED` / `NOTE FAILED`, else the keys | the directive is durably in the log too |

The eyebrow can say IN THE VAULT because `POST /v1/drop` only answers
*after* `commitLanding` — a 200 means the reference file and its `file`
message are both in git, not that bytes were received. The note says
QUEUED rather than FILED for the same reason in reverse: `/v1/enqueue`
promises the directive will not be lost, not that the gardener has acted
on it. Neither line claims the gardener's pass, which happens on its next
tick. (The route name is the retired queue's spelling, kept so this
extension need not change.)

Keys: **Enter** sends the note. **Shift+Enter** is **DISCUSS** — it copies a
ready-made prompt naming what you just filed, to paste into whichever
assistant you like, and does nothing until there is something filed to name.

The prompt names the drop receipt's `ref_path` — the committed reference —
and never its `path`, which names the host's gitignored working copy: no
read tree served that one and the pass deleted it, so from #64 until #334
every line the chip copied answered 403 on the other end. Against a host
too old to send `ref_path`, the chip copies its search line instead: prose
that finds the clip beats a path the vault refuses.

A note takes **no newlines** (2026-08-10, Nick's call): it is a one-line
directive to the gardener, Enter is how you send it, and that frees
Shift+Enter to mean what the chip's own `⇧↵` label says it means in every
state. A shortcut that is a newline half the time is a shortcut that lies
half the time.

The page and your note are two different KINDS of thing, not two copies
of one:

| | where it goes | what it is |
|---|---|---|
| the page | an insertion | **record** — its author's words, landed as a `web-clip` and stamped `from_kind: agent`, because the article isn't yours |
| your note | an insertion, `kind: directive` | **voice** — your words ABOUT the record, naming the page in its `about` |

So the note never becomes a second row in your feed titled after the page
you just saved. It is voice: the gardener reads it as a standing order
(verbatim, since your token is a person-device credential) when it files
the page, and settles it by citing it in what it writes. Both halves are
immutable log events — nothing is consumed, moved, or deleted.

The ref is the source id the **drop response** reports, which is why the
note waits for the capture to land — there is nothing to point at before
then. Ingestion never waits on *you*, though: type slowly, or close the
popup and send nothing at all; the page is already on its way.

Nothing client-generated rides in the frontmatter — the payload we send IS
the log's dedup identity, so re-clipping an unchanged page adds no second
copy of it, and a note sent after a re-clip attaches to the original.

From there it is an arrival like any other: it lands in
`log/insertions/` (committed, immutable) and becomes due work the moment
it exists — no assertion cites it yet — which the gardener drains on its
next tick. The server stamps `source: api` /
`submitted_by: <token id>` / `submitted_via: <token name>` from the
credential, so every item says which browser sent it no matter whose voice
it carries; revoke the token on the host any time (`bigbrain auth revoke
<id>`).

## Look

The popup and the options page are the same card, built from the design
mockup (claude.ai/design project `c25db7b6`, "Browser extension.dc.html").
The extension loads these files directly:

- **`design.css`** — extension layout, importing generated app `tokens.css`
  and self-hosted `fonts.css`. Run `bun run design:sync` after changing app
  tokens. The font is **self-hosted** (`fonts/*.woff2`, Hanken Grotesk,
  OFL) rather than fetched from Google Fonts: a popup lives for seconds, so
  a network round-trip for the typeface would flash on every open, and the
  manifest's host permissions stay narrow.
- **`cube.js`** — the logo mark. It turns while work is in flight and
  **stops on a landing**: a move is a 180° half turn, which always leaves
  the cube solved, so settling never freezes it mid-rotation. That property
  is held by `test/extensionCube.test.ts` — the bug it guards against is one
  frame long and looks fine in a screenshot.
- **`preview.html`** — a dev harness. It stubs the extension API so both
  screens can be driven in a plain tab, and it loads the *shipped* markup
  rather than a copy that can drift:

  ```
  python3 -m http.server 8931          # from this directory
  open http://127.0.0.1:8931/preview.html            # popup, lands after 2.6s
  #  ?out  signed out   ?fail  the send fails
  #  ?page=options      the options page
  #  &rule draws the x=35 text axis
  ```

  `web-ext-config.cjs` keeps it out of store packages. It must **not** be
  named `_preview.html`: Chrome reserves the `_` prefix for the system and
  refuses to load an unpacked extension containing one, failing with "Could
  not load manifest" — an error naming a file the manifest never mentions.

**Everything lines up on one axis.** Card padding is 22px and the note
well's own padding is 13px, so note text starts at x=35. The footer row is
inset 4px and the chip's padding is 9px — 4+9 = 13 again, so chip text
starts at x=35 too, and the mark's slot is inset the same 13px. The right
edge matches the same way. Change any one of those numbers and the column
breaks; `?rule` is there to show you when it has.

## Permanent install (Firefox vs Zen — they differ)

Two different dialogs, and picking the wrong one is the usual reason this
"won't install":

| | accepts | survives restart |
|---|---|---|
| `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** | `manifest.json` or an archive | no |
| `about:addons` → gear → **Install Add-on From File…** | `.xpi`/`.zip`/`.jar` only | yes |

In the second dialog every loose file in this directory greys out,
`manifest.json` included — that's the archive filter, not a manifest
problem. Build one:

```
npx web-ext build --source-dir . --overwrite-dest
cp web-ext-artifacts/send_to_bigbrain-<version>.zip \
   web-ext-artifacts/send_to_bigbrain-<version>.xpi
```

**Zen takes it unsigned — one pref may stand in the way.** Zen ships as
an unbranded-style build (`AppConstants.MOZ_REQUIRE_SIGNING` is
`false`), so it *honors* `xpinstall.signatures.required` — but newer Zen
builds default that pref to `true`, and the install then fails with a
"corrupt" / "could not be verified" message. The fix: `about:config` →
`xpinstall.signatures.required` → `false`, then install again. (Zen
1.21.10b still defaulted it to `false` in `greprefs.js`; an alpha
tester's newer build did not — 2026-08-13. Release Firefox ignores the pref entirely and
enforces signing regardless.)

**Release Firefox does not.** It enforces signing regardless of that
pref, so a permanent install there needs
`npx web-ext sign --channel unlisted` (free AMO API credentials) to
produce a signed `.xpi`. The `gecko.id` in the manifest is what ties
signing to this extension. Temporary loading works unsigned in both.

`web-ext-artifacts/` is gitignored — build output, not source.

## Store packaging

The same `web-ext build` zip is what both stores take. Store facts, so the
next submission doesn't rediscover them:

- **Privacy policy URL** (both stores require one): `https://bigbrain.cool/privacy`
  (the website PR must be published before submission).
- **Firefox data collection**: declared in the manifest
  (`data_collection_permissions: required: [websiteContent]`) — mandatory
  for new AMO submissions; needs Firefox 140+ (142+ on Android), hence
  `strict_min_version`.
- **Chrome id pinning**: after the first draft upload, the DevConsole's
  *Package* tab shows the item's public key. Paste it into the manifest as
  `"key"` so unpacked/dev installs get the SAME id as the store install.
  Chrome Web Store ignores the field on upload; only local installs read it.
- **Host permissions are deliberately narrow** (loopback only) — broad
  `https://*/*` is the top cause of slow Chrome reviews. The
  `optional_host_permissions: ["*://*/*"]` wildcard is different: it is
  runtime-requested (the Firefox PDF grant chip, a non-loopback endpoint
  at CONNECT), carries no install-time warning, and store review treats
  it far more leniently than an install-time grant.
- `npx web-ext lint --source-dir .` before every submission; the
  service-worker warning is the intended dual-background pattern.

### Shared app styles

`web/ui/src/design/tokens.css` is the source of truth. After changing it, run
`bun run design:sync` from the engine root; commit the generated extension
`tokens.css` too. `test/designTokens.test.ts` checks parity. `design.css` imports
those tokens and the offline `fonts.css`, and owns only extension layout and
controls. All nine app palettes are available via `data-theme`; this does not
sync a user's selected desktop theme into browser storage.
