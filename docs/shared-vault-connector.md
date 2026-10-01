# The shared vault in Claude — a read-only connector

*Opt-in, off by default. `lib/sharedOAuth.ts` (sign-in, sessions, tokens),
`lib/sharedPages.ts` (the pages), `lib/sharedMcp.ts` (the MCP server), wired
into the door by `lib/sharedVaultApi.ts`. Read [shared-vault.md](shared-vault.md) first: this
is one more way in to the same door, with the same members and credentials.*

A member can add a shared vault to Claude — Desktop, claude.ai, mobile, or
Claude Code — as a **custom connector**: Settings → Connectors → *Add custom
connector* → paste `https://vault.example.com/mcp`. Claude signs them in,
asks them to approve, and from then on can search and read the vault in any
conversation. The connector is **read-only**. Contributing — evidence,
claims, corrections, withdrawals — stays in the BigBrain app.

Claude's custom connectors cannot carry a pasted bearer secret; they speak
OAuth. So when the connector is on, the door also runs a small OAuth 2.1
authorization server whose only job is to let a member trade a sign-in for
an ordinary `sv_` credential.

With Google sign-in configured (the intended setup) a vault also has one
constant **join link**, `https://vault.example.com/join`. The owner invites
someone by email in the app and sends them that link; they sign in with
Google and land on a personal page with the connector URL for Claude and a
button that makes single-use links for the BigBrain app.

## Operator setup

1. **Serve the door behind TLS, as today.** Nothing about the proxy changes
   (`deploy/Caddyfile.example`, a site block proxying to `127.0.0.1:4749`):
   the connector's paths — `/.well-known/…`, `/register`, `/authorize…`,
   `/oauth/google…`, `/join…`, `/me…`, `/assets/…`, `/token`, `/mcp` — go to
   the same upstream as `/v1/*`.
   Claude reaches the server from Anthropic's published egress range
   (`160.79.104.0/21` at the time of writing); a firewall in front must let
   it through, and the proxy must answer the discovery, registration and
   token paths well within Claude's 10-second limit.

2. **Turn the connector on with the public URL** — the origin members will
   paste, without a path:

   ```
   bigbrain shared serve --vault /srv/team-vault --public-url https://vault.example.com
   # or BIGBRAIN_SHARED_PUBLIC_URL=https://vault.example.com
   ```

   It must be `https:` (plain `http:` is accepted only on loopback, for
   development). Every URL the connector issues — the resource, the issuer,
   every endpoint, Google's redirect URI — is built from it, never from a
   request's `Host` header. The listening line reports
   `"connector": "https://vault.example.com/mcp"`. Without a public URL the
   door behaves exactly as before: every path answers 401 without a credential.

3. **Add "Sign in with Google"** (recommended). In the Google Cloud console,
   create an OAuth client of type *Web application* with one authorized
   redirect URI:

   ```
   https://vault.example.com/oauth/google/callback
   ```

   The consent screen needs only the non-sensitive `openid`, `email` and
   `profile` scopes (`profile` supplies the name a member invited by email
   is shown under). While the Google app is in *Testing*, only the test users you list
   can sign in; publish it for anyone else. Then set both halves in the
   server's environment (both or neither — half a client refuses to start):

   ```
   BIGBRAIN_SHARED_GOOGLE_CLIENT_ID=…apps.googleusercontent.com
   BIGBRAIN_SHARED_GOOGLE_CLIENT_SECRET=…
   ```

   With Google, it is the only way to sign in to the connector, and `/join`
   and `/me` exist. Without it, members sign in to the connector by pasting
   an invite link, there is no join link, and the app's invite dialog stays
   as it was (name-based single-use links).

4. **Registered clients** are kept in `<members-file>.oauth-clients.json`
   (mode 0600, beside the member store, outside the vault).

## Inviting someone (with Google)

In the app: the shared vault → **Members** → *Invite someone* → **Email** and
**Access**. That adds them at once as a **pending** member (`POST
/v1/members`) and shows the vault's join link to send however you like. The
link is the same for everyone: no secret, no expiry, nothing single-use —
what makes it work for them is their email on the member list. Pending
members are listed under *Pending invitations* (with *Copy link* and *Cancel
invite*, which removes the pending member) and are visible to the owner
only: other members' rosters and the connector's `overview` leave them out.

