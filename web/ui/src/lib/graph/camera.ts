import { graphSpring, GRAPH_SETTLE_MS, EXPLORE_MOTION } from './motion';

export interface GraphCamera { x: number; y: number; zoom: number }
export interface Point { x: number; y: number }
export interface Viewport { width: number; height: number }

export function projectPoint(p: Point, depth: number, camera: GraphCamera, size: Viewport): Point {
  const scale = camera.zoom * 600 / (600 - depth);
  return { x: size.width / 2 + (p.x - camera.x) * scale,
    y: size.height / 2 + (p.y - camera.y) * scale - depth * .6 };
}
export function unprojectPoint(p: Point, depth: number, camera: GraphCamera, size: Viewport): Point {
  const scale = camera.zoom * 600 / (600 - depth);
  return { x: camera.x + (p.x - size.width / 2) / scale,
    y: camera.y + (p.y - size.height / 2 + depth * .6) / scale };
}

/** The hand owns the camera until a new focus or explicit fit. Camera springs
 * have their own clock, so hover/status updates cannot restart a flight. */
export class GraphCameraController {
  value: GraphCamera = { x: 0, y: 0, zoom: 1 };
  manual = false;
  private ready = false;
  private target = { ...this.value };
  private from = { ...this.value };
  private velocity = { x: 0, y: 0, zoom: 0 };
  private fromVelocity = { ...this.velocity };
  private started = -Infinity;
  private motion = EXPLORE_MOTION;
  private reduced = false;
  private wheelZoom: { from: number; target: number; velocity: number; started: number;
    pointer: Point; world: Point; depth: number; size: Viewport } | null = null;

  follow(target: GraphCamera, now: number, reduced: boolean, motion = EXPLORE_MOTION) {
    this.reduced = reduced;
    if (this.manual) return;
    if (!this.ready) {
      this.value = { ...target }; this.target = { ...target }; this.ready = true; this.motion = motion;
      return;
    }
    if (target.x !== this.target.x || target.y !== this.target.y || target.zoom !== this.target.zoom || motion !== this.motion) {
      this.advance(now);
      this.from = { ...this.value }; this.fromVelocity = { ...this.velocity };
      this.target = { ...target }; this.started = now; this.motion = motion;
    }
    this.advance(now);
  }
  advance(now: number, size?: Viewport) {
    const zoom = this.wheelZoom;
    if (zoom) {
      const c = graphSpring(this.reduced ? GRAPH_SETTLE_MS : now - zoom.started);
      const delta = Math.log(zoom.from / zoom.target);
      const next = { ...this.value, zoom: zoom.target * Math.exp(delta * c.position + zoom.velocity * c.velocity) };
      const after = unprojectPoint(zoom.pointer, zoom.depth, next, size ?? zoom.size);
      this.value = { x: next.x + zoom.world.x - after.x, y: next.y + zoom.world.y - after.y, zoom: next.zoom };
      this.velocity.zoom = delta * c.positionRate + zoom.velocity * c.velocityRate;
      if (this.reduced || now - zoom.started >= GRAPH_SETTLE_MS) this.wheelZoom = null;
      return;
    }
    if (this.manual || !this.ready) return;
    const c = this.motion.sample(this.reduced ? this.motion.duration : now - this.started);
    const dx = this.from.x - this.target.x, dy = this.from.y - this.target.y;
    const dz = Math.log(this.from.zoom / this.target.zoom);
    this.value = {
      x: this.target.x + dx * c.position + this.fromVelocity.x * c.velocity,
      y: this.target.y + dy * c.position + this.fromVelocity.y * c.velocity,
      zoom: this.target.zoom * Math.exp(dz * c.position + this.fromVelocity.zoom * c.velocity),
    };
    this.velocity = { x: dx * c.positionRate + this.fromVelocity.x * c.velocityRate,
      y: dy * c.positionRate + this.fromVelocity.y * c.velocityRate,
      zoom: dz * c.positionRate + this.fromVelocity.zoom * c.velocityRate };
  }
  grab(now: number) {
    this.advance(now); this.wheelZoom = null; this.manual = true;
    this.velocity = { x: 0, y: 0, zoom: 0 };
  }
  resume(now: number) {
    if (!this.manual) return;
    this.advance(now); this.wheelZoom = null;
    this.manual = false; this.from = { ...this.value };
    this.fromVelocity = { x: 0, y: 0, zoom: 0 }; this.started = now;
  }
  pan(delta: Point, now: number) {
    this.grab(now);
    this.value = { ...this.value, x: this.value.x - delta.x / this.value.zoom, y: this.value.y - delta.y / this.value.zoom };
  }
  zoomAt(pointer: Point, factor: number, depth: number, size: Viewport, now: number) {
    this.advance(now, size);
    const world = unprojectPoint(pointer, depth, this.value, size);
    // Keep a wider auto-fit from jumping inward at the minimum zoom.
    // Accumulate wheel events against the destination, not the lagging display.
    const target = Math.max(Math.min(.15, this.value.zoom), Math.min(6, (this.wheelZoom?.target ?? this.value.zoom) * factor));
    this.wheelZoom = { from: this.value.zoom, target, velocity: this.wheelZoom ? this.velocity.zoom : 0,
      started: now, pointer, world, depth, size };
    this.manual = true;
    if (this.reduced) this.advance(now, size);
  }
  animating(now: number) { return !this.reduced && (!!this.wheelZoom || !this.manual && now - this.started < this.motion.duration); }
}
