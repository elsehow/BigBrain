/** Pure home-fit and safe-frame translation; camera motion lives in camera.ts. */
/** screen = world × scale + t */
export interface Camera {
  scale: number;
  tx: number;
  ty: number;
}

/** The canvas, and the room in it the picture is fitted into: the whole
 * canvas less `top` and `bottom` px of chrome (the home screen minimized
 * keeps its bar and its list up, and the picture sits between them). */
export interface Room {
  w: number;
  h: number;
  top: number;
  bottom: number;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The camera's ceiling when fitting a whole picture — a three-node vault
 * should not be three boulders. */
export const FIT_MAX = 3;
/** How much of the room a fitted picture takes. */
const FIT_PAD = 0.85;

/** The room's centre, on screen. */
const centreOf = (room: Room): [number, number] => {
  const inside = Math.max(1, room.h - room.top - room.bottom);
  return [room.w / 2, room.top + inside / 2];
};

/** The camera that shows all of `box` in the room, centred. */
export function fitCamera(box: Box, room: Room): Camera {
  const gw = Math.max(1, box.maxX - box.minX), gh = Math.max(1, box.maxY - box.minY);
  const inside = Math.max(1, room.h - room.top - room.bottom);
  const scale = Math.min(FIT_MAX, FIT_PAD * Math.min(room.w / gw, inside / gh));
  const [cx, cy] = centreOf(room);
  return { scale, tx: cx - ((box.minX + box.maxX) / 2) * scale, ty: cy - ((box.minY + box.maxY) / 2) * scale };
}

/** Translate only enough to reveal a projected point; preserve zoom exactly. */
export function revealCamera(camera: Camera, point: { x: number; y: number }, safe: Box, magnification = 1): Camera {
  const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(Math.max(low, high), v));
  return { scale: camera.scale,
    tx: camera.tx + (clamp(point.x, safe.minX, safe.maxX) - point.x) / magnification,
    ty: camera.ty + (clamp(point.y, safe.minY, safe.maxY) - point.y) / magnification };
}
