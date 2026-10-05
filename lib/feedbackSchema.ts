/** Shared, content-free UI context. Never pass application state wholesale. */
export const FEEDBACK_LIMIT = 4000;
export const FEEDBACK_PANELS = ['home', 'document', 'conversation', 'search', 'recents', 'settings', 'graph', 'field', 'other'] as const;
export type FeedbackPanel = typeof FEEDBACK_PANELS[number];
export interface FeedbackInput {
  id: string;
  message: string;
  panel: FeedbackPanel;
  layout: 'standard' | 'expanded';
  version: string;
}
