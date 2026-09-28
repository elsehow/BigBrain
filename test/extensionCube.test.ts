// The extension's logo mark (clients/browser-extension/cube.js).
//
// The property under test is the one the design asks for: the mark must never
// be seen at an angle that is not its own. It turns while work is in flight
// and it STOPS ON A LANDING — a 180° half turn, which leaves the cube solved —
// so "sending → sent" reads as the mark coming to rest rather than an
// animation being cut off mid-rotation. A test is the only way to hold that:
// the bug it guards against is a single frame, and it looks fine in a
// screenshot right up until it doesn't.
//
// A hand-rolled DOM stub, because the file is browser JS with no build step
// and the geometry is pure arithmetic over element.style — nothing here needs
// a real layout engine. getBoundingClientRect reports a zero-width slot, which
// is cube.js's own "not laid out yet" signal, so the seating pass no-ops.

import { expect, test, describe, beforeEach } from "bun:test";

type El = {
  dataset: Record<string, string>;
  style: Record<string, string> & { setProperty(k: string, v: string): void };
  children: El[];
  parentElement: El | null;
  appendChild(c: El): El;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): El[];
  getBoundingClientRect(): {
    left: number;
    top: number;
    width: number;
    height: number;
    right: number;
    bottom: number;
  };
};

function el(): El {
  const style = {
    setProperty(k: string, v: string) {
      (style as Record<string, unknown>)[k] = v;
    },
  } as El["style"];
  const node: El = {
    dataset: {},
    style,
    children: [],
    parentElement: null,
    appendChild(c) {
      c.parentElement = node;
      node.children.push(c);
      return c;
    },
    querySelectorAll(sel) {
      const m = /^\[([\w-]+)(?:="(.*)")?\]$/.exec(sel);
      if (!m) return [];
      const key = m[1]!.replace(/^data-/, "").replace(/-(\w)/g, (_, c) => c.toUpperCase());
      const out: El[] = [];
      const walk = (n: El) => {
        for (const c of n.children) {
          const v = c.dataset[key];
          if (v !== undefined && (m[2] === undefined || v === m[2])) out.push(c);
          walk(c);
        }
      };
      walk(node);
      return out;
    },
    querySelector(sel) {
      return node.querySelectorAll(sel)[0] ?? null;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }),
  };
  return node;
}

// A hand-cranked animation clock: nothing advances unless the test says so.
let now = 0;
let pending: Array<{ id: number; fn: (t: number) => void }> = [];
let nextId = 1;

function tick(ms: number) {
  now += ms;
  const due = pending;
  pending = [];
  for (const p of due) p.fn(now);
}

let mount: (stage: El) => {
  spin(): void;
  settle(done?: () => void): void;
  destroy(): void;
};

beforeEach(async () => {
  now = 0;
  pending = [];
  nextId = 1;
  (globalThis as Record<string, unknown>).document = { createElement: () => el() };
  (globalThis as Record<string, unknown>).requestAnimationFrame = (fn: (t: number) => void) => {
    const id = nextId++;
    pending.push({ id, fn });
    return id;
  };
  (globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => {
    pending = pending.filter((p) => p.id !== id);
  };
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false });
  await import("../clients/browser-extension/cube.js");
  mount = (globalThis as Record<string, unknown>).BigBrainCube!.mount;
});

function stageEl() {
  const slot = el();
  const stage = el();
  stage.dataset.half = "9";
  stage.dataset.layer = "6";
  slot.appendChild(stage);
  return stage;
}

const slabAngle = (stage: El) => {
  const t = stage.querySelector('[data-box="slab"]')!.style.transform!;
  return Number(/rotate[XYZ]\(([-\d.]+)deg\)/.exec(t)![1]);
};
const slabAxis = (stage: El) =>
  /rotate([XYZ])\(/.exec(stage.querySelector('[data-box="slab"]')!.style.transform!)![1];

describe("the logo mark", () => {
  test("rests at its own angle before anything happens", () => {
    const stage = stageEl();
    mount(stage);
    expect(slabAngle(stage)).toBe(0);
  });

  test("turns while work is in flight", () => {
    const stage = stageEl();
    mount(stage).spin();
    tick(16); // the first frame only sets the clock's origin
    tick(200);
    const a = slabAngle(stage);
    tick(200);
    const b = slabAngle(stage);
    // eased, negative-going, and not yet landed
    expect(a).toBeLessThan(0);
    expect(b).toBeLessThan(a);
    expect(b).toBeGreaterThan(-180);
  });

  test("settle() does not stop the mark where it stands", () => {
    const stage = stageEl();
    const mark = mount(stage);
    mark.spin();
    tick(16); // the first frame only sets the clock's origin
    tick(300); // mid-turn: a bad implementation snaps to rest from here
    const mid = slabAngle(stage);
    expect(mid).toBeLessThan(0);
    expect(mid).toBeGreaterThan(-180);

    let rested = false;
    mark.settle(() => (rested = true));
    expect(rested).toBe(false); // still turning
    tick(100);
    expect(rested).toBe(false);
    expect(slabAngle(stage)).toBeLessThan(mid); // kept going, did not jump back
  });

  test("comes to rest ON a landing, never part-way through a turn", () => {
    const stage = stageEl();
    const mark = mount(stage);
    mark.spin();
    tick(300);

    let rested = false;
    mark.settle(() => (rested = true));
    for (let i = 0; i < 40 && !rested; i++) tick(60);

    expect(rested).toBe(true);
    // A half turn leaves the cube solved, so rest is the mark's own angle —
    // re-cut for the next move, which is the same picture.
    expect(slabAngle(stage)).toBe(0);
  });

  test("a turn is a HALF turn — the angle a landing is reached at", () => {
    const stage = stageEl();
    const mark = mount(stage);
    mark.spin();
    const axes: string[] = [slabAxis(stage)];
    // sample densely across several turns; the angle must never overshoot
    for (let i = 0; i < 200; i++) {
      tick(20);
      const a = slabAngle(stage);
      expect(a).toBeLessThanOrEqual(0);
      expect(a).toBeGreaterThanOrEqual(-180);
      const ax = slabAxis(stage);
      if (ax !== axes[axes.length - 1]) axes.push(ax);
    }
    mark.destroy();
    // it works through its move cycle rather than turning one face forever
    expect(axes.length).toBeGreaterThan(2);
    expect(new Set(axes).size).toBe(3); // X, Y and Z all get used
  });

  test("rests anyway when no frame ever comes (a throttled document)", async () => {
    const stage = stageEl();
    const mark = mount(stage);
    mark.spin();
    tick(300);
    // Nothing hangs off the animation that the animation may withhold: the
    // popup's DISCUSS chip and its close both wait on this callback.
    let rested = false;
    mark.settle(() => (rested = true));
    await new Promise((r) => setTimeout(r, 1000)); // real time; no rAF ticks
    expect(rested).toBe(true);
    expect(slabAngle(stage)).toBe(0);
  });

  test("stays on its rest angle when the reader asked for less motion", () => {
    (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: true });
    const stage = stageEl();
    const mark = mount(stage);
    mark.spin();
    tick(400);
    expect(slabAngle(stage)).toBe(0);
    let rested = false;
    mark.settle(() => (rested = true));
    expect(rested).toBe(true); // and callers are not left waiting
  });
});
