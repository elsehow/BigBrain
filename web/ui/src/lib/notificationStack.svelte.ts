import type { Snippet } from 'svelte';

export interface StackNotice {
  id: string;
  title: string;
  kind: 'capture' | 'agent';
  children: Snippet;
  status?: Snippet;
  hasInput?: boolean;
  onopen?: () => void | Promise<void>;
  onclear: () => void | Promise<void>;
}

// Both producers register the same presentation type. Uploads and agent state
// remain with their owners; this registry owns only their visible notices.
export const notificationStack = $state({ items: [] as StackNotice[] });
export const notificationKeyboard = { handle: (_event: KeyboardEvent): boolean => false };
export function registerNotice(notice: StackNotice): () => void {
  notificationStack.items = [notice, ...notificationStack.items];
  return () => { notificationStack.items = notificationStack.items.filter(item => item.id !== notice.id); };
}