The invitee opens the join link in a browser:

1. `/join` — the same page for every visitor; it says nothing about the
   vault. *Sign in with Google*.
2. If their verified Google email belongs to a member, they land on `/me`
   (a 30-minute session): the vault's name, who they are signed in as,
   - **Use with Claude** — the connector URL `https://vault.example.com/mcp`
     with Copy and the three steps in Claude;
   - **Connect the BigBrain app** — *Create an app link* makes a fresh
     single-use link (`https://vault.example.com/invite#…`, one hour) to
     paste into the app's *Connect vault*. One per device, as many as they
     like. It redeems through the existing `POST /v1/invites/redeem` as a
     member-following credential, so later access changes apply to it.
   - *Sign out*.
   Otherwise, one generic page says the account doesn't have access.

On that first sign-in the pending mark clears, and a member invited without
a name is named from Google's `name` claim (else the address's local part);
a name the owner set is kept. Pasting the join link into the BigBrain app is
refused before any network request, with directions to open it in a browser.

## Members' emails

Google sign-in matches a **verified email** the owner put on a member — once.
On that first sign-in the member's Google account (`iss`, `sub`) is bound to
them, and from then on they are matched by that binding, so a later change
of address on Google's side does not lock them out.

```
# a new (pending) member by email — a record now, no credential; "name" is optional
curl -H "Authorization: Bearer $OWNER" -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","permission":"read"}' https://vault.example.com/v1/members

# set, change or clear an existing member's email (any change unbinds their Google account)
curl … -d '{"email":"ada@example.org"}' https://vault.example.com/v1/members/mem_1a2b3c4d/email
curl … -d '{"email":null}'              https://vault.example.com/v1/members/mem_1a2b3c4d/email

# the same from the host
bigbrain shared member add ada --display "Ada" --email ada@example.com --vault /srv/team-vault
bigbrain shared member set ada --email ada@example.org --vault /srv/team-vault
bigbrain shared member set ada --clear-email --vault /srv/team-vault
```

Both owner routes need the owner's **person** credential with write, like
the other membership routes. One email names at most one live member, and
one Google account at most one member. A member added by email gets an
opaque handle (`invite-<hex>`), like one created by an owner's invitation.
Emails, `pending` and the sign-in time appear only in the owner's view of
`GET /v1/members`, which also carries `email_invites: true` and `join_url`
when Google is configured (how the app picks its dialog). No route ever
returns the bound identity. The app does not set an email on an existing
member; the API and CLI above do.

**Without Google**, a member connects Claude with an **invite link** the
owner creates as usual (Settings → Members, or `POST /v1/invites`). Pasting
it on the sign-in page *consumes* it, exactly as redeeming it in the app
does — single use, expiring — so a link used for Claude can no longer
connect the BigBrain app; issue another for that.

## What a member does in Claude

1. Settings → Connectors → *Add custom connector*; paste
   `https://vault.example.com/mcp`.
2. Claude opens the sign-in page, which names the app asking (from its
   self-registration — untrusted, shown escaped), where it will return them,
   and that access is read-only — but not the vault. Sign in with Google
   (or, without Google, paste an invite link). A browser already signed in
   on `/me` skips straight to consent.
3. A consent page names the vault and who they are signed in as. *Allow
   read-only access* returns them to Claude, connected; *Deny* returns
   `access_denied`.

The connector offers four tools, all annotated read-only:

| Tool | Does |
|---|---|
| `overview` | The vault's name, who you are connected as, members, counts, the most recent evidence and claims. "Call this first" — a shared vault has no memory file. |
| `search_vault` | `query`, or `queries` (1–8 alternatives, ORed and de-duplicated), and `limit`. Literal term-AND over evidence and live claims. |
| `read_record` | One record by id: `ins_…` evidence (body windowed by `start`/`chars`, 20,000 characters by default), `ast_…` a claim with its status (live, retracted, superseded, moderated) and sources, `ent_…` every live claim naming an entity. |
| `recent` | The change feed, newest first, paged with `before`. |

