import { eventLog } from './eventLog';
export interface ContributionTransition {
  event: 'shared.contribution'; id: string; contribution_id: string; member_id: string;
  source_id: string; status: 'withdrawn' | 'active'; version: number; request_id: string;
  created_at: string; credential_id: string;
}
export const contributionLog = eventLog<ContributionTransition>({
  name: 'shared-contribution', dir: 'log/shared-contributions', when: e=>e.created_at,
  validate(e) {
    if(e.event!=='shared.contribution'||!/^sct_[a-f0-9]{24}$/.test(e.id)||!/^sc_[a-f0-9]{24}$/.test(e.contribution_id)||!e.member_id||!e.source_id||!['active','withdrawn'].includes(e.status)||!Number.isSafeInteger(e.version)||e.version<1||!e.request_id||!e.credential_id||!Number.isFinite(Date.parse(e.created_at)))throw Error('Invalid contribution transition');
  }
});
