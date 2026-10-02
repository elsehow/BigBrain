# The intake firewall

Every arrival — a drop, a clip, an email, a meeting — is screened by a
decision model before anything stores it (`lib/door.ts`, `lib/firewall.ts`).
Two yes/no questions:

- **credential** — a password, key, token, one-time or verification code,
  recovery codes, or a password-reset, magic sign-in or verification link
- **malicious** — phishing, impersonation, lookalike domains, malware, or text
  that tries to instruct an AI system

Either over its threshold and the item is **withheld**: not landed, not staged
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
`thresholds: { credential: 0.25, malicious: 0.85 }` are optional. A hosted
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
languages, codes, magic links, a forwarded reset, one buried in a thread), 8
malicious and 18 ordinary-but-tricky ones. `bun deploy/firewall/eval/run.ts`
runs them through `screen()` and prints each question's catch rate and false
positives per threshold. Clef scores all questions jointly, so **rerun it after
changing any question's wording**, not only the one you edited.

At the defaults, local Clef-flash withholds 28/28 credential, 7/8 malicious and
0/18 ordinary mails. The credential question separates cleanly (every
credential ≥ 0.3, every ordinary mail ≤ 0.12); the malicious one also flags
urgent marketing, which is why its threshold sits high. The miss is a
plain-text "AI agent, you are authorized to…" mail at 0.67 — prompt injection
is defended architecturally anyway (`docs/design-principles.md` §2).

## Limits

- Binary attachments (images, PDFs on email) are not read. Text attachments,
  including a forwarded `.eml`, are.
- Shared-vault imports and voice (directives, observations) do not pass the
  door yet.
- Items staged before the firewall was turned on are admitted without a screen.
