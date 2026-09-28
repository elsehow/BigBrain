import { GOLDEN, nodeRadius } from "../../../../lib/graphGeometry";
import { SELECTOR_RATIO } from "../../../../lib/pilotChatTypes";
import type { GraphNode } from "./types";

type Point = { x: number; y: number };
/** Reserve room for session selectors and their labels without moving the
 * settled vault. Only new sessions search for an open spot; existing positions stay fixed. */
export function createSessionSpacing() {
  const previous = new Map<string, Point>();
  return (nodes: readonly GraphNode[], positions: Point[], obstacles?: ReadonlySet<string>): Point[] => {
    const cell = 64;
    const grid = new Map<string, { position: Point; radius: number }[]>();
    // Historical transcripts also carry sessionId. Explicit layout anchors
    // distinguish the Pilot overlays that we place once.
    const transient = (n: GraphNode) => n.layoutAnchors !== undefined;
    const radius = (n: GraphNode) => transient(n) ? Math.max(28, nodeRadius(n.degree) * SELECTOR_RATIO + 8) : nodeRadius(n.degree) * SELECTOR_RATIO + 6;
    const insert = (position: Point, r: number) => {
      const key = `${Math.floor(position.x / cell)},${Math.floor(position.y / cell)}`;
      const bucket = grid.get(key) ?? []; bucket.push({ position, radius: r }); grid.set(key, bucket);
    };
    const free = (p: Point, r: number) => {
      const gx = Math.floor(p.x / cell), gy = Math.floor(p.y / cell);
      for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) {
        for (const other of grid.get(`${x},${y}`) ?? []) if (Math.hypot(p.x - other.position.x, p.y - other.position.y) < r + other.radius) return false;
      }
      return true;
    };
    const sessions: number[] = [];
    nodes.forEach((n, i) => { if (transient(n)) sessions.push(i); else if (!obstacles || obstacles.has(n.id)) insert(positions[i]!, radius(n)); });
    // Existing sessions get first claim; ordering from API responses is irrelevant.
    sessions.sort((a, b) => Number(previous.has(nodes[b]!.id)) - Number(previous.has(nodes[a]!.id)) || nodes[a]!.id.localeCompare(nodes[b]!.id));
    for (const i of sessions) {
      const n = nodes[i]!, origin = positions[i]!, saved = previous.get(n.id), r = radius(n);
      let position = { ...(saved ?? origin) };
      // An expanding sunflower search has no fixed displacement cap that could
      // leave coincident nodes unresolved in a crowded neighborhood.
      for (let attempt = 0; !saved && !free(position, r); attempt++) {
        const angle = attempt * GOLDEN, distance = 16 * Math.sqrt(attempt + 1);
        position = { x: origin.x + Math.cos(angle) * distance, y: origin.y + Math.sin(angle) * distance };
      }
      positions[i] = position; insert(position, r);
      previous.set(n.id, { ...position });
    }
    return positions;
  };
}
