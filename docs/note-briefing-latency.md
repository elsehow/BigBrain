# Note briefing latency — 2026-09-13

These measurements separate input preparation, model delivery, and browser
rendering. Model comparisons use the same entirely fabricated Atlas tool-library
and Maya coordinator notes, five described links, and the configured local
provider integrations. Three sequential requests per condition are diagnostic
samples, not production percentiles or a guarantee for large notes.

## Model measurements

Times below measure client-observed call start to the final response, excluding
UI debounce and input preparation. All prompts request short link descriptions
except the first row.

| Provider path | Final response, seconds (three runs) |
| --- | --- |
| Haiku, cold client, longer descriptions | 4.35 / 3.28 / 3.29 |
| Haiku, cold client, short descriptions | 3.76 / 2.58 / 2.93 |
| Haiku, prepared client, short descriptions | 2.72 / 2.04 / 2.48 |
| Codex Spark, low reasoning | 3.31 / 5.17 / 5.13 |
| Codex Luna, low reasoning | 10.07 / 10.99 / 8.86 |

For prepared Haiku calls, client initialization took 34–38 ms. First text arrived
at 637–959 ms; the first usable summary text arrived at 947–983 ms. Initial
chunks sometimes contain only JSON syntax. Descriptions mostly used 3–7 words,
versus roughly 8–16 with the earlier prompt. The UI adds a 150 ms debounce for
fresh work and local input preparation; a warm synthetic first summary therefore
appears around 1.1 seconds after a settled click, while the rest finishes later.

Most of that remaining first-text delay lies between submitting the turn and
receiving model text: network transit, remote queuing, prompt processing, initial
generation, and SDK/service buffering. Client measurements cannot separate these
stages. The SDK's reported API-duration field sometimes exceeded wall time, so
it is not used to subtract or add stages. Codex measurements use its integration,
not direct OpenAI Responses API requests; they do not establish an inherent
provider-wide speed difference. Haiku remains the default on this evidence.

Streaming addresses the wait for the whole JSON response. Preparing a one-use
client removes local process initialization from the click path; neither makes
remote generation instantaneous. See OpenAI's [latency guidance](https://developers.openai.com/api/docs/guides/latency-optimization)
for the distinction between token-generation cost and streaming perceived latency.

## Local preparation

Local-only profiling used a disposable snapshot with 12,717 files, 3,983 graph
nodes, and 11,266 edges. No snapshot content was sent to a model for these runs.

- Cold input preparation fell from roughly 5.9–6.4 seconds to 3.18 seconds.
- Cached input preparation plus complete input hashing took about 28–36 ms.
- Prompt construction took less than 0.5 ms.
- Optimized Markdown extraction produced exactly the same graph and sorted
  connection-evidence hashes as the original implementation across the snapshot.

The original Markdown scanner repeatedly searched large source transcripts for
inline/reference links and paragraph boundaries. Restricting those scans and
reusing graph-read logs for entity lookup reduced cold work. A healthy watcher
now keeps the memo alive until a real change instead of forcing a rebuild every
60 seconds. Actual vault changes still invalidate it; watcher failure restores
the TTL fallback and database/WAL changes independently invalidate the graph.

## Cached navigation

Previously every click erased the briefing, waited for debounce, then performed
an HTTP request and local cache validation. The browser had no briefing cache.
Completed views now render synchronously from memory/session storage, with server
revalidation in the background. Browser regression coverage delays the server
response by 1.5 seconds and requires the full cached summary and described links
to be present within two animation frames, before the 150 ms debounce elapses.
This assertion checks user-visible behavior rather than a cache helper alone.
The final Chrome run measured 20.1 ms for that cached repaint despite the
1,500 ms response delay. This is a small browser fixture, not a large-vault
rendering benchmark.

## Reproducing the model check

After expanding to ten described links total, a same-fixture comparison used
three prepared Haiku calls per limit. The note text was identical; the shortlist
contained five or ten links. Complete-response medians were 2.93 seconds for five
and 3.63 seconds for ten (about 0.70 seconds longer). First usable summary medians
were 1.44 and 1.61 seconds, with wide ranges of 0.74–2.18 and 0.69–1.68 seconds.
These small samples illustrate the tradeoff and remote variability, not a latency
guarantee. Ten-link responses used 273–298 output tokens and all passed validation.
The total evidence-text cap remains about 15,000 characters; the output ceiling
is 1,400 tokens. Browser cached revisits still rendered within two frames (31.1 ms
in the final fabricated-scene run) while revalidation was delayed 1.5 seconds.

The earlier measurements above used the original five-link fixture. The current
script expands the fabricated neighborhood and defaults to ten described links;
append `5` or `10` to compare both limits using the same note text.

Run `bun test/support/profileNoteBriefing.ts claude haiku warm` for prepared
clients, omit `warm` for cold clients, or use `codex gpt-5.3-codex-spark` /
`codex gpt-5.6-luna` for the Codex path. This optional script creates and deletes
its own fabricated vault. It makes three actual model calls using the configured
local authentication and prints timing and word counts. It never reads a user
vault and is not run by the unit test suite.

The memory-context follow-up keeps selected-note text plus memory excerpts
within the same 16,000-character cap (at most three memories / 3,000 characters).
The final prompt has no entity preference and still requests one short summary
sentence and ten descriptions. Three fabricated Haiku runs with one inbound
memory finished in 3.08–3.29 seconds, with first summary text at 0.94–1.61 seconds.
All outputs passed link/evidence validation. These are fresh samples, not a
controlled speed comparison; the fixture now includes explicit memory backlinks.
The corresponding fabricated browser check painted a cached revisit in 9.0 ms
while revalidation was delayed 1.5 seconds.
