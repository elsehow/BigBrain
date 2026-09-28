import { expect, test } from "bun:test";
import { edgeContrast } from "../web/ui/src/lib/graphEdgeContrast";

const luminance = (rgb: number[]) => rgb.reduce((sum, c, i) => sum + (c / 255 <= .04045 ? c / 255 / 12.92 : ((c / 255 + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i]!, 0);
test("edge contrast reaches the same target across arbitrary palette colors", () => {
  for (const background of [[255,255,255], [0,0,0], [35,30,210], [200,110,155], [124,150,90]]) {
    for (const foreground of [[255,255,255], [30,25,20], background]) {
      const {color, opacity} = edgeContrast(foreground, background);
      const mixed = color.map((c, i) => background[i]! + (c - background[i]!) * opacity);
      const a = luminance(mixed), b = luminance(background);
      expect((Math.max(a,b)+.05)/(Math.min(a,b)+.05)).toBeCloseTo(1.8, 5);
      expect(opacity).toBeGreaterThan(0);
      expect(opacity).toBeLessThanOrEqual(1);
    }
  }
});
test("usable theme foreground is preserved; indistinguishable ink gets a readable fallback", () => {
  expect(edgeContrast([240,240,240], [20,20,20]).color).toEqual([240,240,240]);
  expect(edgeContrast([250,250,250], [255,255,255]).color).toEqual([0,0,0]);
});
