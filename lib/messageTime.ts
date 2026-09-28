/** Conversation recency excludes drafts, renames, tool activity, and lifecycle updates. */
export function lastMessageAt(session: {
  messages?: readonly { role: string; at: string }[];
  lastMessageAt?: string;
}): string | undefined {
  let latest = session.lastMessageAt;
  for (const message of session.messages ?? []) {
    if (!["user", "assistant", "agent"].includes(message.role) || !Number.isFinite(Date.parse(message.at))) continue;
    if (!latest || Date.parse(message.at) > Date.parse(latest)) latest = message.at;
  }
  return latest;
}
