# Vaults settings study

Open `/vaults-workbench.html` on the Vite development server. This is a component
workbench using the production SettingsPage, SettingsRail, settings list styles,
type, tokens and tooltips. It is not a full-app preview or a connected vault.
Baseline: continuing shared-vault experiment c036939, based on main 9686f88.
Vite's provenance badge reports current divergence from cached origin/main.

The settings sidebar lists one writable shared vault and one read-only
vault under SHARED VAULTS. Personal is not an entry in this section. Selecting a vault shows only its settings in the main panel.
Connect vault adds another sidebar entry. This navigates settings; it does not
switch the app’s reading context.
Each writable shared vault can have one inclusion rule and has a separate Added by you tab.
With no rule, Add rule opens a draft editor. Drafts can be tested before saving;
Cancel discards edits. Save and enable creates an active rule: there is no
separate disabled state. A saved rule shows its text, Edit rule and Remove rule.
Test rule, its date range and matching results appear only while adding or
editing a rule. The saved view shows the rule and its Edit/Remove actions, with a collapsed
Recently added by this rule disclosure showing up to five rule contributions.
Manual contributions appear only in the complete Added by you history.
Removing it stops future inclusion without removing past contributions. Editing
preserves the saved rule until Save changes is pressed. Test rule displays historical matches directly below
it without contributing anything. All time is selected by default and disables
the Added since date picker. Turning it off filters on the date a source was
added to Personal (inclusive), not its publication date. This range applies only
to the historical test. Editing the rule or range clears stale test results.
The saved rule automatically includes future matches; testing/importing
historical matches is a separate explicit action. Imports keep personal originals and remove contributed items from
future sample import selections. History includes manual and rule contributions.
Rule editing, connecting a vault, testing, selection, import, history and source preview
are simulated in memory; reload resets everything. Editing prose does not run a
classifier: sample matches remain fabricated. No credentials or source content
are sent to a server by the study. Connect opens an in-theme modal with only an invite link. Redemption is simulated;
the fixed sample remote response supplies the name Research group. Escape, Cancel
and backdrop dismissal close the modal. No pasted link is fetched.

## Jev assessment — 2026-09-29

Jev is a plausible optional evaluator for natural-language inclusion rules.
A Noul evaluates a yes/no proposition and returns its estimated probability.
Give it one candidate source as state, then ask separate questions for applicable
semantic inclusion/exclusion conditions. Multiple questions can share a request.
Keep deterministic conditions (source type, date, explicit labels), read/write
permissions, destination, duplicate detection and publication in BigBrain code.
Use the identical evaluator for historical imports and future sources.

Suggested boundary:

1. Local code selects eligible personal sources and applies deterministic limits.
2. Evaluate semantic conditions against the source text and necessary metadata.
3. Code combines the answers. Ambiguous decisions remain for review; failed calls
   leave the source personal and retry without publishing.
4. The user's historical selection or enabled future rule authorizes contribution.
5. Recheck rule version, permissions, source revision and destination before write.
6. Record source ID/version, rule version, model version and destination receipt.

Noul probability is not a correctness guarantee and has no separate confidence
field. Choice/Score confidence measures concentration of the returned probability
distribution. Tune thresholds on labeled examples, including near misses,
private conversations, mixed-topic documents, and instruction-bearing source text.
Pin the model version when calibrating. We have not benchmarked or called Jev.

Jev does not generate prose: retain a generative model for drafting assertions or
explaining a proposed rule. Its documented limitations include literal readings,
large irrelevant contexts and adversarial inputs. It must not be the sole guard
against unintended disclosure. API-based evaluation also sends the evaluated
source text to TypeSafe; make provider selection explicit, with a separate key.
The docs state customer inputs/outputs are not training data, and describe
enterprise zero-retention options; that does not imply default zero retention.

The current model page lists jev-1.13.0 at $0.042 per million input tokens, free
output tokens, 64k total request tokens and 32k for state plus longest question.
At that listed price, 10,000 sources averaging 2,000 input tokens cost about $0.84
before question tokens, retries and any preprocessing. This is an arithmetic
estimate, not measured throughput or a quoted project price.

Primary sources:
- https://docs.typesafe.ai/introduction
- https://docs.typesafe.ai/primitives/noul
- https://docs.typesafe.ai/confidence
- https://docs.typesafe.ai/models
- https://docs.typesafe.ai/model-jaggedness/jev-1.13
- https://docs.typesafe.ai/legal

## Withdrawal study

History and recent rule contributions offer Withdraw / Restore on the signed-in
sample member's contributions. Withdrawn rows remain in history, are omitted
from import selections, and show that restoration is explicit. One sample has
another contributor (Mara), whose contribution remains. These are in-memory
states and illustrative identities, not authentication enforcement. See
[implementation plan](../plans/shared-source-withdrawal.md) for server identity,
permissions, replay and inclusion-worker changes.
