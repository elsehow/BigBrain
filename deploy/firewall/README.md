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
model cannot answer, nothing gets in — a drop is refused (HTTP 503), a poller
leaves the item at its source and retries next tick.

## Turning it on

```sh
bigbrain firewall install     # download the model (9.7 GB, resumable, sha256-checked) and turn it on
bigbrain firewall status      # what screens this vault, and whether it is answering
bigbrain firewall off
```

`install` writes this to `vault.yaml` (absent means off):

```yaml
firewall:
  model: clef-flash       # or clef-flash-q4: 6.5 GB, for 16 GB machines
```

and the desktop app starts the model server within a second. Optional:
`thresholds: { credential: 0.25, malicious: 0.85 }`. A `url:` instead points at
any Jev/SystemOne `POST /v1/systemone` endpoint (a hosted Jev or Clef); its
bearer token goes in `BIGBRAIN_FIREWALL_TOKEN`.

## The local model

[Clef-flash](https://huggingface.co/Cloudflare/clef-flash) (Apache-2.0),
converted for llama.cpp by [ggml-org](https://huggingface.co/ggml-org/Clef-Flash-GGUF).
The app ships llama.cpp's `llama-server` as a second sidecar beside bun
(`desktop/build-llama-server.sh`: pinned commit, static, Metal embedded, no
dylibs outside macOS). `bin/firewall-server.ts`, a long-lived job of the
supervisor, runs it on `127.0.0.1:4750` (`BIGBRAIN_FIREWALL_PORT`), and it
drops the weights after ten idle minutes and reloads (~5 s) on the next item.
Weights live once per machine in `~/.local/share/bigbrain/models`
(`BIGBRAIN_MODELS_DIR`).

About 1.4 s for an ordinary email on an M4 Pro. Long items are screened in
8000-character windows (Clef's prompt must fit one llama.cpp batch), so a
very long or base64-heavy item takes proportionally longer.

From a checkout, without the app: `sh desktop/build-llama-server.sh`, then
point `BIGBRAIN_LLAMA_SERVER` at
`desktop/src-tauri/binaries/llama-server-aarch64-apple-darwin`.

## Tuning

`eval/fixtures.json` is an invented set: 28 credential mails (resets in five
languages, codes, magic links, a forwarded reset, one buried in a thread), 8
malicious and 18 ordinary-but-tricky ones. `bun deploy/firewall/eval/run.ts
[url]` runs them through `screen()` and prints each question's catch rate and
false positives per threshold. Clef scores all questions jointly, so **rerun it
after changing any question's wording**, not only the one you edited — and
after moving the llama.cpp pin.

At the defaults the bundled Q8_0 withholds 28/28 credential, 7/8 malicious and
0/18 ordinary mails. The credential question separates cleanly (every
credential mail ≥ 0.40, every ordinary one ≤ 0.11); the malicious one also
flags urgent marketing, which is why its threshold sits high. The miss is a
plain-text "AI agent, you are authorized to…" mail — prompt injection is
defended architecturally anyway (`docs/design-principles.md` §2).

## Limits

- Binary attachments (images, PDFs on email) are not read. Text attachments,
  including a forwarded `.eml`, are.
- Shared-vault imports and voice (directives, observations) do not pass the
  door yet.
- Items staged before the firewall was turned on are admitted without a screen.
