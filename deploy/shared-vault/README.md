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

Each step ends with a **Check**. Do not go on until it passes. Commands
marked *(here)* run on the machine you build on; *(server)* on the server.
The server needs `curl` and `jq` (`sudo apt-get install -y curl jq`).

## 1. Build the binaries

*(here)* On any machine with [bun](https://bun.sh), including a Mac (bun
cross-compiles). `uname -m` on the server picks the target: `x86_64` →
`bun-linux-x64`, `aarch64` → `bun-linux-arm64`.

```sh
git clone https://github.com/elsehow/BigBrain && cd BigBrain && bun install
T=bun-linux-x64
bun build --compile --target=$T bin/shared.ts        --outfile bigbrain-shared
bun build --compile --target=$T bin/shared-invite.ts --outfile bigbrain-shared-invite
scp bigbrain-shared bigbrain-shared-invite deploy/shared-vault/bigbrain-shared.service server:
```

That builds `main`. To pin what you run, `git checkout <commit>` before
building, and note it for upgrades.

*(server)*

```sh
sudo install -m 755 bigbrain-shared bigbrain-shared-invite /usr/local/bin/
```

**Check** *(server)*: `bigbrain-shared` prints usage and exits. The usage
says `bigbrain shared <command>`; the installed name is `bigbrain-shared`,
with the same commands.

## 2. Create the service user and directory

*(server)*

```sh
sudo useradd --system --no-create-home --home-dir /var/lib/bigbrain-shared --shell /usr/sbin/nologin bigbrain
sudo install -d -m 700 -o bigbrain -g bigbrain /var/lib/bigbrain-shared
```

