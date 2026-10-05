# Running a shared vault on a server — the runbook

A **shared vault** is one BigBrain record several people (and their agents)
read and write, each under their own name. Because several people have to
reach it, it is the one part of BigBrain that runs on a server: one small
binary, `bin/shared.ts serve`, behind TLS, on a machine you control. The
design is in [docs/shared-vault.md](../../docs/shared-vault.md); the Claude
connector in [docs/shared-vault-connector.md](../../docs/shared-vault-connector.md).
This file is only the steps.

It is **not** the personal BigBrain. That is the Mac app
(`curl -fsSL https://bigbrain.exe.xyz/install.sh | sh`), with no Linux build.
Members use their own BigBrain app, or just Claude, to reach the shared vault.

## If you are an agent following this

Ask the person for these before starting, and do not guess them:

1. **A Linux server** they control, with sudo, and a **domain** (or a host
   whose platform terminates TLS for you, such as exe.dev).
2. **The owner's handle**: a short lowercase name such as `ada`. It is
   permanent.
3. **Google sign-in, yes or no.** Yes is the smoother path for members, but
   the person has to create a Google OAuth client (step 6). No means members
   join with single-use invite links.

Rules:

- **One vault per server.** Every vault on a machine would run as the same
  user, so a second vault belongs on a second machine.
- **Never point this at a personal vault.** `serve` refuses a directory
  without `shared: true` in its `vault.yaml`. Do not add that line by hand to
  get around the refusal.
- **Secrets print once.** `init` prints the owner credential, and the invite
  tool writes a link to a file. Save them straight to mode-0600 files. Do not
  echo them into chat, logs or commits.
- **Never expose the port itself.** The server speaks plain HTTP. Only the
  TLS front is public.

Each step ends with a **Check**. Do not go on until it passes.

## 1. Build the binaries

