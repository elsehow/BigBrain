/** A small label set, independent of graph size. Text stays cached on the GPU;
 * only placement is reconsidered as the camera moves. */
export interface LabelCandidate {
  key: string; index: number; x: number; y: number; width: number;
  gap: number; priority: number; opacity: number; above?: boolean;
}
export interface LabelBox extends LabelCandidate { left: number; top: number; height: number }
export function placeGraphLabels(candidates: LabelCandidate[], viewport: { width: number; height: number }) {
  const placed: LabelBox[] = [], height = 20, margin = 6;
  for (const label of [...candidates].sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key))) {
    if (placed.length >= 64) break;
    if (label.opacity < .05 || label.x < 0 || label.x > viewport.width || label.y < 0 || label.y > viewport.height) continue;
    const left = Math.max(margin, Math.min(viewport.width - label.width - margin, label.x - label.width / 2));
    const below = label.y + label.gap, above = label.y - label.gap - height;
    const positions = label.above ? [above, below] : [below, above];
    // Keep names near their own node. Low-priority labels yield when crowded.
    for (const top of positions) {
      if (left < margin || top < margin || top + height > viewport.height - margin) continue;
      if (placed.some(b => left < b.left + b.width + 4 && b.left < left + label.width + 4 && top < b.top + b.height + 4 && b.top < top + height + 4)) continue;
      placed.push({ ...label, left, top, height }); break;
    }
  }
  return placed;
}
