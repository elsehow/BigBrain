# The shared vault in Claude — a read-only connector

*Opt-in, off by default. `lib/sharedOAuth.ts` (sign-in and tokens),
`lib/sharedMcp.ts` (the MCP server), wired into the door by
`lib/sharedVaultApi.ts`. Read [shared-vault.md](shared-vault.md) first: this
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

## Operator setup

1. **Serve the door behind TLS, as today.** Nothing about the proxy changes
   (`deploy/Caddyfile.example`, a site block proxying to `127.0.0.1:4749`):
   the connector's paths — `/.well-known/…`, `/register`, `/authorize…`,
   `/oauth/google…`, `/token`, `/mcp` — go to the same upstream as `/v1/*`.
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

3. **Optionally, add "Sign in with Google".** In the Google Cloud console,
   create an OAuth client of type *Web application* with one authorized
   redirect URI:

   ```
   https://vault.example.com/oauth/google/callback
   ```

   The consent screen needs only the non-sensitive `openid` and `email`
   scopes. While the Google app is in *Testing*, only the test users you list
   can sign in; publish it for anyone else. Then set both halves in the
   server's environment (both or neither — half a client refuses to start):

   ```
   BIGBRAIN_SHARED_GOOGLE_CLIENT_ID=…apps.googleusercontent.com
   BIGBRAIN_SHARED_GOOGLE_CLIENT_SECRET=…
   ```

   Without Google, members sign in with an invite link (below).

4. **Registered clients** are kept in `<members-file>.oauth-clients.json`
   (mode 0600, beside the member store, outside the vault).

## Adding a member who will connect from Claude

Google sign-in matches a **verified email** the owner put on a member — once.
On that first sign-in the member's Google account (`iss`, `sub`) is bound to
them, and from then on they are matched by that binding, so a later change
of address on Google's side does not lock them out.

```
# a new member by email — a record now, no credential; they sign in to get one
curl -H "Authorization: Bearer $OWNER" -H 'Content-Type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com","permission":"read"}' https://vault.example.com/v1/members

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
Emails appear only in the owner's view of `GET /v1/members`; other members
never see them. The web UI does not manage emails yet.

A member without an email can still connect with an **invite link** the
owner creates as usual (Settings → Members, or `POST /v1/invites`). Pasting
it on the sign-in page *consumes* it, exactly as redeeming it in the app
does — single use, expiring — so a link used for Claude can no longer
connect the BigBrain app; issue another for that.

## What a member does in Claude

1. Settings → Connectors → *Add custom connector*; paste
   `https://vault.example.com/mcp`.
2. Claude opens the vault's sign-in page, which names the vault, the app
   asking (from its self-registration — untrusted, shown escaped), where it
   will return them, and that access is read-only. Sign in with Google, or
   paste an invite link.
3. A consent page shows who they are signed in as. *Allow read-only access*
   returns them to Claude, connected; *Deny* returns `access_denied`.

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
- **Sign-in is never consent.** After either login the consent page is
  always shown and needs an explicit *Allow*. A member without `read` is
  refused there.
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
  in their own Claude and send a member the link.
- **Google is the login, not the authority.** An OIDC code flow with
  `state` and `nonce`, scopes `openid email`. The id_token comes straight
  from Google's token endpoint over TLS, so its signature is not re-checked,
  but `iss`, `aud`, `exp`, `nonce` and `email_verified === true` are.
  Members are bound by `sub`; an email whose member is already bound to a
  different Google account is refused.
- **Invite links** are consumed by the same code as app redemption
  (`lib/sharedInvites.ts`), arrive in a POST body, and are never logged. No
  person credential survives this path: an owner-created invite mints
  nothing but the connector's read-only agent credential, and a legacy
  handle-bound invite's pre-issued person credential is revoked as it is
  consumed.
- **Pages** are self-contained HTML with everything escaped, `Cache-Control:
  no-store`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a
  CSP of `default-src 'none'`, the one inline style by hash,
  `base-uri 'none'`, `frame-ancestors 'none'`. There is deliberately no
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
public URL), `POST /register`, `GET /authorize`, `POST /authorize/invite`,
`POST /authorize/consent`, `GET /oauth/google`, `GET /oauth/google/callback`
and `POST /token`. `/mcp` still requires a credential; its 401 carries
`WWW-Authenticate: Bearer resource_metadata="https://vault.example.com/.well-known/oauth-protected-resource"`
so Claude can discover the sign-in. Every other path, and any near miss of
these, is the door's usual undifferentiated 401.

## Limits of this version

- **Read-only.** No write tools; contribution stays in the BigBrain app.
- **No refresh tokens, no expiry.** A connection lasts until the member or
  the credential is revoked.
- **Dynamic client registration only** — no Client ID Metadata Documents,
  so Claude registers a fresh client per connection (bounded as above).
- **In-memory sign-in state.** A server restart drops sign-ins in flight;
  the member starts again from Claude.
- **No web UI** for member emails yet; the owner uses the API or CLI.
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
and that nothing secret reaches the log.
