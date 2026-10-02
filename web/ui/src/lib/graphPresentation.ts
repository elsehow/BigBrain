/** Approved graph defaults. Comparisons are available only in development. */
const preview = import.meta.env.DEV ? new URLSearchParams(location.search) : new URLSearchParams();
export const neighborhoodEnabled = preview.get('selectionSubgraph') !== '0';
export const selectionStyle = preview.get('selectionStyle') === 'radial' ? 'radial' : 'cloud';
export const composeSelection = preview.get('composition') !== 'plain';
export const continueSelection = preview.get('motion') !== 'independent';
export const stageSelection = preview.get('choreography') !== 'plain';
export const quietSidebar = preview.get('sidebarTone') !== 'original';
