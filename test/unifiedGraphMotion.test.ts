import { expect, test } from 'bun:test';
import { graphSpring, GRAPH_SETTLE_MS, graphSine, GRAPH_SINE_MS, graphFocus, GRAPH_FOCUS_MS } from '../web/ui/src/lib/graph/motion';

const sample = (from: number, to: number, velocity: number, elapsed: number) => {
  const c = graphSpring(elapsed);
  return { x: to + (from - to) * c.position + velocity * c.velocity,
    v: (from - to) * c.positionRate + velocity * c.velocityRate };
};
test('focus spring eases to rest without overshooting and has a gentle tail', () => {
  let previous = 0;
  for (let t = 0; t <= GRAPH_SETTLE_MS; t += 10) {
    const p = sample(0, 100, 0, t);
    expect(p.x).toBeGreaterThanOrEqual(previous);
    expect(p.x).toBeLessThanOrEqual(100);
    previous = p.x;
  }
  expect(sample(0, 100, 0, 240).x).toBeLessThan(95);
  expect(sample(0, 100, 0, 600).x).toBeGreaterThan(99);
  expect(sample(0, 100, 0, GRAPH_SETTLE_MS)).toEqual({ x: 100, v: 0 });
});
test('an interrupted focus preserves position and velocity when the target reverses', () => {
  const moving = sample(0, 100, 0, 120);
  expect(moving.v).toBeGreaterThan(0);
  const interrupted = sample(moving.x, -100, moving.v, 0);
  expect(interrupted.x).toBeCloseTo(moving.x, 10);
  expect(interrupted.v).toBeCloseTo(moving.v, 10);
  const next = sample(moving.x, -100, moving.v, .001);
  expect((next.x - moving.x) / .001).toBeCloseTo(moving.v, 3);
  expect(sample(moving.x, -100, moving.v, GRAPH_SETTLE_MS)).toEqual({ x: -100, v: 0 });
});

test('sinusoidal focus starts and finishes gently, with its fastest motion halfway', () => {
  let previous = 1;
  for (let t = 0; t <= GRAPH_SINE_MS; t += 10) {
    const c = graphSine(t);
    expect(c.position).toBeLessThanOrEqual(previous);
    expect(c.position).toBeGreaterThanOrEqual(0);
    previous = c.position;
  }
  expect(graphSine(0).positionRate).toBeCloseTo(0, 10);
  expect(graphSine(100).position).toBeGreaterThan(.98);
  expect(graphSine(350).position).toBeCloseTo(.5, 10);
  expect(graphSine(700)).toEqual({ position: 0, velocity: 0, positionRate: 0, velocityRate: 0 });
  const v = -80 * graphSine(280).positionRate;
  const x = 80 - 80 * graphSine(280).position;
  const next = graphSine(.001);
  expect(((-40 + (x + 40) * next.position + v * next.velocity) - x) / .001).toBeCloseTo(v, 5);
  expect(graphSine(900, 1800).position).toBeCloseTo(.5, 10);
});

test('focus responds early and retains a soft settling tail without overshooting', () => {
  expect(graphFocus(100).position).toBeLessThan(graphSine(100, 280).position);
  expect(graphFocus(180).position).toBeLessThan(.2);
  expect(graphFocus(280).position).toBeGreaterThan(.02);
  expect(graphFocus(350).position).toBeLessThan(.02);
  let previous = 1;
  for (let t = 0; t <= GRAPH_FOCUS_MS; t += 10) {
    const c = graphFocus(t);
    expect(c.position).toBeLessThanOrEqual(previous);
    expect(c.position).toBeGreaterThanOrEqual(0); previous = c.position;
  }
  const c = graphFocus(120), x = 100 * (1 - c.position), v = -100 * c.positionRate;
  const next = graphFocus(.001);
  expect(((-100 + (x + 100) * next.position + v * next.velocity) - x) / .001).toBeCloseTo(v, 4);
  expect(graphFocus(GRAPH_FOCUS_MS)).toEqual({ position: 0, velocity: 0, positionRate: 0, velocityRate: 0 });
});
