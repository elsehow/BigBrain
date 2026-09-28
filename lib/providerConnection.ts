/** Model authentication is independent of optional vault-plugin credentials. */
export interface ClaudeConnectionState {
  claude: { installed: string | false; account: string | null; connected?: boolean };
  /** Compatibility with setup responses from older engines. */
  agent?: { revoked: string | null } | null;
}
export function claudeProviderConnected(state: ClaudeConnectionState): boolean {
  return !!state.claude.installed && state.claude.account !== null &&
    (state.claude.connected ?? (!!state.agent && state.agent.revoked === null));
}

/** Public subscription connection state shared by engine and UI. */
export interface SubscriptionStatus {
  connected: boolean;
  phase: "idle" | "starting" | "browser" | "finishing" | "connected" | "error";
  url?: string;
  manualCode?: boolean;
  retrySetup?: boolean;
  problem?: string;
}
export const SUBSCRIPTION_PROVIDERS = {
  chatgpt: { label: "ChatGPT", providerId: "openai-codex", defaultProvider: "openai", connectedKey: "BIGBRAIN_CHATGPT_CONNECTED" },
  anthropic: { label: "Claude", providerId: "anthropic", defaultProvider: "anthropic", connectedKey: "BIGBRAIN_ANTHROPIC_CONNECTED" },
} as const;
export type SubscriptionProvider = keyof typeof SUBSCRIPTION_PROVIDERS;
