# The intake firewall

Every arrival — a drop, a clip, an email, a meeting — is screened by a
decision model before anything stores it (`lib/door.ts`, `lib/firewall.ts`).
One yes/no question: does it carry a **credential** — a password, key, token,
one-time or verification code, recovery codes, or a password-reset, magic
sign-in or verification link?

Over the threshold and the item is **withheld**: not landed, not staged
for the gardener, never read by any agent. One line goes to
`.spool/firewall/withheld.jsonl` — source, sender, date, reason, scores; never
the subject or body — so a false positive is visible.

The threat it exists for: an agent that can request a password reset and then
read the link out of the vault owns the account. So it fails **closed**: if the
endpoint is down nothing gets in — a drop is refused (HTTP 503), a poller leaves
the item at its source and retries next tick.

## Turning it on

Add to the vault's `vault.yaml`:

```yaml
firewall:
  url: http://127.0.0.1:4750/v1/systemone
```

Absent means off. `model` (default `clef-flash`) and
`thresholds: { credential: 0.15 }` are optional. A hosted
endpoint's bearer token goes in `BIGBRAIN_FIREWALL_TOKEN`.

The endpoint speaks the Jev/SystemOne `POST /v1/systemone` API, so it can be a
hosted Jev or Clef, or the local server here.

## The local server (Apple silicon)

[Clef-flash](https://huggingface.co/Cloudflare/clef-flash) (Apache-2.0) — a
Qwen3.5-9B backbone plus a small joint schema head. `clef_server.py` runs the
backbone 8-bit in MLX and the head in torch, on `127.0.0.1` only. It loads on
the first request (~5 s) and unloads after 10 idle minutes, so it holds ~9 GB
only while it is screening. Roughly 1–4 s an item.

```sh
deploy/firewall/setup.sh            # once: ~19 GB download → ~10 GB model dir
~/.local/share/bigbrain/clef-flash/.venv/bin/python deploy/firewall/clef_server.py
curl -s 127.0.0.1:4750/health
```

Needs ~16 GB of unified memory or more (measured on 24 GB). It must be running whenever the vault
ingests — otherwise intake waits.

## Tuning

`eval/fixtures.json` is an invented set: 28 credential mails (resets in five
languages, codes, magic links, a forwarded reset, one buried in a thread) and
18 ordinary-but-tricky ones (a reset help article, a password-changed notice,
tracking numbers, commit hashes). `bun deploy/firewall/eval/run.ts` runs them
through `screen()` and prints the catch rate and false positives per threshold.
Rerun it after changing the question's wording — or after adding a question:
Clef scores a request's questions jointly, so a second question shifts the
first one's scores.

At the default threshold (0.15), local Clef-flash withholds 28/28 credential
mails and 0/18 ordinary ones: every credential mail scores ≥ 0.22, every
ordinary one ≤ 0.06. The weakest are an invitation's set-password link (0.22)
and a disable-2FA confirmation (0.25).

A second question — "is this malicious?" — was tried and removed: on real mail
it withheld genuine Wise payment notices, a brokerage agreement update and a
family member's app invitation (0.89–0.91) as readily as it caught phishing.

## Limits

- Binary attachments (images, PDFs on email) are not read. Text attachments,
  including a forwarded `.eml`, are.
- Shared-vault imports and voice (directives, observations) do not pass the
  door yet.
- Items staged before the firewall was turned on are admitted without a screen.
