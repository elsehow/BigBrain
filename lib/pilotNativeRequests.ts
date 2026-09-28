/** Historical native-request record; new Pilots never broker approvals. */
export interface PilotNativeRequest {
  id: string; method: string; threadId: string; turnId: string; itemId: string;
  kind: 'command' | 'files' | 'permissions' | 'question';
  reason: string; detail: string;
  questions?: { id: string; question: string; options?: { label: string; description?: string }[]; isSecret?: boolean }[];
  canAccept: boolean;
}
