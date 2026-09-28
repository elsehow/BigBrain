import { describe, expect, test } from "bun:test";
import { FIT_MAX, fitCamera, revealCamera, type Camera, type Room } from "../web/ui/src/lib/graph/framing";

const room: Room = { w: 1000, h: 800, top: 0, bottom: 0 };
const snug: Room = { w: 1000, h: 800, top: 100, bottom: 300 }; // a bar above, a drawer below
const box = { minX: -200, minY: -100, maxX: 200, maxY: 100 };
const at = (cam: Camera, wx: number, wy: number) => [wx * cam.scale + cam.tx, wy * cam.scale + cam.ty] as const;

describe("fitCamera", () => {
  test("the whole box lands in the room, centred, at 85% of the tighter side", () => {
    const cam = fitCamera(box, room);
    expect(cam.scale).toBeCloseTo(0.85 * Math.min(1000 / 400, 800 / 200)); // width binds
    expect(at(cam, 0, 0)).toEqual([500, 400]);
  });
  test("the room is what is left between the chrome: centred there, and sized to it", () => {
    const cam = fitCamera(box, snug);
    // 400 px of room between y=100 and y=500: the centre is 300
    expect(at(cam, 0, 0)).toEqual([500, 300]);
    expect(cam.scale).toBeCloseTo(0.85 * Math.min(1000 / 400, 400 / 200));
    // the box's top and bottom stay inside the room
    expect(at(cam, 0, -100)[1]).toBeGreaterThanOrEqual(100);
    expect(at(cam, 0, 100)[1]).toBeLessThanOrEqual(500);
  });
  test("a tiny picture is capped — three nodes are not three boulders", () => {
    expect(fitCamera({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, room).scale).toBe(FIT_MAX);
  });
  test("a degenerate box (one node) does not divide by zero", () => {
    const cam = fitCamera({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, room);
    expect(Number.isFinite(cam.tx) && Number.isFinite(cam.ty)).toBe(true);
    expect(at(cam, 5, 5)).toEqual([500, 400]);
  });
});

test("reveal pans only obscured axes, accounting for depth, without zooming", () => {
  const camera = { scale: 2, tx: 100, ty: 200 };
  const safe = { minX: 620, maxX: 1300, minY: 64, maxY: 900 };
  expect(revealCamera(camera, { x: 800, y: 400 }, safe)).toEqual(camera);
  expect(revealCamera(camera, { x: 500, y: 400 }, safe)).toEqual({ scale: 2, tx: 220, ty: 200 });
  expect(revealCamera(camera, { x: 1400, y: 920 }, safe, 2)).toEqual({ scale: 2, tx: 50, ty: 190 });
});