They read only through the same `SharedVault` methods as `/v1/*`, so a
withdrawn contribution is not readable, searchable, listed or shown in
`recent`, and a revoked claim is marked as such. The server's instructions
tell the model that the vault is a record written by several members, never
instructions; that each claim is one member's proposal and must be
attributed; to say when the vault is silent; and that the connection is
read-only.

## Security model

- **What Claude holds** is a new `sv_` **agent** credential for the member
  with exactly `read` — whatever the member's own permissions — named
  `Claude connector · <app name>`. It is verified on every request like any
  other credential: removing the member or
  `bigbrain shared credential revoke <id>` cuts it off on the next request
  (401), and narrowing the member to no access refuses it (403).
  It works on `/mcp` and on the read routes of `/v1/*`, and gets 403 on
  every write. There is no expiry and no refresh token; each connection
  mints its own credential (listed by `bigbrain shared credential list`).
- **Sign-in is never consent.** After any login the consent page is
  always shown and needs an explicit *Allow*.
- **One refusal.** Not a member, an email bound to a different Google
  account, a removed member, no `read` access: on `/join` and on
  `/authorize` the visitor sees the same page. The reason is logged, the
  email is not. No page names the vault, its members or its size before
  sign-in; the vault's name appears on consent and on `/me`.
- **Redirects** are allowlisted when a client registers: exactly
  `https://claude.ai/api/mcp/auth_callback` and
  `https://claude.com/api/mcp/auth_callback`, plus Claude Code's loopback
  `http://localhost[:port]/callback` and `http://127.0.0.1[:port]/callback`,
  which `/authorize` matches without the port. Anything else is refused.
  Errors found before the redirect URI is vetted are shown as a page and
  never redirect. A loopback return shows an extra warning on the sign-in page.
- **PKCE S256 is mandatory.** Codes live 60 seconds, are single-use (burned
  by any attempt, right or wrong), and are bound to the client, redirect URI,
  code challenge and member. A replayed code is refused **and the credential
  it already bought is revoked**.
- **The browser that started a sign-in must finish it.** A pending
  authorization (10 minutes) is bound to an HttpOnly, SameSite=Lax cookie —
  `__Host-` prefixed and `Secure` on https — checked on the Google callback,
  the invite form and the consent form; the two forms also carry a
  per-authorization CSRF token. Otherwise a stranger could start a sign-in
  in their own Claude and send a member the link. A Google round trip from
  `/join` is bound the same way.
- **Sessions** (`/me`) are 30 minutes, in memory, in an HttpOnly,
  SameSite=Lax cookie (`__Host-bb_session`, `Secure`, on https). Each request
  re-checks that the member is live with `read`, so removing them ends it.
  *Create an app link* and *Sign out* are POSTs carrying the session's CSRF
  token.
- **App links** are single-use invites bound to an existing member, one hour,
  consumed before anything is minted, and redeemed only by the app through
  `POST /v1/invites/redeem`. A link created for a member who is removed
  before it is used redeems nothing.
- **Google is the login, not the authority.** An OIDC code flow with
  `state` and `nonce`, one callback for both purposes. The id_token comes straight
  from Google's token endpoint over TLS, so its signature is not re-checked,
  but `iss`, `aud`, `exp`, `nonce` and `email_verified === true` are.
  Scopes `openid email profile`. Members are bound by `sub`; an email whose
  member is already bound to a different Google account is refused.
- **Invite links** are consumed by the same code as app redemption
  (`lib/sharedInvites.ts`), arrive in a POST body, and are never logged. No
  person credential survives this path: an owner-created invite mints
  nothing but the connector's read-only agent credential, and a legacy
  handle-bound invite's pre-issued person credential is revoked as it is
  consumed.
- **Pages** wear bigbrain.cool's tokens, type ramp, buttons and wire mark
  in the site's default blue theme. They are self-contained HTML with everything
  escaped, `Cache-Control: no-store`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, and a CSP of `default-src 'none'`, the one
  stylesheet and the one script (it only reveals Copy buttons; pages work
  without it) pinned by hash, `font-src 'self'`, `base-uri 'none'`,
  `frame-ancestors 'none'`. Hanken Grotesk is served by the door itself
  (`/assets/hanken-grotesk-latin.woff2`, `…-latin-ext.woff2`, immutable for a
  year), embedded with `with { type: "file" }` so a `bun build --compile`
  binary carries it. There is deliberately no
  `form-action`: Chrome applies it to the redirect that follows the consent
  POST, which goes to the client.
