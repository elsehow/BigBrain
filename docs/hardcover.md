# Hardcover integration

Hardcover (hardcover.app) is a book tracker. BigBrain connects to it for
**lookups only**: it never changes anything on Hardcover, never polls it, and
remembers nothing it reads unless an agent saves something with `drop`.

## What agents can read

Three tools, each one fixed GraphQL query with one top-level field. An agent
chooses only the query's validated arguments, never its text.

| Tool | Reads | Arguments |
| --- | --- | --- |
| `hardcover_shelf` | the books on one of your shelves, newest first, with your rating and reading dates | `status`: want, reading, read, paused or dnf; `limit` up to 50; `offset` |
| `hardcover_book` | one book: title, authors, description, Hardcover's average rating, and your own shelf, rating, review and dates when it is in your library | `id` |
| `hardcover_search` | the Hardcover catalog, books only | `query` up to 200 characters; `limit` up to 10; `page` |

Books you marked "ignored" on Hardcover are never returned.

Hardcover's text is edited by its community, and your own review comes back
through the same API, so every string these tools return reaches the agent
fenced as untrusted data, with sign-in material screened out.

**Where it goes.** What these tools return becomes part of the agent's
context, so it is sent to the model provider you configured for that agent
(Pilot's, or the external client's), like any other tool result.

## Who can read it

A newly added Hardcover account is readable by Pilot. External clients (Claude
Code, Codex and others connected with a BigBrain token) can read it only once
you grant them access in Settings → Integrations.

## Signing in

Settings → Integrations → Library → Hardcover → Add, then Connect. Your browser
opens Hardcover's consent screen; approve it and return to BigBrain.

Until BigBrain's own Hardcover app is registered, the library card and Settings
say that Hardcover sign-in isn't available in this build; a vault can sign in
with an app of its own meanwhile ([below](#your-own-client-id-self-hosting)).

- BigBrain asks for exactly `read:me:content read:library read:catalog:search
  read:catalog:data`: who you are, your library, and the catalog.
- If Hardcover grants anything more (`all`, or any `write:` scope), BigBrain
  refuses the sign-in, keeps nothing, asks Hardcover to revoke what it issued,
  and says "Hardcover granted more than read access; reconnect."
- The sign-in uses PKCE (S256) and a one-time callback on `127.0.0.1`; the
  answer must carry the `state` BigBrain sent and name `https://api.hardcover.app`
  as its issuer, or it is refused before its code is used.

Tokens are kept in the vault's `.spool/integration-oauth/hardcover/` (readable
only by you; agents BigBrain runs cannot reach `.spool`). Hardcover access
tokens last a week. Refresh tokens last six months and rotate on every use;
Hardcover ends the whole sign-in if one is ever used twice. BigBrain spends
each refresh token once, under a lock every BigBrain process honors, and after
each refresh checks that Hardcover still names the account you signed in with.
If it names someone else, BigBrain disconnects.

## When it needs reconnecting

Settings shows **Needs reconnecting**, and agents are told "Hardcover needs
reconnecting: BigBrain → Settings → Integrations", when the sign-in can no
longer be renewed: you revoked BigBrain on Hardcover's Authorized Apps page, six
months passed without use, Hardcover reset its tokens, or a refresh failed
after it may have reached Hardcover (BigBrain never resends one). The app
also shows a notice until you reconnect or clear it (one notice however many
accounts need it). Click Reconnect on the notice or the Hardcover card.

**Restoring a backup means reconnecting.** A backup that includes the vault's
`.spool/` holds a refresh token that has since been spent; the first refresh
after the restore sends it again, Hardcover ends the whole sign-in, and the
account needs reconnecting.

Disconnect forgets the tokens on this machine. To end them on Hardcover too,
revoke BigBrain on Hardcover's Authorized Apps page.

## Limits

BigBrain keeps its own budget per Hardcover account, shared by every BigBrain
process on the machine: bursts of 5, about 30 requests a minute, and 4,000 a day
(resetting at midnight UTC). Hardcover's own free-plan limits (10, 60 and 5,000)
are shared by every app you use with it, so BigBrain stays below them. Each
lookup is one request; a sign-in or refresh adds one to check who is signed in.
A request Hardcover refuses (429) or that times out is reported to the agent as
"Hardcover refused or timed out" and not retried.

## Your own client id (self-hosting)

BigBrain signs in with its own registered Hardcover app. To use one of yours
instead, register an app on Hardcover (API → Developer Apps):

- Application type: **Mobile, desktop, or CLI**
- Redirect URI: `http://127.0.0.1/callback` (Hardcover accepts any port on a
  loopback address; BigBrain picks a free one for each sign-in)
- Device Authorization Grant: **off**
- Scopes: `read:me:content`, `read:library`, `read:catalog:search`,
  `read:catalog:data`

then name its client id in `vault.yaml`:

```yaml
integrations:
  hardcover:
    clientId: your-client-id
```

## Terms

Hardcover's API terms allow a person's library, ratings, reviews and reading
dates to be read only on that person's behalf, with their permission.
BigBrain reads only the signed-in person's own data and the public catalog,
for them, and does not use any of it to train models.
