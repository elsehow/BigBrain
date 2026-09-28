# Auth — the viewer has no login, so don't publish it

The web viewer (`web/server.ts`) binds `127.0.0.1` and has no login of its
own: whoever reaches the socket is the host operator. That is the whole
model — reach it locally, over `ssh -L 4747:127.0.0.1:4747 <host>`, or on a
private network (Tailscale).

**Do not put it behind a public reverse proxy.** There is no gate left to
turn on. Until 2026-08-30 the server could be told to trust an
authenticating edge (`BIGBRAIN_TRUSTED_EDGE`, an email allowlist, a
read-only method gate, and `X-ExeDev-*` identity headers), and it stamped
drop provenance from the verified email. The whole contract went with the
hosted product (#570): its router (`control/router.ts`, retired 2026-08-26)
was the only thing that ever stripped and set those headers, no install ever
set the flags, and a gate that nothing configures is a gate that only
misleads. The last commit carrying it is tagged `hosted-multitenant-final`.

BigBrain is one vault, one machine, one operator (`CLAUDE.md`, "there are no
hosts"). A viewer reached by more than one person is a product decision, not
a config flag — reopen it as one.

## The API is a different door

The INTAKE API (`:4748`) authenticates on its own with drop tokens
(`lib/auth.ts`), so it CAN be published: `deploy/HTTP.md` and
`deploy/Caddyfile.example` have the TLS proxy config. The example
deliberately does not proxy the viewer.

## See also

- `docs/self-host.md` — reaching the viewer from another machine.
