// Whether the field draws every source at rest, beside the entities they
// mention. Off (the default), a source shows only while it's in hand.
const KEY = "bigbrain.show-graph-sources";
function stored(): boolean {
  try { return localStorage.getItem(KEY) === "on"; } catch { return false; }
}

export const graphSources = $state({ show: stored() });
export function setGraphSources(show: boolean): void {
  graphSources.show = show;
  try { localStorage.setItem(KEY, show ? "on" : "off"); } catch { /* Keep the choice for this window. */ }
}
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key === KEY || event.key === null) graphSources.show = stored();
});
