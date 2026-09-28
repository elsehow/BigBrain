/** Display identity does not imply shared authentication or vault authorization. */
export const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude', anthropic: 'Claude', 'claude-code': 'Claude Code', codex: 'Codex', 'openai-codex': 'ChatGPT', openai: 'OpenAI',
};
export const providerLabel = (id: string): string => PROVIDER_LABELS[id] ?? id;