On any machine with [bun](https://bun.sh) and a checkout of this repo,
including a Mac (bun cross-compiles):

```sh
git clone https://github.com/elsehow/BigBrain && cd BigBrain && bun install
bun build --compile --target=bun-linux-x64 bin/shared.ts        --outfile bigbrain-shared
bun build --compile --target=bun-linux-x64 bin/shared-invite.ts --outfile bigbrain-shared-invite
```

Use `--target=bun-linux-arm64` for an ARM server. Copy both files to the
server's `/usr/local/bin/`.

**Check** (on the server): `bigbrain-shared` prints usage and exits.

## 2. Create the service user and directory

```sh
sudo useradd --system --create-home --home-dir /var/lib/bigbrain-shared --shell /usr/sbin/nologin bigbrain
sudo chmod 700 /var/lib/bigbrain-shared
```

Everything lives under `/var/lib/bigbrain-shared/`: `vault/` (the record),
and beside it, never inside it, `members.json` (members and hashed
credentials) and `owner.json` (the owner's credential).

## 3. Create the vault

```sh
sudo -u bigbrain sh -c 'umask 077 && bigbrain-shared init \
  --vault /var/lib/bigbrain-shared/vault \
  --members /var/lib/bigbrain-shared/members.json \
  --owner ada --display "Ada" --json > /var/lib/bigbrain-shared/owner.json'
```

`owner.json` holds the owner credential (`.token`, `sv_…`). It is the one
copy, so keep it.

The vault's display name defaults to "Shared BigBrain". It is the `name` in
`vault/.shared-identity.json`, created the first time the vault is used
(an invite, or the first authenticated request). Edit it while the service
is stopped.

**Check:** `sudo -u bigbrain bigbrain-shared inspect --vault /var/lib/bigbrain-shared/vault --members /var/lib/bigbrain-shared/members.json`
prints `feed head 0 · 0 evidence · 0 assertions`.

## 4. Put TLS in front

Pick one.

**A. Your own domain, with Caddy** (recommended). Point a DNS record at the
server, install Caddy, and add a site block. The server stays on loopback.

```
vault.example.com {
	reverse_proxy 127.0.0.1:4749
}
```

**B. A platform that terminates TLS for you** (exe.dev, a cloud load
balancer). The server has to listen where the proxy reaches it. In the unit
file below, change `--host 127.0.0.1 --port 4749` to the platform's port
(exe.dev: `--host 0.0.0.0 --port 8000`) and add `--remote`. Without
`--remote` the server refuses to bind off loopback. `--remote` is your
statement that TLS is in front of it.

Using Claude's connector? A firewall in front must let Anthropic's egress
range in (`160.79.104.0/21` at the time of writing).

## 5. Install the service

Copy [`bigbrain-shared.service`](bigbrain-shared.service) to
`/etc/systemd/system/`, set `BIGBRAIN_SHARED_PUBLIC_URL` in it to your
`https://` origin (no path), and:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now bigbrain-shared
journalctl -u bigbrain-shared -n 5
```

The public URL turns on the Claude connector. Leave it out only if no one
will use Claude.

**Check:** the log's first line is
`{"shared":"listening",…,"connector":"https://vault.example.com/mcp",…}`. Then,
from anywhere:

```sh
curl -s https://vault.example.com/.well-known/oauth-authorization-server   # JSON whose issuer is your origin
curl -s -o /dev/null -w '%{http_code}\n' https://vault.example.com/v1/feed  # 401
OWNER=$(sudo jq -r .token /var/lib/bigbrain-shared/owner.json)
curl -s -H "Authorization: Bearer $OWNER" https://vault.example.com/v1/whoami  # "role":"owner"
```

## 6. Google sign-in (optional)

In the Google Cloud console, create an OAuth client of type *Web application*
with one redirect URI, `https://vault.example.com/oauth/google/callback`, and
scopes `openid email profile`. Put both halves in `/etc/bigbrain-shared.env`
(mode 0600, owned by root):

```
BIGBRAIN_SHARED_GOOGLE_CLIENT_ID=…apps.googleusercontent.com
BIGBRAIN_SHARED_GOOGLE_CLIENT_SECRET=…
```

Then `sudo systemctl restart bigbrain-shared`. While the Google app is in
*Testing*, only its listed test users can sign in.

**Check:** the listening line says `"google":true`, and
`https://vault.example.com/join` shows a *Sign in with Google* page.

## 7. Connect the owner's BigBrain app

Make a single-use link for the owner (it expires in 24 hours):

```sh
sudo -u bigbrain sh -c 'umask 077 && bigbrain-shared-invite \
  --vault /var/lib/bigbrain-shared/vault --members /var/lib/bigbrain-shared/members.json \
  --member ada --endpoint https://vault.example.com --out /var/lib/bigbrain-shared/ada-invite.txt'
```

The owner pastes the link from that file into BigBrain → Settings → the
shared vault → *Connect vault*. Delete the file afterwards.

**Check:** the app shows the vault, and *Members* lists the owner.

## 8. Invite members

From the owner's app: Settings → the shared vault → **Members** → *Invite
someone*.

- **With Google:** enter their email. Send them `https://vault.example.com/join`.
  After signing in they get the Claude connector URL and app links.
- **Without Google:** the dialog gives a single-use link. They paste it into
  the app's *Connect vault*, or into Claude's sign-in page. Either use spends
  the link.

**In Claude:** Settings → Connectors → *Add custom connector* →
`https://vault.example.com/mcp`. The connector is read-only. Contributing
happens in the BigBrain app.

From the server, the same is available as
`bigbrain-shared member add|list|set|revoke` and
`bigbrain-shared credential list|revoke` (each with `--vault … --members …`).

## Upgrade

Rebuild both binaries (step 1) from a newer `main`, then:

```sh
sudo cp /usr/local/bin/bigbrain-shared /usr/local/bin/bigbrain-shared.prev
sudo install -m 755 bigbrain-shared /usr/local/bin/bigbrain-shared
sudo systemctl restart bigbrain-shared
```

To roll back, put `.prev` back and restart. Run the step 5 checks again.

## Backup

Stop the service first. A tar of live files fails on files that change
under it.

```sh
sudo systemctl stop bigbrain-shared
sudo tar -C /var/lib -czf ~/bigbrain-shared-$(date +%Y%m%d-%H%M).tgz bigbrain-shared
sudo systemctl start bigbrain-shared
```

The archive holds credentials (hashed) and the owner's token. Store it like a
secret.

## When something is wrong

| Symptom | Cause |
|---|---|
| `refusing to bind … without --remote` | Option B in step 4 without `--remote`, or a `--host` you did not mean. |
| `… does not say shared: true` | `--vault` points at the wrong directory, never a personal vault. |
| `another server holds …/shared-server.lock` | Another `serve` is running on this vault, often a manual run beside the service. A lock left by a dead process is reclaimed on its own. |
| Member commands hang or fail on `members.json.lock` | A membership change was interrupted. Stop the service and any `bigbrain-shared` commands, remove the empty `members.json.lock` directory, then start again. |
| Every path is 401, even `/.well-known/…` | The connector is off: no public URL in the unit. |
| Claude says it cannot connect | The proxy or firewall blocks Anthropic's range, or answers slowly (Claude allows 10 seconds). |
| `"google":false` though the env file is set | The unit has no `EnvironmentFile=` line, or the file is not where it points. With only one half set, the server refuses to start and says so. |
