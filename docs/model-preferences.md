# Model preferences

Gardener, Memory, Quick and Pilot use the same model choice:
`{ adapter, provider, model, reasoning }`. Pi requires an explicit provider
(e.g. `openai` for API billing or `openai-codex` for ChatGPT). Claude uses the
official Claude runtime; the vault's `auth` setting selects authentication for
background jobs. Execution metadata records the runtime's observed billing.

`lib/manifest.ts` alone reads vault configuration. Old `agent` choices,
including `agent: pi` without a provider and `agent: codex`, normalize to Pi
with `openai-codex`. Reading never rewrites a vault. A settings edit writes the
canonical choice for that role, preserving unrelated YAML. Missing providers
on new Pi choices are errors. Memory trims and entity-fold proposals carry
Memory's complete choice through to dispatch.

## Selection policy

Every role has an independent policy in Settings > Models:

- **Keep this selection** (`pinned`): preserve the choice through connection
  changes, disconnections, reconnections and restarts. Selecting a model or
  reasoning level pins it, regardless of provider or billing.
- **Follow recommendations** (`recommended`): apply the current eligible
  subscription recommendation and refresh on provider connection changes.
  Recommendations never introduce an API-billed fallback.

The three background roles store `preference` beside their choice in
`vault.yaml`. Pilot stores `BIGBRAIN_PILOT_MODEL_PREFERENCE` beside its default
backend in `.env`. Existing choices without a policy have unknown intent and
are treated as pinned. Unconfigured roles start recommended. No migration or
provider-set marker is needed. Existing Pilot conversations retain their backend.

Discovery endpoints are read-only. Failed discovery or no eligible subscription
preserves the last selection. Switching to recommended with no eligible choice
returns an actionable error without changing policy. Recommendations reset
reasoning to the selected model's recommended level.

`lib/model-defaults.yaml` owns recommendations. With both subscriptions, the
current defaults are Astra/medium for Gardener, the newest Opus (Opus 5.5) for
Pilot, Opus/default for Memory, and Haiku/default for Quick. With Claude alone,
Gardener uses the newest Sonnet (Sonnet 5.5, bundled from Pi 0.99.2) and Pilot
uses the newest Opus. Gardener's provider preference and its Claude model come
from comparative evaluations; the other rankings are product defaults.

Claude Gardener evaluation, 2026-10-01: an offline replay re-filed about 500
insertions per model through the production gardener (`runTend`, Pi, the tend/v3
prompt). On 52 agent name-lookup searches judged blind by an LLM, results built
from Sonnet 5.5's assertions scored -0.06 against the existing assertions (95% CI
-0.33 to +0.21); Haiku 4.5 scored -0.25 (-0.45 to -0.04) and was rejected.
API-equivalent cost per insertion: Sonnet 5.5 about $0.066, Opus 5 on the current
prompt about $0.37, Haiku 4.5 about $0.025. Sonnet 5.5 writes about 1.5 assertions
per insertion where the existing record has 4.5. Only search results were judged,
not full-dossier reading. Astra and Sonnet 5.5 were not compared, so the provider
order is unchanged.

## Eligibility and execution

All four pickers consume the same catalog and `ModelControls`. Menus list only
the newest model of each family per provider (`latestModels`); a saved older
choice stays listed, and discovery and execution still see every model. Role requirements
live in `lib/modelChoice.ts`. `lib/modelResolution.ts` applies the same capability
and reasoning policy to menu discovery and live execution. Gardener and Memory
need tools, Pilot needs tools and streaming, and Quick needs validated structured
output and an enforceable spending limit. These are runtime guarantees, not
model quality ratings. Provider and model restrictions may narrow capabilities;
they cannot promise features the runtime cannot enforce.

Pi API jobs cannot enforce a dollar ceiling, so Quick excludes them and explains
why. Execution rechecks availability and requirements before dispatch. Background
API selections show a billing note. There is no automatic provider fallback.

Resolved execution facts supply provider, adapter, model and transport to run
monitoring and journals. A shared builder assigns engine and sampling labels,
including `pi-defaults` for Pi Gardener runs. Failed pre-dispatch attempts retain
the requested identity; historical journal labels remain readable.

Pilot realtime voice remains a separate transport. The existing Responses Pilot
backend remains readable and runnable; new background API choices use Pi.

## Provider settings

Runner settings use one provider descriptor and one `RunnerProviderSettings`
card for Codex and Claude Code. Installation, configuration, checks, launch
settings, permissions, errors and vault access share presentation. Descriptors
expose supported controls: Claude Code's permission mode remains Claude-specific,
while Codex follows its native approval and sandbox settings. Provider labels are
shared with Models and connected clients. Authentication and native configuration
remain owned by the relevant provider; vault authorization remains separate from
model sign-in and recent connection activity.