Everything lives under `/var/lib/bigbrain-shared/`: `vault/` (the record),
and beside it, never inside it, `members.json` (members and hashed
credentials) and `owner.json` (the owner's credential).

**Check:** `sudo stat -c '%U %a' /var/lib/bigbrain-shared` prints `bigbrain 700`.

## 3. Create the vault

*(server)* Use your owner handle in place of `ada`.

```sh
sudo -u bigbrain sh -c 'umask 077 && bigbrain-shared init \
  --vault /var/lib/bigbrain-shared/vault \
  --members /var/lib/bigbrain-shared/members.json \
  --owner ada --display "Ada" --json > /var/lib/bigbrain-shared/owner.json'
```

`owner.json` holds the owner credential (`.token`, `sv_…`). It is the one
copy, so keep it.

**Check:** `sudo -u bigbrain bigbrain-shared inspect --vault /var/lib/bigbrain-shared/vault --members /var/lib/bigbrain-shared/members.json`
includes `feed head 0 · 0 evidence · 0 assertions`.

## 4. Put TLS in front

Pick one.

**A. Your own domain, with Caddy** (recommended). Point a DNS record at the
server, install Caddy, and add a site block. The server stays on loopback.

```
YOUR-DOMAIN {
	reverse_proxy 127.0.0.1:4749
}
```

**B. A platform that terminates TLS for you** (exe.dev, a cloud load
balancer). The server has to listen where the proxy reaches it: in step 5,
change `--host 127.0.0.1 --port 4749` to the platform's port and add
`--remote`. Without `--remote` the server refuses to bind off loopback.
`--remote` is your statement that TLS is in front of it.

On **exe.dev**, the port is 8000 (`--host 0.0.0.0 --port 8000 --remote`), and
the HTTPS URL starts out private (exe.dev login required), so neither
members nor Claude can reach it. *(here)*:

```sh
ssh exe.dev share port <vm> 8000
ssh exe.dev share set-public <vm>
ssh exe.dev share show <vm>        # Public
```

Using Claude's connector? A firewall in front must let Anthropic's egress
range in (`160.79.104.0/21` at the time of writing).

**Check:** step 5's checks cover this.

## 5. Install the service

*(server)* Set your origin (no path) in the unit file you copied in step 1,
and, for option B, the host, port and `--remote`. Then install it.

```sh
sed -i 's|https://vault.example.com|https://YOUR-ORIGIN|' bigbrain-shared.service
# option B only, e.g. exe.dev:
# sed -i 's|--host 127.0.0.1 --port 4749|--host 0.0.0.0 --port 8000 --remote|' bigbrain-shared.service
sudo install -m 644 bigbrain-shared.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bigbrain-shared
sudo journalctl -u bigbrain-shared -n 5
```

The public URL turns on the Claude connector. Leave it out only if no one
will use Claude.

**Check:** the log contains
`{"shared":"listening",…,"connector":"https://YOUR-ORIGIN/mcp",…}` (with
`--remote`, a warning line comes first). Then *(here)*, through TLS:

```sh
curl -s https://YOUR-ORIGIN/.well-known/oauth-authorization-server   # JSON whose issuer is your origin
curl -s -o /dev/null -w '%{http_code}\n' https://YOUR-ORIGIN/v1/feed  # 401
```

and *(server)*, on the port the service listens on (a server often cannot
reach its own public URL):

```sh
curl -s -H "Authorization: Bearer $(sudo jq -r .token /var/lib/bigbrain-shared/owner.json)" \
  http://127.0.0.1:4749/v1/whoami        # "role":"owner"
```

The vault's display name defaults to "Shared BigBrain", the `name` in
`vault/.shared-identity.json`, which that request creates. To rename it,
`sudo systemctl stop bigbrain-shared`, edit `name`, and start it again.

## 6. Google sign-in (optional)

In the Google Cloud console, create an OAuth client of type *Web application*
with one redirect URI, `https://YOUR-ORIGIN/oauth/google/callback`, and
scopes `openid email profile`. *(server)* Put both halves in
`/etc/bigbrain-shared.env`, owned by root, mode 0600:

```
BIGBRAIN_SHARED_GOOGLE_CLIENT_ID=…apps.googleusercontent.com
BIGBRAIN_SHARED_GOOGLE_CLIENT_SECRET=…
```

Then `sudo systemctl restart bigbrain-shared`. While the Google app is in
*Testing*, only its listed test users can sign in.

**Check:** the listening line says `"google":true`, and
`https://YOUR-ORIGIN/join` shows a *Sign in with Google* page.

## 7. Connect the owner's BigBrain app

*(server)* Make a single-use link for the owner (it expires in 24 hours):

```sh
sudo -u bigbrain sh -c 'umask 077 && bigbrain-shared-invite \
  --vault /var/lib/bigbrain-shared/vault --members /var/lib/bigbrain-shared/members.json \
  --member ada --endpoint https://YOUR-ORIGIN --out /var/lib/bigbrain-shared/owner-invite.txt'
sudo cat /var/lib/bigbrain-shared/owner-invite.txt
sudo rm /var/lib/bigbrain-shared/owner-invite.txt
```

The owner pastes that link into BigBrain → Settings → the shared vault →
*Connect vault*. An agent hands the link to the owner directly. It never
goes into a chat log, an issue or a commit.

**Check:** the app shows the vault, and *Members* lists the owner.

## 8. Invite members

From the owner's app: Settings → the shared vault → **Members** → *Invite
someone*.

- **With Google:** enter their email. Send them `https://YOUR-ORIGIN/join`.
  After signing in they get the Claude connector URL and app links.
- **Without Google:** the dialog gives a single-use link. They paste it into
  the app's *Connect vault*, or into Claude's sign-in page. Either use spends
  the link.

**In Claude:** Settings → Connectors → *Add custom connector* →
`https://YOUR-ORIGIN/mcp`. The connector is read-only. Contributing
happens in the BigBrain app.

From the server, the same is available as
`bigbrain-shared member add|list|set|revoke` and
`bigbrain-shared credential list|revoke` (each with `--vault … --members …`).

## Upgrade

*(here)* Rebuild both binaries (step 1) from a newer commit and `scp` them to
the server. *(server)*:

```sh
sudo cp /usr/local/bin/bigbrain-shared        /usr/local/bin/bigbrain-shared.prev
sudo cp /usr/local/bin/bigbrain-shared-invite /usr/local/bin/bigbrain-shared-invite.prev
sudo install -m 755 bigbrain-shared bigbrain-shared-invite /usr/local/bin/
sudo systemctl restart bigbrain-shared
```

To roll back, put the `.prev` files back and restart. **Check:** step 5's
checks pass again.

## Backup

*(server)* Stop the service first. A tar of live files fails on files that
change under it.

```sh
sudo systemctl stop bigbrain-shared
sudo sh -c 'umask 077 && tar -C /var/lib -czf /root/bigbrain-shared-$(date +%Y%m%d-%H%M).tgz bigbrain-shared'
sudo systemctl start bigbrain-shared
```

The archive holds the owner's token, hashed credentials and pending invite
links, so it is created mode 0600. Keep it like a secret, off the server.

To restore: stop the service, move `/var/lib/bigbrain-shared` aside,
`sudo tar -C /var/lib -xzf <archive>`, start the service.

**Check:** `sudo tar -tzf <archive> | grep -c -E 'owner.json|members.json$'`
prints `2`.

## When something is wrong

| Symptom | Cause |
|---|---|
| `refusing to bind … without --remote` | Option B in step 4 without `--remote`, or a `--host` you did not mean. |
| `… does not say shared: true` | `--vault` points at the wrong directory, never a personal vault. |
| `another server holds …/shared-server.lock` | Another `serve` is running on this vault, often a manual run beside the service. A lock left by a dead process is reclaimed on its own. |
| Member commands hang or fail on `members.json.lock` | A membership change was interrupted. Stop the service and any `bigbrain-shared` commands, remove the empty `members.json.lock` directory, then start again. |
| exe.dev asks visitors to log in | The VM's HTTPS URL is still private: `ssh exe.dev share set-public <vm>` (step 4). |
| Every path is 401, even `/.well-known/…` | The connector is off: no public URL in the unit. |
| Claude says it cannot connect | The proxy or firewall blocks Anthropic's range, or answers slowly (Claude allows 10 seconds). |
| `"google":false` though the env file is set | The unit has no `EnvironmentFile=` line, or the file is not where it points. With only one half set, the server refuses to start and says so. |
