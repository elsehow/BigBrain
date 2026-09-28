# Integration capabilities

An integration delivers discussable source content and translates provider
identity into the arrival envelope. See [design principles](../docs/design-principles.md).

Sources can also have **live per-user unread state**. It is separate from
ingestion cursors, gardener filing, and whether an agent retrieved the content.
The provider is authoritative: reading a message elsewhere updates BigBrain,
and an explicit mark-read/unread operation in BigBrain writes to the provider.

Implement the shared `SourceReadStateAdapter` for integrations with this
capability. Gmail/IMAP is the first implementation. Do not freeze read flags into
source insertion events or invent local unread state when a provider's state
cannot be determined. See the [contract, API, and integration checklist](../docs/source-read-state.md).

Unread source state never creates a user notification by itself. Notifications
are an explicit Pilot action, independent of integration arrivals and worker
activity.
