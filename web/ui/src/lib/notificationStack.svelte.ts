import type { Snippet } from 'svelte';

export interface StackNotice {
  id: string;
  title: string;
  kind: 'capture' | 'connection';
  children: Snippet;
  status?: Snippet;
  hasInput?: boolean;
  /** The fix, when the notice names one (Renew). */
  action?: { label: string; run: () => void | Promise<void> };
  onclear: () => void | Promise<void>;
}

// Every producer registers the same presentation type. Uploads and connections
// remain with their owners; this registry owns only their visible notices.
export const notificationStack = $state({ items: [] as StackNotice[] });
export function registerNotice(notice: StackNotice): () => void {
  notificationStack.items = [notice, ...notificationStack.items];
  return () => { notificationStack.items = notificationStack.items.filter(item => item.id !== notice.id); };
}
