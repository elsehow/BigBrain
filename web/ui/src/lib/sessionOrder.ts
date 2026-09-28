/** One creation order for every list and overlay built from sessions.
 *
 * The live arrays are reordered by activity — an accepted update moves a
 * conversation, a worker's report re-sorts by recency — and the graph must
 * never inherit that. Node order IS the identity of the GPU buffers
 * (`graphGeometryKey`, and `update()` writes status by index), so a reshuffle
 * rebuilds the whole picture and reframes the camera. Creation order is stable
 * for the life of a session; the id only breaks ties. */
export const bySessionOrder = <T extends { id: string; created: string }>(a: T, b: T): number =>
  a.created.localeCompare(b.created) || a.id.localeCompare(b.id);

export const inSessionOrder = <T extends { id: string; created: string }>(sessions: readonly T[]): T[] =>
  [...sessions].sort(bySessionOrder);
