# Provider accounting

All model roles, including workers, checkpoint observations through
`monitoredSession` under `journal/model-runs/YYYY-MM/`. Records contain execution
identity, lifecycle, session/parent IDs, and reported usage; never prompts, tool
payloads, account emails, or credentials. Failed/cancelled runs retain received
usage. Missing counts stay unknown; partial totals are lower bounds.

Pi observations come from each request stream's terminal result, including error,
abort, and compaction results. Duplicate request IDs replace counts. Reports cover
runs started in the last seven days; they do not attribute all account activity.
Historical native-client usage and quota records remain readable.

Quota windows are independent provider observations. Both readers use the exact
Pi OAuth token used for inference, never native-client credentials. ChatGPT reads
`https://chatgpt.com/backend-api/wham/usage`, matching the response schema in
[OpenAI's backend client](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs).
Claude reads `https://api.anthropic.com/api/oauth/profile` for account identity and
`https://api.anthropic.com/api/oauth/usage` for windows. These compatibility
endpoints were checked on 2026-09-26; they are not a promise of stable public APIs.

Account IDs are hashed before journaling. Every observation keeps its identity,
measurement timestamp, and reset time. Mixed/unknown identities suppress the
combined quota display; changing accounts never relabels old readings. There is
no token-to-quota conversion or estimated BigBrain share.

HTTP requests forbid redirects, limit bodies to 64 KiB, and time out after two
seconds per request. Claude profile responses cache for five minutes and usage
for one minute, including failures; cached readings retain their original timestamp.
Tokens are not persisted by these readers. Pi owns authentication and refresh.
Failure or cancellation leaves quota unavailable without changing model work's
result. Quota is sampled around model work, not continuously polled.

Tests use synthetic tokens and HTTP fixtures. The no-native-CLI smoke test verifies
that setup, discovery, diagnostics, all model roles, workers, and restart work with
failing `claude` and `codex` executables on PATH.
