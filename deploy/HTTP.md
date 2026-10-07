# HTTP intake — tokens, the API, and what talks to it

The vault's front door for anything not on this machine: `bin/api.ts`
(localhost `:4748`), an authenticated HTTP intake behind a TLS proxy.
Same byte-mover underneath as a local `bigbrain drop` (`lib/intake.ts`),
one difference in kind: the HTTP path **stamps provenance** — `source:
api`, `submitted_by: <token id>`, `submitted_via: <token name>`,
`received: <ts>` are written by the server from the verified credential
and any client-supplied values for those keys are stripped. Locally the
machine account is the trust; on the HTTP path the token is, and the
stamp makes every item say which one.

## Tokens

Capability credentials, not accounts: a token can do exactly what its
scopes say and nothing else. Minted on the host (possession of the host
account is the root of trust, exactly as with ssh):

```
bigbrain auth create --name "chrome extension"                      # inbox:write
bigbrain auth create --name "laptop" --scope inbox:write
bigbrain auth list
bigbrain auth revoke <id>
```

- The secret (`bb_<id>_<secret>`) is printed **once**; only its sha256 is
  stored (`~/.config/bigbrain/tokens/<vault-hash>.json`, 0600, outside the
  vault). A leaked store file authorizes nothing.
- Scopes: `inbox:write` (drop → intake) is the only scope a drop token needs.
  `vault:read` is the non-browser read path. `tend` is the gardener door
  (#479) — claim and submit the vault's due work; ONE designated machine per
  vault holds it. (`outbox:write` retired with email on 2026-08-10 — the
  vault does not send.)
- Revocation is immediate — the API re-reads the store per request.
- Fail-closed: no store, empty store, unreadable store ⇒ every request 401s.

## Host setup (once)

1. **DNS** — point a record (e.g. `vault.example.com`) at the host.
2. **TLS proxy** — `deploy/Caddyfile.example`; Caddy fetches certificates
   itself. Never expose `:4748` directly. The web viewer (`:4747`) stays
   off the proxy — it has one operator; reach it over `ssh -L` with
   `bigbrain open --print` ([self-host](../docs/self-host.md)).
3. **Run the engine** — the app supervises the `api` child and restarts
   it if it dies (log at `.state/logs/api.log`).
4. **Mint** a token (above).
5. **Smoke-test** from anywhere:

   ```
   curl -H "Authorization: Bearer $TOKEN" https://vault.example.com/v1/whoami
   echo hi | curl -sS -H "Authorization: Bearer $TOKEN" \
     --data-binary @- "https://vault.example.com/v1/drop?name=smoke-test"
   ```

   The drop answers `{"path":"inbox/smoke-test.md"}`. The supervisor
   picks it up on the gardener's next tick; nothing is poked.

## Clients

**Browser extension:** `clients/browser-extension/` — one MV3 extension for
Chrome and Firefox/Zen (load unpacked / load temporary add-on), paste the
endpoint and a token into its options page. Selection or page → "Send to
BigBrain" → inbox, provenance stamped.

**Claude Code:** `clients/claude-plugin/` — a plugin whose two skills
(`vault-search`, `vault-add`) and SessionStart hook speak this API and never
touch the filesystem, so they work from any directory on any machine. POSIX
`sh` + `curl` only. Its credential is an agent-kind token with `vault:read` +
`inbox:write`, minted by `bigbrain connect` on the machine that hosts the
vault into `~/.config/bigbrain/client-tokens.json`.
`bigbrain connect` also installs the plugin from the engine tree.

**Anything else:** it's one curl. `POST /v1/drop?name=<basename>`,
body = the markdown item, `Authorization: Bearer <token>`. 401 bad/revoked
token · 403 missing scope · 413 over 10MB · 429 over 30 req/min per token.

## API surface

| Route | Auth | Answer |
|---|---|---|
| `POST /v1/pair` | none — unauthed, once per code | `{code, client}` → the browser's own token (#486, `lib/pair.ts`) |
| `GET /v1/whoami` | any valid token | `{"id","name","owner","kind","scopes"}` |
| `POST /v1/drop?name` | `inbox:write` | `{"path":"inbox/….md","id"}` |
| `POST /v1/session` | `inbox:write` | `{"path","id","seq","turns"}` — a raw Claude Code transcript segment, projected and landed (#47). Metadata rides `X-BigBrain-{Session,Cwd,Stream,From-Line}` (query params also accepted); body is `application/x-ndjson`. A segment with no conversation answers `200 {"skipped"}` so the caller still advances. |
| `POST /v1/enqueue` | `inbox:write` | `{"id","path"}` — a voice arrival: a directive or request, landed in the insertion log like any other (`lib/voice.ts`). The route name and its `{refs, guidance}` body are the retired queue's spelling, kept so clients need not change. |
| `POST /v1/observe` | `inbox:write` | `{"id","path"}` — the memory pass's demand spool |
| `GET /v1/status` | `vault:read` | due-work count + the newest run (#498) |
| `GET /v1/note?path=…` | `vault:read` | one note, frontmatter parsed and links resolved |
| `GET /v1/search?q&n=20` | `vault:read` | `{"hits"}` — ranked FTS over the record |
| `GET /v1/memory[?path=slug]` | `vault:read` | `memory/MEMORY.md`, or one topic file, raw markdown |
| `GET /v1/gardener/next?kinds&limit` | `tend` | `{"items"}` — due work + context packs; a pure read, no lease (#479) |
| `POST /v1/gardener/submit` | `tend` | `{"results","appended","deduped","rejected"}` — the one wire validator, per-item and idempotent (#479) |

The read routes are jailed: `note` reaches only the committed record and
the raw sources it cites, and `memory` is a jail of its own, one tree
wide. A path that escapes its jail is 403, an absent one
404 — the two stay distinct on purpose. `search` answers only paths the
other routes can then fetch, so `memory/` is filtered out of its hits and
reached through `GET /v1/memory` instead. `search` and `note` accept
`via=gardener` from a tend-scoped token, so gardener machine reads ledger
apart from agent demand (#502).

The blob CAS routes (`PUT`/`GET`/`DELETE /v1/blob`) and the directory
listing ones (`ls`, `file`, `recent`) were retired on 2026-08-30 with the
rest of the dead surface — nothing had called them since the tile shell and
the `--role client` mirror went. The CAS itself is untouched: `/v1/drop`
still stores attachments in it, and `bigbrain blob path <sha>` resolves one
locally.

One JSON log line per request (token **id** only — the secret never
appears in any log). `journal/` and `git log` remain the audit trail for
what the gardener did with each item; `submitted_by` in the filed note's
frontmatter ties it back to the credential.
