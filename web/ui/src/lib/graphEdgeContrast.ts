/** Theme-independent edge ink, calibrated against the actual sRGB ground.
 * This is a visual hierarchy target for full-strength edges, not text contrast.
 * Salience and depth still soften background relationships afterward. */
export function edgeContrast(foreground: readonly number[], background: readonly number[], target = 1.8) {
  const luminance = (rgb: readonly number[]) => rgb.reduce((sum, channel, i) => {
    const c = channel / 255;
    return sum + (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]!;
 }, 0);
  const ground = luminance(background);
  const contrast = (rgb: readonly number[]) => {
    const light = luminance(rgb);
    return (Math.max(light, ground) + 0.05) / (Math.min(light, ground) + 0.05);
  };
  // A low-contrast custom mark cannot become legible through opacity alone.
  const color = contrast(foreground) >= target ? [...foreground]
    : contrast([0, 0, 0]) > contrast([255, 255, 255]) ? [0, 0, 0] : [255, 255, 255];
  let low = 0, high = 1;
  for (let i = 0; i < 24; i++) {
    const alpha = (low + high) / 2;
    const mixed = background.map((c, i) => c + (color[i]! - c) * alpha);
    if (contrast(mixed) < target) low = alpha; else high = alpha;
  }
  return { color, opacity: high };
}