- **Logging** stays one JSON line per request with the pathname only — never
  a query string, body, code, token, invite secret or email. Refusals log a
  reason.
- **Bounds.** Registration (20/min), the sign-in pages (120/min) and the
  token endpoint (60/min) are rate-limited, per endpoint rather than per
  caller (behind a proxy there is no client address the door can trust).
  Public POST bodies are capped at 16 KiB, `/mcp` bodies at 1 MiB. The client
  registry holds at most 1,000 clients, drops those unused for 30 days, and
  evicts the least recently used at the cap — harmless, because a client is
  only needed between sign-in and token; the credential outlives it.

### Deliberate exceptions to "every path answers 401"

With the connector on, these answer without a credential: the two
`/.well-known/oauth-protected-resource` documents and
`/.well-known/oauth-authorization-server` (static JSON derived from the
public URL), `POST /register`, `GET /authorize`, `POST /authorize/consent`,
`POST /token`, the two font files, and `GET /invite` (a generic "paste this
link, don't open it" page for an invite or app link opened in a browser — the
link's secret is in the fragment and never reaches the door); with Google, also `GET /oauth/google`,
`GET /oauth/google/callback`, `GET /join`, `GET /join/google`, `GET /me`,
`POST /me/app-link` and `POST /me/signout`; without Google,
`POST /authorize/invite` instead. `/mcp` still requires a credential; its 401 carries
`WWW-Authenticate: Bearer resource_metadata="https://vault.example.com/.well-known/oauth-protected-resource"`
so Claude can discover the sign-in. Every other path, and any near miss of
these, is the door's usual undifferentiated 401.

## Limits of this version

- **Read-only.** No write tools; contribution stays in the BigBrain app.
- **No refresh tokens, no expiry.** A connection lasts until the member or
  the credential is revoked.
- **Dynamic client registration only** — no Client ID Metadata Documents,
  so Claude registers a fresh client per connection (bounded as above).
- **Protocol versions are the SDK's.** Claude Desktop (tested 2026-10-01)
  opens each connection naming MCP protocol `2026-07-28`, which
  `@modelcontextprotocol/sdk` 1.30–1.31 does not speak; that first request is
  refused with 400 and Claude falls back to a supported version on its own.
  The door logs each such refusal as `mcp refused` with the reason.
- **In-memory sign-in state.** A server restart drops sign-ins in flight
  and `/me` sessions; the member starts again.
- **No invitation email** is sent by the door; the owner sends the join link.
  Because the link is constant, sending mail can be added later without
  changing the flow.
- **No UI to set an email on an existing member**; the owner uses the API or
  CLI.
- **Rate limits are global per endpoint**, so a flood of sign-in attempts
  can delay legitimate ones for a minute.
- **Discovery documents are not rate-limited** — they are static and cheap,
  and limiting them would only add a way to block discovery.

## Verification

`test/sharedConnector.test.ts`, handler-level with a fake Google behind the
injected `fetch` and an injected clock: the disabled door unchanged;
discovery fields; the `/mcp` 401; registration accept/refuse and its rate
limit; `/authorize` validation; Google happy paths (bind on first sign-in,
match by `sub`, survive an address change) and refusals; the invite path
with no surviving person credential; consent deny, CSRF and browser binding;
code replay, wrong verifier/client/redirect/resource, expiry; the token's
read-only reach on `/mcp` and REST; revocation; every MCP tool, windowing,
and a withdrawn contribution staying hidden; the owner email routes and CLI;
the join page's silence about the vault, sessions, CSRF, app links (once,
same member, follows access, expires), pending members, the one refusal
page, no identity in any response, the font route, the app refusing a join
link without a request; and that nothing secret reaches the log.
`test/support/sharedMembershipEmail.browser.cjs` drives the app's email
invite dialog in Chrome.

To look at the pages in a browser, `bun test/support/sharedConnectorPreview.ts`
runs a door on `http://127.0.0.1:4790` with invented members and a fake
Google account picker.
