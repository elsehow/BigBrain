import { expect, test } from 'bun:test';
import { GraphCameraController, projectPoint, unprojectPoint } from '../web/ui/src/lib/graph/camera';

import { FOCUS_MOTION } from '../web/ui/src/lib/graph/motion';

const size = { width: 1912, height: 1280 };
test('projection and drag inversion agree across depth and zoom', () => {
  for (const depth of [-240, -100, -18, 0, 64, 80]) for (const zoom of [.15, .7, 3, 6]) {
    const camera = { x: -73, y: 21, zoom }, p = { x: 145, y: -96 };
    const screen = projectPoint(p, depth, camera, size);
    const recovered = unprojectPoint(screen, depth, camera, size);
    expect(recovered.x).toBeCloseTo(p.x, 9); expect(recovered.y).toBeCloseTo(p.y, 9);
  }
});
test('zoom keeps the world point under the pointer at its depth', () => {
  for (const depth of [-100, 0, 80]) {
    const camera = new GraphCameraController(); camera.follow({ x: 12, y: -37, zoom: .8 }, 0, false);
    const pointer = { x: 1200, y: 317 }, before = unprojectPoint(pointer, depth, camera.value, size);
    camera.zoomAt(pointer, 1.4, depth, size, 20);
    expect(camera.value.zoom).toBe(.8);
    for (const time of [36, 80, 180, 320, 1020]) {
      camera.advance(time);
      const anchored = projectPoint(before, depth, camera.value, size);
      expect(anchored.x).toBeCloseTo(pointer.x, 9); expect(anchored.y).toBeCloseTo(pointer.y, 9);
      if (time < 1020) { expect(camera.value.zoom).toBeGreaterThan(.8); expect(camera.value.zoom).toBeLessThan(1.12); }
    }
    const after = projectPoint(before, depth, camera.value, size);
    expect(after.x).toBeCloseTo(pointer.x, 9); expect(after.y).toBeCloseTo(pointer.y, 9);
    expect(camera.value.zoom).toBeCloseTo(1.12, 9);
    expect(camera.animating(1020)).toBe(false);
  }
});
test('grabbing a flight is continuous; manual control persists until focus resumes', () => {
  const camera = new GraphCameraController(); camera.follow({ x: 0, y: 0, zoom: 1 }, 0, false);
  const target = { x: 300, y: -120, zoom: 3 };
  camera.follow(target, 10, false); camera.follow(target, 130, false);
  const before = { ...camera.value }; camera.grab(130);
  expect(camera.value).toEqual(before);
  camera.pan({ x: 40, y: -20 }, 150);
  const manual = { ...camera.value };
  camera.follow(target, 2000, false);
  expect(camera.value).toEqual(manual); expect(camera.animating(2000)).toBe(false);
  camera.resume(2100); camera.follow(target, 2100, false);
  expect(camera.value.x).toBeCloseTo(manual.x, 9); expect(camera.value.zoom).toBeCloseTo(manual.zoom, 9);
  camera.follow(target, 2400, false);
  expect(camera.value.zoom).toBeGreaterThan(manual.zoom); expect(camera.value.zoom).toBeLessThan(target.zoom);
  camera.follow(target, 3200, false); expect(camera.value).toEqual(target);
});
test('reduced motion snaps focus but retains direct manual control', () => {
  const camera = new GraphCameraController(); camera.follow({ x: 0, y: 0, zoom: 1 }, 0, true);
  camera.follow({ x: 100, y: 200, zoom: 2 }, 10, true);
  expect(camera.value).toEqual({ x: 100, y: 200, zoom: 2 }); expect(camera.animating(10)).toBe(false);
  camera.pan({ x: 20, y: 40 }, 20); expect(camera.value).toEqual({ x: 90, y: 180, zoom: 2 });
  camera.zoomAt({ x: 600, y: 300 }, 1.5, 0, size, 30);
  expect(camera.value.zoom).toBe(3); expect(camera.animating(30)).toBe(false);
});

test('wheel bursts accumulate, retain velocity and reanchor without a jump', () => {
  const camera = new GraphCameraController(); camera.follow({ x: 0, y: 0, zoom: 1 }, 0, false);
  const pointer = { x: 1100, y: 400 };
  camera.zoomAt(pointer, 1.5, 80, size, 10);
  camera.advance(109.99); const previous = Math.log(camera.value.zoom);
  camera.advance(110); const before = { ...camera.value }, velocity = (Math.log(before.zoom) - previous) / .01;
  const nextPointer = { x: 800, y: 600 };
  camera.zoomAt(nextPointer, 1.2, -100, size, 110);
  expect(camera.value.x).toBeCloseTo(before.x, 9); expect(camera.value.y).toBeCloseTo(before.y, 9);
  expect(camera.value.zoom).toBe(before.zoom);
  const world = unprojectPoint(nextPointer, -100, before, size);
  camera.advance(110.01);
  expect((Math.log(camera.value.zoom) - Math.log(before.zoom)) / .01).toBeCloseTo(velocity, 5);
  camera.advance(400);
  const anchored = projectPoint(world, -100, camera.value, size);
  expect(anchored.x).toBeCloseTo(nextPointer.x, 9); expect(anchored.y).toBeCloseTo(nextPointer.y, 9);
  camera.advance(1110); expect(camera.value.zoom).toBeCloseTo(1.8, 9);
});

test('pan and home focus cancel pending wheel motion at its current position', () => {
  const camera = new GraphCameraController(), home = { x: 0, y: 0, zoom: 1 };
  camera.follow(home, 0, false);
  camera.zoomAt({ x: 1000, y: 300 }, 2, 0, size, 10); camera.advance(150);
  const zoom = camera.value.zoom;
  camera.pan({ x: 40, y: 20 }, 150); const panned = { ...camera.value };
  camera.advance(2000); expect(camera.value).toEqual(panned);
  camera.zoomAt({ x: 1000, y: 300 }, 2, 0, size, 2100); camera.advance(2200);
  const manual = { ...camera.value }; expect(manual.zoom).toBeGreaterThan(zoom);
  camera.resume(2200); camera.follow(home, 2200, false);
  expect(camera.value.x).toBeCloseTo(manual.x, 9); expect(camera.value.zoom).toBeCloseTo(manual.zoom, 9);
  camera.follow(home, 3200, false); expect(camera.value).toEqual(home); expect(camera.animating(3200)).toBe(false);
});


test('faster focus preserves velocity when interrupting a slower camera move', () => {
  const camera = new GraphCameraController();
  camera.follow({ x: 0, y: 0, zoom: 1 }, 0, false);
  camera.follow({ x: 100, y: 0, zoom: 1 }, 10, false);
  camera.advance(149.999); const previous = camera.value.x;
  camera.advance(150); const before = camera.value.x, velocity = (before - previous) / .001;
  const target = { x: -100, y: 0, zoom: 1 };
  camera.follow(target, 150, false, FOCUS_MOTION);
  expect(camera.value.x).toBeCloseTo(before, 10);
  camera.advance(150.001);
  expect((camera.value.x - before) / .001).toBeCloseTo(velocity, 4);
  camera.advance(150 + FOCUS_MOTION.duration);
  expect(camera.value).toEqual(target); expect(camera.animating(150 + FOCUS_MOTION.duration)).toBe(false);
});
