# The intake firewall

Every arrival — a drop, a clip, an email, a meeting — is screened by Jev
(TypeSafe's SystemOne API) before anything stores it (`lib/door.ts`,
`lib/firewall.ts`). One yes/no question: does it carry a **credential** — a
password, key, token, one-time or verification code, recovery codes, or a
password-reset, magic sign-in or verification link?

Over the threshold and the item is **withheld**: not landed, not staged
for the gardener, never read by any agent. One line goes to
`.spool/firewall/withheld.jsonl` — source, sender, date, reason, scores; never
the subject or body — so a false positive is visible.

The threat it exists for: an agent that can request a password reset and then
read the link out of the vault owns the account. So it fails **closed**: if
Jev cannot answer (unreachable, an error, out of credits), nothing gets in — a
drop is refused (HTTP 503), a poller leaves the item at its source and retries
next tick.

## On and off

The firewall uses the one Jev key this machine keeps (`lib/jevSettings.ts`,
entered in the app's model settings). Nothing ships with the app and nothing
is downloaded: there is no local model and no second process.

- **A Jev key is set:** on by default.
- **No Jev key:** off. The switch in settings → security stays off.
- **Turned off with a key set:** stays off. The choice is `vault.yaml`'s
  `security.firewall` (`true` / `false`); absent means the default above.

It is decided per arrival, so a key added before an integration's first poll
screens that poll.

A vault from before this still carries the retired local-model block
(`firewall: { model: clef-flash }`, perhaps a `url` or `thresholds`). It is
not read: such a vault loads as before, and the firewall follows the Jev key
like any other vault's.

## Tuning

`eval/fixtures.json` is an invented set: 28 credential mails (resets in five
languages, codes, magic links, a forwarded reset, one buried in a thread) and
18 ordinary-but-tricky ones (a reset help article, a password-changed notice,
tracking numbers, commit hashes). `bun deploy/firewall/eval/run.ts` runs them
through `screen()` against Jev with this machine's Jev key and prints the
catch rate and false positives per threshold (`[url]` points the same request
at a stand-in). Rerun it after changing the question's wording, or after
adding a question: a model may score a request's questions jointly, so a
second question can shift the first one's scores.

The threshold (0.4, `FIREWALL_THRESHOLD`) sits just under the weakest
credential mail on Jev (2026-10-06: every credential fixture ≥ 0.42, every
ordinary one ≤ 0.09). The earlier 0.15, tuned on the retired local model,
withheld ordinary browser clips scoring 0.20–0.24. At 0.5 one fixture
(`reset-html-only-no-url`, 0.42) would slip through.

Long items are screened in 8000-character windows, the worst window
deciding; a window Jev refuses as too large is halved and asked again.

A second question — "is this malicious?" — was tried and removed: on real mail
it withheld genuine payment notices, a brokerage agreement update and a family
member's app invitation (0.89–0.91) as readily as it caught phishing. Prompt
injection is defended architecturally anyway (`docs/design-principles.md` §2).

## Limits

- Binary attachments (images, PDFs on email) are not read. Text attachments,
  including a forwarded `.eml`, are.
- Shared-vault imports and voice (directives, observations) do not pass the
  door yet.
- Items staged before the firewall was turned on are admitted without a screen.
