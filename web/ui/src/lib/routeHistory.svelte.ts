/** Note-browser history only; agent navigation belongs to the agent roster. */
export const routeHistory = $state({ back: false, forward: false });
let index = 0, ready = false;
let entries: string[] = [];
const content = (hash: string) => /^#\/vault\/.+$/.test(hash);
function target(direction: 'back' | 'forward') {
  const step = direction === 'back' ? -1 : 1;
  for (let i = index + step; i >= 0 && i < entries.length; i += step) {
    if (content(entries[i]!) && entries[i] !== entries[index]) return i;
  }
  return -1;
}
function paint() { routeHistory.back = target('back') >= 0; routeHistory.forward = target('forward') >= 0; }
export function syncRouteHistory() {
  const entry = history.state?.bigbrainRoute;
  if (typeof entry === 'number' && entries[entry] === location.hash) index = entry;
  else { index = 0; entries = [location.hash]; history.replaceState({ ...history.state, bigbrainRoute: index }, ''); }
  paint();
}
export function initRouteHistory() {
  if (ready) return;
  ready = true;
  // A reload has no trustworthy in-memory destinations, even if state has an old index.
  entries = [location.hash]; index = 0;
  history.replaceState({ ...history.state, bigbrainRoute: index }, ''); paint();
  addEventListener('popstate', syncRouteHistory);
}
export function navigateHistory(direction: 'back' | 'forward') {
  const next = target(direction);
  if (next >= 0) history.go(next - index);
}
export function pushRoute(hash: string) {
  initRouteHistory();
  if (location.hash === hash) return;
  entries = entries.slice(0, ++index); entries.push(hash);
  history.pushState({ bigbrainRoute: index }, '', hash); paint();
}
export function replaceRoute(hash: string) {
  initRouteHistory(); entries[index] = hash;
  history.replaceState({ ...history.state, bigbrainRoute: index }, '', hash); paint();
}
