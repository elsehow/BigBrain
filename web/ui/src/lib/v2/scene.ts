// The v2 view's canvas: the vault's entities as a field of points and its
// memory topics as small glass octahedra. Imperative three.js behind a small
// API; the view (V2View.svelte) owns every word of chrome and tells this
// what is in play — an opened entity, search matches, a hovered feed row.
// Loaded on demand, so the rest of the app never pays for three.js.
//
// Look (settled in the prototype, 2026-10-02): a long lens and no lens
// effects — a plan, not a cutscene; points not balls; hairline edges; glass
// only for memory and Desktops; labels appear where attention is and give
// way to chrome.

import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { Field, FieldPilot } from "./model";
import { createWireCube, type WireCube } from "./wireCube";

export interface SceneHooks {
  /** Screen rects labels must stay out of (the view's panels). */
  blockers(): DOMRect[];
  /** A click: the node under it (a point, a memory topic, a label), or null for empty space. */
  onPick(i: number | null): void;
  /** A click on a pilot's glass or its name. */
  onPickPilot(id: string): void;
  /** The node under the pointer (a point, a memory topic, a label) changed. */
  onHover?(i: number | null): void;
  /** A click on a source drawn at rest (an index into field.sources). */
  onPickSource?(k: number): void;
  /** Whether every source is drawn at rest (Settings → Graph). */
  sources?(): boolean;
}
type Rig = { az: number; el: number; dist: number; tx: number; ty: number; tz: number };
type View = { az: number; el: number; dist: number; target: THREE.Vector3 };
/** Where the camera is, how it's moving and where it's headed: carried into a
 * redrawn field, so a vault change never moves the view out from under you. */
export interface V2Camera { rig: Rig; vel: Rig; goal: View; shift: number }
export interface V2Scene {
  /** Back to the whole field. */
  overview(): void;
  /** The pilots to draw (real sessions, placed over their context). */
  setPilots(pilots: FieldPilot[]): void;
  /** Focus one pilot: it fills in, its context comes forward. Null lets go. */
  focusPilot(id: string | null): void;
  /** Open an entity: it and its ties come forward. `text` sits beside it,
   * under `caption` when one says what it is; "" is text still being
   * written, shown as a spinner beside the name. */
  openEntity(i: number | null, ties?: number[], text?: string, caption?: string): void;
  /** Search state: null closes it; matches light up; `active` is in hand.
   * `move`: frame every match (a new query), glide to the active one (an
   * arrow key), or hold the camera (its text arriving). */
  search(state: { matches: number[]; active: number | null; text?: string; caption?: string; move: "frame" | "glide" | "none" } | null): void;
  /** A hovered feed row: what it mentions. */
  hover(entities: number[] | null): void;
  /** The feed row in hand, as a node of its own: over what it mentions, tied
   * to each (mentioning nothing in the field, it sits mid-view, tied to
   * nothing). Sources aren't in the field at rest; this one is there only
   * while it's in hand. `open`: opened as an entity is — framed, the rest
   * steps back, `text` beside it. `path`: with sources drawn at rest, the
   * one in hand sits on its own dot; one drawn as an entity, on the entity's. */
  source(s: { label: string; entities: number[]; open?: boolean; text?: string; path?: string } | null): void;
  /** Beside one of the opened entity's ties: how it relates to that entity,
   * after its name; "" is a spinner, null takes it away. The entity keeps
   * its own text: the relation finds room around its tie. */
  relate(j: number | null, text?: string): void;
  /** Remember where the camera is headed (a walk through the feed starting). */
  keepView(): void;
  /** Back to the remembered view, if there is one (the walk let go); false if not. */
  returnToView(): boolean;
  /** Pixels to slide the scene's centre right, clear of a left panel. */
  shift(px: number): void;
  /** The camera as it stands, for the next field to start from. */
  camera(): V2Camera;
  /** A hand on the field: a drag under way. */
  dragging(): boolean;
  dispose(): void;
}

/** Memory glass is a little see-through even at rest. */
const GLASS_OPACITY = 0.95;
// The field's weight (tuned live on a real vault, 2026-10-06): dots a little
// larger than first drawn, edges finer. Desktops' cubes keep their own hairline.
const EDGE_PX = 0.5;
const NODE_SCALE = 1.45;
/** A source at rest: about an unnamed entity's dot, the field's dust. */
const SRC_SIZE = NODE_SCALE * 3;
const LENS = Math.tan(THREE.MathUtils.degToRad(17)) / Math.tan(THREE.MathUtils.degToRad(10));
const OVERVIEW_AT = { az: 0.05, el: 0.55, dist: 30, target: new THREE.Vector3(0, 3, -4) };

export function createV2Scene(host: HTMLElement, field: Field, hooks: SceneHooks, from?: V2Camera): V2Scene {
  const OVERVIEW = { ...OVERVIEW_AT, target: OVERVIEW_AT.target.clone() };
  const reducedMQ = matchMedia("(prefers-reduced-motion: reduce)");
  const canvas = document.createElement("canvas");
  canvas.className = "v2-canvas";
  const labelLayer = document.createElement("div");
  labelLayer.className = "v2-labels";
  host.append(canvas, labelLayer);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // No tone curve: the theme's colours are drawn as given, so white seen
  // through glass is the page's white, not a shade under it.
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const camera = new THREE.PerspectiveCamera(20, 1, 0.1, 400);
  const col = { bg: new THREE.Color(), fg: new THREE.Color(), act: new THREE.Color() };
  const fog = { near: { value: 30 }, far: { value: 80 } };

  // ── particles: every entity a point ──────────────────────────────────────
  const N = field.nodes.length;
  // and after them, SOURCES slots: the feed row in hand drawn as a node of its
  // own while it's held (one fading out while the next fades in)
  const SOURCES = 3;
  const pGeo = new THREE.BufferGeometry();
  const aPos = new THREE.Float32BufferAttribute([...field.nodes.flatMap((n) => n.p), ...Array.from({ length: SOURCES * 3 }, () => 0)], 3);
  pGeo.setAttribute("position", aPos);
  const aSize = new THREE.BufferAttribute(new Float32Array(N + SOURCES), 1);
  const aColor = new THREE.BufferAttribute(new Float32Array((N + SOURCES) * 3), 3);
  const aAlpha = new THREE.BufferAttribute(new Float32Array(N + SOURCES), 1);
  pGeo.setAttribute("aSize", aSize); pGeo.setAttribute("aColor", aColor); pGeo.setAttribute("aAlpha", aAlpha);
  const pMat = new THREE.ShaderMaterial({
    uniforms: { uFogNear: fog.near, uFogFar: fog.far, uPx: { value: 1 }, uRef: { value: 36 } },
    vertexShader: /* glsl */`
      attribute float aSize; attribute vec3 aColor; attribute float aAlpha;
      uniform float uPx, uRef, uFogNear, uFogFar;
      varying vec3 vC; varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = -mv.z;
        gl_PointSize = max(1.5, aSize * uPx * uRef / d);
        vC = aColor;
        vA = aAlpha * (1.0 - smoothstep(uFogNear, uFogFar, d));
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vC; varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        float core = 1.0 - smoothstep(0.38, 0.55, d);
        float halo = (1.0 - d) * (1.0 - d) * 0.22;
        gl_FragColor = vec4(vC, vA * max(core, halo));
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false,
  });
  const points = new THREE.Points(pGeo, pMat);
  points.renderOrder = 3;
  points.frustumCulled = false;
  scene.add(points);
  const baseSize = field.nodes.map((n) => NODE_SCALE * (n.named ? 4.5 + 1.2 * Math.log1p(n.degree) : 1.8 + 0.75 * Math.log1p(n.degree)));
  const P = field.nodes.map((n) => new THREE.Vector3(...n.p));

  // ── sources: hidden at rest; the one in hand is a node like any other ────
  // It sits over the middle of what it mentions, tied to each, and comes and
  // goes as a pointed dot's name does: fading in where it is, out where it was.
  type Src = { key: string; ties: number[]; home: THREE.Vector3 | null; at: THREE.Vector3; vis: number; want: boolean; open: boolean; L: HTMLDivElement & { w?: number; h?: number; op?: number } };
  const sources: Src[] = Array.from({ length: SOURCES }, () => {
    const L = document.createElement("div") as Src["L"];
    L.className = "v2-lab v2-node v2-source";
    const t = document.createElement("span"), q = document.createElement("span");
    t.className = "t"; q.className = "q";
    L.append(t, q);
    return { key: "", ties: [], home: null, at: new THREE.Vector3(), vis: 0, want: false, open: false, L };
  });
  const srcName = (s: string) => (s.length > 48 ? s.slice(0, 47).trimEnd() + "…" : s);
  /** Its name, or opened, its text where an opened entity's goes. */
  const sourceLabel = (s: Src, name: string, text: string | undefined) => {
    const full = s.open && !!text;
    s.L.classList.toggle("full", full);
    s.L.children[0]!.textContent = srcName(name);
    s.L.children[1]!.textContent = full ? text! : "";
    s.L.w = undefined;
  };
  for (const s of sources) labelLayer.append(s.L);

  // ── every source at rest (Settings → Graph): fainter dots on the same
  // floor plan; the one pointed at says its name and ties to what it mentions
  const S = field.sources.length;
  const sGeo = new THREE.BufferGeometry();
  sGeo.setAttribute("position", new THREE.Float32BufferAttribute(field.sources.flatMap((x) => x.p), 3));
  const sSize = new THREE.BufferAttribute(new Float32Array(S), 1);
  const sColor = new THREE.BufferAttribute(new Float32Array(S * 3), 3);
  const sAlpha = new THREE.BufferAttribute(new Float32Array(S), 1);
  sGeo.setAttribute("aSize", sSize); sGeo.setAttribute("aColor", sColor); sGeo.setAttribute("aAlpha", sAlpha);
  const restSources = new THREE.Points(sGeo, pMat);
  restSources.renderOrder = 3;
  restSources.frustumCulled = false;
  scene.add(restSources);
  const SP = field.sources.map((x) => new THREE.Vector3(...x.p));
  const sourceAt = new Map(field.sources.flatMap((x, k) => x.paths.map((p) => [p, SP[k]!] as const)));
  // a source drawn as an entity has no dot of its own: held, it sits on the
  // entity's, switch on or off
  const entityAt = new Map(field.nodes.flatMap((n) => (n.opens ?? []).map((p) => [p, P[n.i]!] as const)));
  const sPoint = new Float32Array(S);
  let srcShown = hooks.sources?.() ? 1 : 0, underSrc: number | null = null, srcNamed: number | null = null;
  /** How far the named resting source is shown (its name and ties fade with it). */
  const namedVis = () => (srcNamed == null ? 0 : sPoint[srcNamed]! * srcShown);
  // its name: a plain node label (clickable, unlike a held source's)
  const restName = document.createElement("div") as Src["L"];
  restName.className = "v2-lab v2-node";
  restName.append(Object.assign(document.createElement("span"), { className: "t" }));
  labelLayer.append(restName);

  // ── lines ────────────────────────────────────────────────────────────────
  // fat lines (a GL line is always 1px), drawn in device pixels: resize() fits each to the canvas
  const lineMats = new Set<LineMaterial>();
  const lineSet = (pairs: Array<[THREE.Vector3, THREE.Vector3]>, opacity: number) => {
    const g = new LineSegmentsGeometry().setPositions(new Float32Array(pairs.flatMap(([a, b]) => [a.x, a.y, a.z, b.x, b.y, b.z])));
    const m = new LineMaterial({ linewidth: EDGE_PX, transparent: true, opacity, depthWrite: false });
    lineMats.add(m);
    const l = new LineSegments2(g, m);
    l.renderOrder = 1;
    l.frustumCulled = false;
    scene.add(l);
    return l;
  };
  const strong = lineSet(field.strong.map(([a, b]) => [P[a]!, P[b]!]), 0.14);
  const dynamic = (max: number) => {
    const pos = new Float32Array(max * 6), rgb = new Float32Array(max * 6);
    const g = new LineSegmentsGeometry().setPositions(pos).setColors(rgb);
    const m = new LineMaterial({ linewidth: EDGE_PX, vertexColors: true, transparent: true, depthWrite: false });
    lineMats.add(m);
    const l = new LineSegments2(g, m);
    l.frustumCulled = false;
    l.renderOrder = 2;
    scene.add(l);
    let k = 0;
    return {
      begin() { k = 0; },
      add(a: THREE.Vector3, b: THREE.Vector3, ca: THREE.Color, cb: THREE.Color) {
        if (k >= max) return;
        a.toArray(pos, k * 6); b.toArray(pos, k * 6 + 3);
        ca.toArray(rgb, k * 6); cb.toArray(rgb, k * 6 + 3);
        k++;
      },
      end() {
        g.instanceCount = k;
        (g.attributes["instanceStart"] as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
        (g.attributes["instanceColorStart"] as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
      },
    };
  };
  const ties = dynamic(160 + 128);

  // ── glass: memory topics ─────────────────────────────────────────────────
  const octa = new THREE.OctahedronGeometry(1, 0);
  interface Glass { mesh: THREE.Mesh; mat: THREE.MeshPhysicalMaterial; vis: number }
  // Smooth glass that diffuses a little from within (rough transmission), nearly
  // colourless, crisp clear-coat highlights, no outline, no surface texture.
  // Each topic sits at its own slight tilt, so no two catch the light alike.
  const glass = (geo: THREE.BufferGeometry): Glass => {
    const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, flatShading: true,
      roughness: 0.22,
      transmission: 1, thickness: 1, ior: 1.42, dispersion: 2.5, attenuationDistance: 5,
      clearcoat: 1, clearcoatRoughness: 0.04, specularIntensity: 0.85, iridescence: 0.08, iridescenceIOR: 1.3,
      transparent: true, opacity: GLASS_OPACITY, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 4;
    scene.add(mesh);
    return { mesh, mat, vis: 1 };
  };
  // ── Desktops: the Wire mark, in glass, over what they're working on ────
  // Prism glass (it bends the field behind it and splits it into colour), a
  // hairline outline, and the logo's turning while the agent works. A fixed
  // DESK_PX on screen at any zoom: a Desktop in world units grew past the
  // names around it as the camera came in.
  const prism = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0, transmission: 1,
    thickness: 2.4, ior: 1.6, dispersion: 12, clearcoat: 0.8, clearcoatRoughness: 0.02, specularIntensity: 0.8, envMapIntensity: 0.6,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  // hairlines are drawn in device pixels, so each knows the canvas's size
  const fit = (m: LineMaterial) => m.resolution.set(W * renderer.getPixelRatio(), H * renderer.getPixelRatio());
  const hairline = () => { const m = new LineMaterial({ linewidth: 1, transparent: true }); fit(m); lineMats.add(m); return m; };
  interface Pilot { d: FieldPilot; cube: WireCube; line: LineMaterial; seam: LineMaterial; label: HTMLDivElement & { w?: number; h?: number; op?: number }; scale: number; vis: number; clock: number; at: THREE.Vector3 }
  const pilots = new Map<string, Pilot>();
  let focus: string | null = null, underPilot: string | null = null;
  const makePilot = (d: FieldPilot): Pilot => {
    const line = hairline(), seam = hairline(), cube = createWireCube(prism, line, seam);
    scene.add(cube.root);
    const label = document.createElement("div") as Pilot["label"];
    label.className = "v2-lab v2-pilot";
    label.dataset["pilot"] = d.id;
    labelLayer.append(label);
    // each on its own clock, so Desktops working at once never turn in step
    const clock = [...d.id].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 7) % 6720;
    line.color.copy(col.fg);
    return { d, cube, line, seam, label, scale: 0, vis: 1, clock, at: new THREE.Vector3(...d.p) };
  };
  const nameOf = (d: FieldPilot) => (d.title.length > 34 ? d.title.slice(0, 33).trimEnd() + "…" : d.title);

  const memory = field.nodes.filter((n) => n.memory).map((n) => {
    const g = glass(octa);
    g.mesh.position.set(...n.p);
    // its own slight tilt: hashed from the id, so it holds across loads
    const h = [...n.id].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 7);
    g.mesh.rotation.set(((h % 97) / 97 - 0.5) * 0.35, 0.4 + ((h % 89) / 89) * 0.9, ((h % 83) / 83 - 0.5) * 0.25);
    return { ...g, i: n.i };
  });

  // A memory topic is drawn the size of an important node: a hub's dot. A
  // point's size is set in pixels at a reference distance (uRef), so in world
  // units its visible core depends only on the viewport's height.
  const hubSize = (() => {
    const s = [...field.hubs].map((i) => baseSize[i]!).sort((a, b) => a - b);
    return s.length ? s[s.length >> 1]! : 6;
  })();
  const sizeMemory = () => {
    const core = 0.47 * hubSize * pMat.uniforms["uRef"]!.value * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / H;
    for (const g of memory) g.mesh.scale.setScalar(core);
    for (const m of lineMats) fit(m);
  };
  // a Desktop's width on screen, about a line of its 12px name
  const DESK_PX = 13;
  // world units across one CSS pixel at a point, on this lens
  const perPx = (p: THREE.Vector3) => 2 * camera.position.distanceTo(p) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / H;

  // ── state ────────────────────────────────────────────────────────────────
  let ent: { i: number; ties: number[]; text?: string; caption?: string } | null = null;
  let srch: { matches: Set<number>; active: number | null; text?: string; caption?: string } | null = null;
  let hot: Set<number> | null = null;
  let rl: { j: number; text: string } | null = null;
  let shiftGoal = 0, shiftNow = 0;
  // point: the dot under the pointer, eased so its name fades in and out
  const rel = new Float32Array(N), heat = new Float32Array(N), match = new Float32Array(N), point = new Float32Array(N);
  let dim = 0, searchDim = 1;

  // camera: springs toward a goal, a long lens from further back
  const rig: Rig = { az: OVERVIEW.az, el: OVERVIEW.el, dist: OVERVIEW.dist, tx: OVERVIEW.target.x, ty: OVERVIEW.target.y, tz: OVERVIEW.target.z };
  const vel: Rig = { az: 0, el: 0, dist: 0, tx: 0, ty: 0, tz: 0 };
  const goal = { az: OVERVIEW.az, el: OVERVIEW.el, dist: OVERVIEW.dist, target: OVERVIEW.target.clone() };
  /** The view a walk through the feed started from. */
  let kept: View | null = null;
  const viewOf = (): View => ({ az: goal.az, el: goal.el, dist: goal.dist, target: goal.target.clone() });
  const setGoal = (g: { az?: number; el: number; dist: number; target: THREE.Vector3 }) => {
    goal.az = g.az ?? rig.az; goal.el = g.el; goal.dist = g.dist; goal.target.copy(g.target);
  };
  const frameAround = (pts: THREE.Vector3[], el: number, k: number, lo: number, hi: number) => {
    if (!pts.length) return setGoal({ ...OVERVIEW, az: rig.az });
    const c = new THREE.Vector3();
    for (const p of pts) c.add(p);
    c.divideScalar(pts.length);
    let R = 0;
    for (const p of pts) R = Math.max(R, p.distanceTo(c));
    setGoal({ el, dist: THREE.MathUtils.clamp(R * k + 3, lo, hi), target: c });
  };
  const centre = (pts: THREE.Vector3[]) => pts.reduce((c, p) => c.add(p), new THREE.Vector3()).divideScalar(pts.length);
  /** The one thing in hand, highlighted: the camera comes in close and
   * centres on it. A search's active match and a source walked to (j/k) both
   * arrive this way; `around` is what must stay in view with it (a source's
   * ties), which backs the camera out only as far as it takes to fit. */
  const glide = (at: THREE.Vector3, around: THREE.Vector3[] = []) => {
    const R = Math.max(0, ...around.map((p) => p.distanceTo(at)));
    setGoal({ el: 0.5, dist: THREE.MathUtils.clamp(R * 2.6 + 3, 9, OVERVIEW.dist), target: at.clone() });
  };
  /** A source walked to, glided to as a search's match is. Tied to nothing,
   * it sits where you are, and the camera holds. */
  const follow = (s: Src) => { if (s.ties.length) glide(s.at, s.ties.map((j) => P[j]!)); };
  /** Over the middle of what it mentions, lifted clear of it (over one, a
   * little aside, so the tie reads); mentioning nothing here, mid-view. */
  const settle = (s: Src) => {
    if (s.home) s.at.copy(s.home);
    else if (s.ties.length) s.at.copy(centre(s.ties.map((j) => P[j]!))).add(v3.set(s.ties.length === 1 ? 0.6 : 0, 1.6, 0));
    else s.at.copy(goal.target).y += 1.2;
    s.at.toArray(aPos.array, (N + sources.indexOf(s)) * 3);
    aPos.needsUpdate = true;
  };

  // ── labels: DOM, placed per frame, culled where they'd collide ──────────
  const labels = new Map<number, HTMLDivElement & { w?: number; h?: number; full?: boolean; op?: number }>();
  const labelOf = (i: number) => {
    let L = labels.get(i);
    if (!L) {
      L = document.createElement("div") as HTMLDivElement & { w?: number };
      L.className = "v2-lab v2-node" + (field.nodes[i]!.memory ? " memory" : "");
      L.dataset["i"] = String(i);
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = field.nodes[i]!.label;
      const c = document.createElement("span");
      c.className = "c";
      const q = document.createElement("span");
      q.className = "q";
      L.append(t, c, q);
      labelLayer.append(L);
      labels.set(i, L);
    }
    return L;
  };
  /** Drop a relation: its label goes back to its name. */
  const unrelate = () => {
    const lab = rl ? labels.get(rl.j) : undefined;
    if (lab) { lab.full = undefined; lab.w = undefined; }
    rl = null;
  };
  const say = (L: HTMLDivElement, name: string, text: string | undefined, caption?: string) => {
    L.querySelector(".c")!.textContent = text ? caption ?? "" : "";
    const q = L.querySelector(".q")!;
    if (text === undefined) { q.textContent = ""; return; }
    const b = document.createElement("b");
    q.replaceChildren();
    if (!text) {
      const spin = document.createElement("span");
      b.textContent = name; spin.className = "spin"; spin.setAttribute("aria-label", "Writing a summary");
      q.append(b, spin);
      return;
    }
    const at = text.toLowerCase().indexOf(name.toLowerCase());
    if (at >= 0) { b.textContent = text.slice(at, at + name.length); q.append(text.slice(0, at), b, text.slice(at + name.length)); }
    else { b.textContent = name; q.append(b, " · " + text); }
  };
  const place = (L: HTMLElement & { op?: number }, x: number, y: number, op: number) => {
    L.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(0,-50%)`;
    const o = Math.round(op * 40) / 40;
    if (o !== L.op) { L.style.opacity = String(o); L.style.visibility = o <= 0 ? "hidden" : "visible"; L.op = o; }
  };
  const v3 = new THREE.Vector3();
  /** How far a label stands off its dot, in CSS px: 9 for a dot of the usual size, and the
   * dot's visible radius plus a margin when it is drawn bigger. A point is `size * uRef / depth`
   * px across (pMat's shader); about 0.47 of that is the bright core. */
  const labelGap = (p: THREE.Vector3, size: number) => {
    const d = -v3.copy(p).applyMatrix4(camera.matrixWorldInverse).z;
    return d > 0 ? Math.max(9, 0.235 * size * pMat.uniforms["uRef"]!.value / d + 6) : 9;
  };
  const toScreen = (p: THREE.Vector3, out: { x: number; y: number; ok: boolean }) => {
    v3.copy(p).project(camera);
    out.x = (v3.x * 0.5 + 0.5) * W; out.y = (-v3.y * 0.5 + 0.5) * H; out.ok = v3.z < 1 && v3.z > -1;
  };

  // ── input ────────────────────────────────────────────────────────────────
  let W = 1, H = 1, drag: { x: number; y: number; moved: number } | null = null;
  // picking: a memory topic's glass under the pointer, else the nearest
  // visible point within a few pixels of it
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), sp = { x: 0, y: 0, ok: false };
  const pickAt = (clientX: number, clientY: number): number | string | null => {
    const r = canvas.getBoundingClientRect(), x = clientX - r.left, y = clientY - r.top;
    ndc.set((x / r.width) * 2 - 1, -(y / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    // a Desktop is small on screen: within a few pixels of its cube is on it
    let near: string | null = null, nearD = Infinity;
    for (const pl of pilots.values()) {
      toScreen(pl.cube.root.position, sp);
      const d = (sp.x - x) ** 2 + (sp.y - y) ** 2, reach = Math.max(12, DESK_PX * pl.scale * 0.8);
      if (sp.ok && d < reach * reach && d < nearD) { nearD = d; near = pl.d.id; }
    }
    if (near) return `pilot:${near}`;
    const glassHit = ray.intersectObjects(memory.filter((g) => g.vis > 0.5).map((g) => g.mesh), false)[0];
    if (glassHit) return memory.find((g) => g.mesh === glassHit.object)?.i ?? null;
    const alphas = aAlpha.array as Float32Array;
    let best: number | string | null = null, bestD = 12 * 12;
    const consider = (p: THREE.Vector3, hit: number | string) => {
      toScreen(p, sp);
      const d = (sp.x - x) ** 2 + (sp.y - y) ** 2;
      if (sp.ok && d < bestD) { bestD = d; best = hit; }
    };
    for (let i = 0; i < N; i++) if (!field.nodes[i]!.memory && alphas[i]! >= 0.15) consider(P[i]!, i);
    if (srcShown > 0.5) for (let k = 0; k < S; k++) consider(SP[k]!, `src:${k}`);
    return best;
  };
  /** A resting source's index, from a pick. */
  const srcHit = (hit: number | string | null): number | null => (typeof hit === "string" && hit.startsWith("src:") ? Number(hit.slice(4)) : null);
  const onDown = (e: PointerEvent) => { drag = { x: e.clientX, y: e.clientY, moved: 0 }; canvas.setPointerCapture(e.pointerId); };
  let under: number | null = null;
  const hoverAt = (i: number | null) => { if (i !== under) { under = i; hooks.onHover?.(i); } };
  const onMove = (e: PointerEvent) => {
    if (!drag) {
      const hit = pickAt(e.clientX, e.clientY);
      canvas.style.cursor = hit == null ? "" : "pointer";
      hoverAt(typeof hit === "number" ? hit : null);
      underPilot = typeof hit === "string" && hit.startsWith("pilot:") ? hit.slice(6) : null;
      underSrc = srcHit(hit);
      return;
    }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy); drag.x = e.clientX; drag.y = e.clientY;
    goal.az -= dx * 0.005; goal.el = THREE.MathUtils.clamp(goal.el + dy * 0.004, 0.08, 1.35);
  };
  const onUp = (e: PointerEvent) => {
    if (drag && drag.moved < 4) {
      const hit = pickAt(e.clientX, e.clientY);
      const k = srcHit(hit);
      if (k != null) hooks.onPickSource?.(k);
      else if (typeof hit === "string") hooks.onPickPilot(hit.slice(6)); else hooks.onPick(hit);
    }
    drag = null;
  };
  // labels are clickable too: they name the thing
  const onLabel = (e: MouseEvent) => {
    const pl = (e.target as HTMLElement).closest<HTMLElement>(".v2-pilot");
    if (pl?.dataset["pilot"]) { hooks.onPickPilot(pl.dataset["pilot"]); return; }
    const sl = (e.target as HTMLElement).closest<HTMLElement>("[data-src]");
    if (sl?.dataset["src"]) { hooks.onPickSource?.(Number(sl.dataset["src"])); return; }
    const L = (e.target as HTMLElement).closest<HTMLElement>(".v2-node");
    if (L?.dataset["i"]) hooks.onPick(Number(L.dataset["i"]));
  };
  labelLayer.addEventListener("click", onLabel);
  const onLabelOver = (e: PointerEvent) => {
    underPilot = (e.target as HTMLElement).closest<HTMLElement>(".v2-pilot")?.dataset["pilot"] ?? null;
    const sl = (e.target as HTMLElement).closest<HTMLElement>("[data-src]")?.dataset["src"];
    underSrc = sl ? Number(sl) : null;
    const L = (e.target as HTMLElement).closest<HTMLElement>(".v2-node");
    hoverAt(L?.dataset["i"] ? Number(L.dataset["i"]) : null);
  };
  const onLeave = () => { if (!drag) { hoverAt(null); underPilot = null; underSrc = null; } };
  labelLayer.addEventListener("pointerover", onLabelOver);
  canvas.addEventListener("pointerleave", onLeave);
  const onWheel = (e: WheelEvent) => { e.preventDefault(); goal.dist = THREE.MathUtils.clamp(goal.dist * Math.exp(e.deltaY * 0.0012), 4, 40); };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  const resize = () => {
    const r = host.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    sizeMemory();
    // the overview fits the field's width (radius 15, plus room) to the window
    const fit = THREE.MathUtils.clamp(17 / (LENS * Math.tan(THREE.MathUtils.degToRad(10)) * camera.aspect), 22, 46);
    const atRest = !ent && !srch && !focus;
    OVERVIEW.dist = fit;
    if (atRest) goal.dist = fit;
    if (!sized) { rig.dist = fit; sized = true; }
  };
  let sized = false;
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();
  // a field redrawn: the camera carries on from where the last one left it
  if (from) { Object.assign(rig, from.rig); Object.assign(vel, from.vel); setGoal(from.goal); shiftNow = shiftGoal = from.shift; }

  const theme = () => {
    const cs = getComputedStyle(host);
    col.bg.set(cs.getPropertyValue("--bg").trim() || "#ffffff");
    col.fg.set(cs.getPropertyValue("--fg").trim() || "#211a18");
    col.act.set(cs.getPropertyValue("--activity").trim() || "#cc4a3e");
    scene.background = col.bg.clone();
    // What glass reflects: a room in the theme's own colours (its ground, one
    // soft panel a shade toward the ink). Three's stock RoomEnvironment is a
    // grey studio, and greyed the glass in every theme.
    const room = new THREE.Scene();
    room.background = col.bg.clone();
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), new THREE.MeshBasicMaterial({ color: col.bg.clone().lerp(col.fg, 0.18), side: THREE.DoubleSide }));
    panel.position.set(0, 4, -2); panel.lookAt(0, 0, 0); room.add(panel);
    scene.environment?.dispose();
    scene.environment = pmrem.fromScene(room, 0.04).texture;
    panel.geometry.dispose(); (panel.material as THREE.Material).dispose();
    for (const pl of pilots.values()) pl.line.color.copy(col.fg);
    strong.material.color.copy(col.fg);
    for (const g of memory) {
      // all but colourless: the faintest ink in it, so it reads as glass, not smoke
      g.mat.color.setRGB(1, 1, 1).lerp(col.fg, 0.02);
      g.mat.attenuationColor.copy(col.fg).lerp(col.bg, 0.7);
    }
  };
  theme();
  const mo = new MutationObserver(theme);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  const schemeMQ = matchMedia("(prefers-color-scheme: dark)");
  schemeMQ.addEventListener("change", theme);

  // ── frame ────────────────────────────────────────────────────────────────
  const clock = new THREE.Clock();
  const c1 = new THREE.Color(), c2 = new THREE.Color(), dust = new THREE.Color();
  const tA = new THREE.Vector3(), tB = new THREE.Vector3();
  const s1 = { x: 0, y: 0, ok: false }, s2 = { x: 0, y: 0, ok: false };
  let raf = 0, clockT = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    const reduced = reducedMQ.matches;
    const ease = (rate: number) => (reduced ? 1 : 1 - Math.exp(-dt * rate));
    const spr = (k: keyof typeof rig, g: number, stiff: number, z: number) => {
      if (reduced) { rig[k] = g; vel[k] = 0; return; }
      vel[k] += (stiff * (g - rig[k]) - 2 * Math.sqrt(stiff) * z * vel[k]) * dt;
      rig[k] += vel[k] * dt;
    };
    spr("az", goal.az, 46, 0.92); spr("el", goal.el, 46, 0.92); spr("dist", goal.dist, 40, 0.95);
    spr("tx", goal.target.x, 40, 0.95); spr("ty", goal.target.y, 40, 0.95); spr("tz", goal.target.z, 40, 0.95);
    const d = rig.dist * LENS;
    camera.position.set(rig.tx + Math.sin(rig.az) * Math.cos(rig.el) * d, rig.ty + Math.sin(rig.el) * d, rig.tz + Math.cos(rig.az) * Math.cos(rig.el) * d);
    camera.lookAt(rig.tx, rig.ty, rig.tz);
    shiftNow += (shiftGoal - shiftNow) * ease(8);
    camera.setViewOffset(W, H, W < 700 ? 0 : -shiftNow, 0, W, H);
    camera.updateMatrixWorld();
    fog.near.value = d * 1.15; fog.far.value = d * 2.6;
    pMat.uniforms["uPx"]!.value = renderer.getPixelRatio();

    // what is in play
    const fp = focus ? pilots.get(focus) : undefined;
    const os = sources.find((s) => s.want && s.open);
    const inPlay: Set<number> | null = srch ? null : ent ? new Set([ent.i, ...ent.ties]) : fp ? new Set(fp.d.ctx) : os ? new Set(os.ties) : null;
    const k = ease(9);
    dim += ((inPlay ? 1 : 0) - dim) * k;
    searchDim += ((srch && srch.matches.size ? 0.12 : srch ? 0.5 : 1) - searchDim) * ease(10);
    dust.copy(col.fg).lerp(col.bg, 0.42);
    srcShown += ((hooks.sources?.() ? 1 : 0) - srcShown) * ease(8);
    const pointedTies = underSrc != null && srcShown > 0.5 ? new Set(field.sources[underSrc]!.ties) : null;
    const sizes = aSize.array as Float32Array, colors = aColor.array as Float32Array, alphas = aAlpha.array as Float32Array;
    for (let i = 0; i < N; i++) {
      const n = field.nodes[i]!;
      rel[i]! += ((inPlay?.has(i) ? 1 : 0) - rel[i]!) * k;
      const lit = !!hot?.has(i) || !!pointedTies?.has(i);
      heat[i]! += ((lit ? 1 : 0) - heat[i]!) * ease(lit ? 18 : 10);
      match[i]! += ((srch?.matches.has(i) ? 1 : 0) - match[i]!) * ease(12);
      point[i]! += ((i === under ? 1 : 0) - point[i]!) * ease(i === under ? 18 : 10);
      if (n.memory) { alphas[i] = 0; continue; }
      const h = Math.max(heat[i]!, match[i]!);
      const r = rel[i]!;
      sizes[i] = baseSize[i]! * (1 + 0.7 * h) * (1 + 0.45 * r * dim);
      const rest = n.named ? 0.95 : 0.6;
      alphas[i] = Math.max(h, THREE.MathUtils.lerp(rest, THREE.MathUtils.lerp(n.named ? 0.22 : 0.12, 1, r), dim)) * THREE.MathUtils.lerp(searchDim, 1, match[i]!);
      c1.copy(n.named || r > 0.5 ? col.fg : dust).lerp(col.act, h * 0.9).toArray(colors, i * 3);
    }
    let srcHeld = 0;
    sources.forEach((s, k) => {
      s.vis += ((s.want ? 1 : 0) - s.vis) * ease(s.want ? 18 : 10);
      srcHeld = Math.max(srcHeld, s.vis);
      const i = N + k;
      sizes[i] = hubSize;
      alphas[i] = 0.95 * s.vis;
      col.fg.toArray(colors, i * 3);
    });
    aSize.needsUpdate = true; aColor.needsUpdate = true; aAlpha.needsUpdate = true;
    // sources at rest: faint, stepping back as the field does when something is in play
    {
      const sz = sSize.array as Float32Array, sc = sColor.array as Float32Array, sa = sAlpha.array as Float32Array;
      const rest = 0.75 * THREE.MathUtils.lerp(1, 0.3, dim) * searchDim * (1 - 0.6 * srcHeld);
      for (let k = 0; k < S; k++) {
        sPoint[k]! += ((k === underSrc ? 1 : 0) - sPoint[k]!) * ease(k === underSrc ? 18 : 10);
        sz[k] = SRC_SIZE * (1 + 0.6 * sPoint[k]!);
        sa[k] = srcShown * Math.max(sPoint[k]!, rest);
        c1.copy(dust).lerp(col.fg, sPoint[k]!).toArray(sc, k * 3);
      }
      sSize.needsUpdate = true; sColor.needsUpdate = true; sAlpha.needsUpdate = true;
    }
    // a source in hand: the field's own lines step back so its ties read
    strong.material.opacity = 0.14 * searchDim * (1 - 0.5 * dim) * (1 - 0.6 * srcHeld);

    // memory glass recedes with everything else when something is in play
    for (const g of memory) {
      const linked = inPlay ? field.edges.some(([a, b]) => (a === g.i && inPlay.has(b)) || (b === g.i && inPlay.has(a))) : true;
      g.vis += (THREE.MathUtils.lerp(1, linked ? 1 : 0.3, dim) * THREE.MathUtils.lerp(searchDim, 1, match[g.i]!) - g.vis) * k;
      g.mat.opacity = GLASS_OPACITY * g.vis;
    }

    // Desktops: glide to their place, slowly (one taking in many notes at
    // once must not wander); a working one turns as the logo does; the
    // focused or pointed-at one stands a quarter larger
    clockT += dt;
    for (const pl of pilots.values()) {
      const on = focus === pl.d.id, near = on || underPilot === pl.d.id;
      pl.cube.root.position.lerp(pl.at, ease(1.6));
      pl.scale += ((near ? 1.25 : focus ? 0.8 : 1) - pl.scale) * ease(10);
      pl.cube.root.scale.setScalar(DESK_PX / 2 * perPx(pl.cube.root.position) * pl.scale);
      pl.cube.tick(pl.d.phase === "working" && !reduced ? clockT * 1000 + pl.clock : 0);
      pl.vis += ((srch ? THREE.MathUtils.lerp(0.35, 1, searchDim) : focus && !on ? 0.6 : 1) - pl.vis) * k;
      pl.line.opacity = pl.vis;
    }

    // the ties of an opened entity; each pilot's lines to what it's working on
    ties.begin();
    const tieAll = (from: THREE.Vector3, to: number[], v = 1) => { for (const j of to) ties.add(from, P[j]!, c1.copy(col.bg).lerp(col.fg, 0.55 * v), c2.copy(col.bg).lerp(col.fg, 0.4 * v)); };
    for (const s of sources) if (s.vis > 0.01) tieAll(s.at, s.ties, s.vis);
    if (ent) tieAll(P[ent.i]!, ent.ties);
    const named = namedVis();
    if (named > 0.01) tieAll(SP[srcNamed!]!, field.sources[srcNamed!]!.ties, named);
    for (const pl of pilots.values()) {
      const on = focus === pl.d.id, tint = pl.d.phase === "working" ? col.act : col.fg;
      const a = on ? 0.7 : focus ? 0.08 : 0.22;
      for (const j of pl.d.ctx) ties.add(pl.cube.root.position, P[j]!, c1.copy(col.bg).lerp(tint, a), c2.copy(col.bg).lerp(tint, a * 0.6));
    }
    ties.end();

    renderer.render(scene, camera);
    placeLabels();
  };

  type Cand = { L: HTMLDivElement & { w?: number; h?: number; full?: boolean; op?: number }; x: number; y: number; g: number; op: number; full: boolean; pri: number; pointed: boolean };
  const placed: number[][] = [];
  const placeLabels = () => {
    placed.length = 0;
    for (const r of hooks.blockers()) placed.push([r.left - 8, r.top - 8, r.right + 16, r.bottom + 8]);
    // pilot names first: they're the cast; a focused one's solid keeps labels off it
    for (const pl of pilots.values()) {
      const on = focus === pl.d.id;
      // above the cube, clear of its top face as the field's tilt shows it
      toScreen(pl.cube.root.position, s1);
      s1.y -= DESK_PX / 2 * pl.scale * 1.7 + 5;
      if (pl.label.textContent !== nameOf(pl.d)) { pl.label.textContent = nameOf(pl.d); pl.label.w = undefined; }
      pl.label.classList.toggle("working", pl.d.phase === "working");
      const op = !s1.ok || on ? 0 : (focus ? 0.45 : 1) * THREE.MathUtils.lerp(0.4, 1, searchDim);
      pl.label.style.transform = `translate3d(${s1.x.toFixed(1)}px,${s1.y.toFixed(1)}px,0) translate(-50%,-100%)`;
      const o = Math.round(op * 40) / 40;
      if (o !== pl.label.op) { pl.label.style.opacity = String(o); pl.label.style.visibility = o <= 0 ? "hidden" : "visible"; pl.label.op = o; }
      if (op > 0) {
        if (pl.label.w == null) { pl.label.w = pl.label.offsetWidth; pl.label.h = pl.label.offsetHeight; }
        placed.push([s1.x - pl.label.w / 2 - 6, s1.y - pl.label.h! - 4, s1.x + pl.label.w / 2 + 6, s1.y + 4]);
      }
      if (on && s1.ok) {
        toScreen(pl.cube.root.position, s1);
        tB.setFromMatrixColumn(camera.matrixWorld, 0);
        toScreen(tA.copy(pl.cube.root.position).addScaledVector(tB, pl.cube.root.scale.x * 1.8), s2);
        const R = Math.abs(s2.x - s1.x);
        placed.push([s1.x - R, s1.y - R, s1.x + R, s1.y + R]);
      }
    }
    // a source's name, where a pointed dot's goes, ahead of the field's names:
    // right of its dot, or left when a long name would run off the window
    const nameBeside = (L: Src["L"], at: THREE.Vector3 | null, size: number, op: number) => {
      if (at) toScreen(at, s1);
      if (!at || op < 0.04 || !s1.ok) { if (L.op !== 0) place(L, -999, -999, 0); return; }
      if (L.w == null) { L.w = L.offsetWidth; L.h = L.offsetHeight; }
      const g = labelGap(at, size);
      const x = s1.x + g + L.w > W - 12 ? s1.x - g - L.w : s1.x + g;
      place(L, x, s1.y, op);
      placed.push([x - 4, s1.y - L.h! / 2 - 3, x + L.w + 4, s1.y + L.h! / 2 + 3]);
    };
    for (const s of sources) nameBeside(s.L, s.at, hubSize, s.vis);
    // a resting source pointed at, the same way
    if (underSrc != null && underSrc !== srcNamed) {
      srcNamed = underSrc;
      restName.dataset["src"] = String(underSrc);
      restName.firstElementChild!.textContent = srcName(field.sources[underSrc]!.label);
      restName.w = undefined;
    }
    nameBeside(restName, srcNamed == null ? null : SP[srcNamed]!, SRC_SIZE * 1.6, namedVis());
    const cand: Cand[] = [];
    const inHand = srch ? srch.active : ent ? ent.i : null;
    const handText = srch ? srch.text : ent?.text;
    const handCaption = srch ? srch.caption : ent?.caption;
    for (let i = 0; i < N; i++) {
      const n = field.nodes[i]!;
      const related = rl?.j === i;
      const full = related || (i === inHand && handText !== undefined);
      const restOp = n.named && (field.hubs.has(i) || n.memory) ? 1 : 0;
      let op = srch && srch.matches.size ? match[i]! : Math.max(heat[i]!, THREE.MathUtils.lerp(restOp, rel[i]!, dim)) * (srch ? searchDim : 1);
      if (i === inHand || related) op = 1;
      // the dot under the pointer always says its name
      const pointed = point[i]! > 0.04;
      op = Math.max(op, point[i]!);
      const L = labels.get(i);
      if (op < 0.04 && !full) { if (L && L.op !== 0) place(L, -999, -999, 0); continue; }
      const lab = labelOf(i);
      if (lab.full !== full) {
        lab.full = full;
        lab.classList.toggle("full", full);
        say(lab, n.label, related ? rl!.text : full ? handText : undefined, related ? undefined : handCaption);
        lab.w = undefined;
      }
      toScreen(P[i]!, s1);
      if (!s1.ok) { place(lab, -999, -999, 0); continue; }
      // the opened entity's caption is placed first and never moves; a
      // relation then finds room around its tie, ahead of every plain name
      const g = labelGap(P[i]!, (aSize.array as Float32Array)[i]!);
      cand.push({ L: lab, x: s1.x + g, y: s1.y, g, op, full, pointed, pri: (related ? 9e3 : full ? 1e4 : pointed ? 8e3 : 0) + heat[i]! * 2e3 + match[i]! * 400 + Math.log1p(n.degree) * 5 + (n.named ? 20 : 0) });
    }
    cand.sort((a, b) => b.pri - a.pri);
    const rect = (x: number, y: number, w: number, h: number) => [x - 4, y - h / 2 - 3, x + w + 4, y + h / 2 + 3];
    const free = (r: number[]) => !placed.some((p) => r[0]! < p[2]! && r[2]! > p[0]! && r[1]! < p[3]! && r[3]! > p[1]!);
    for (const c of cand) {
      if (c.L.w == null) { c.L.w = c.L.offsetWidth; c.L.h = c.L.offsetHeight; }
      const w = c.L.w, h = c.L.h!;
      // a caption tries right of its dot, then left, then above and below
      // either side, within the window; one with no room anywhere waits
      let at: [number, number][] = [[c.x, c.y]];
      if (c.full) {
        const v = c.g + 1, left = c.x - 2 * c.g - w, up = c.y - h / 2 - v, down = c.y + h / 2 + v;
        at = ([[c.x, c.y], [left, c.y], [c.x - c.g, up], [c.x - c.g, down], [left + c.g, up], [left + c.g, down]] as [number, number][])
          .filter(([x]) => x >= 12 && x + w <= W - 12);
        if (!at.length) at = [[Math.max(12, Math.min(c.x, W - 12 - w)), c.y]];
      }
      const spot = at.find(([x, y]) => free(rect(x, y, w, h)));
      const [x, y] = spot ?? at[0]!;
      if (spot) placed.push(rect(x, y, w, h));
      place(c.L, x, y, spot || c.pointed ? c.op : 0);
    }
  };
  frame();
  void document.fonts?.ready.then(() => { for (const L of labels.values()) L.w = undefined; });

  return {
    overview() { ent = null; focus = null; unrelate(); setGoal({ ...OVERVIEW, az: rig.az }); },
    setPilots(list) {
      const keep = new Set(list.map((d) => d.id));
      for (const [id, pl] of pilots) {
        if (keep.has(id)) continue;
        scene.remove(pl.cube.root); pl.label.remove(); pilots.delete(id);
        for (const m of [pl.line, pl.seam]) { m.dispose(); lineMats.delete(m); }
      }
      for (const d of list) {
        const pl = pilots.get(d.id);
        // re-aim only when its place has really moved, not at every read
        if (pl) { pl.d = d; if (pl.at.distanceTo(tA.set(...d.p)) > 0.6) pl.at.copy(tA); }
        else { const made = makePilot(d); made.cube.root.position.set(...d.p); pilots.set(d.id, made); }
      }
    },
    focusPilot(id) {
      focus = id;
      if (id == null) return;
      ent = null;
      const pl = pilots.get(id);
      if (pl) frameAround([new THREE.Vector3(...pl.d.p), ...pl.d.ctx.map((j) => P[j]!)], 0.5, 2.6, 16, 24);
    },
    openEntity(i, tiesTo = [], text, caption) {
      if (i == null) { ent = null; unrelate(); return; }
      focus = null;
      const same = ent?.i === i;
      if (!same) unrelate();
      ent = { i, ties: tiesTo, text, caption };
      const lab = labels.get(i);
      if (lab) { lab.full = undefined; lab.w = undefined; }
      // new words for the same entity (a streaming summary) leave the camera be
      if (!same) frameAround([P[i]!, ...tiesTo.map((t) => P[t]!)], 0.5, 2.6, 7, 16);
    },
    search(state) {
      if (!state) { srch = null; return; }
      srch = { matches: new Set(state.matches), active: state.active, text: state.text, caption: state.caption };
      const lab = state.active != null ? labels.get(state.active) : undefined;
      if (lab) lab.full = undefined;
      if (state.move === "glide" && state.active != null) glide(P[state.active]!);
      else if (state.move === "frame") frameAround(state.matches.map((m) => P[m]!), 0.55, 3.2, 7, OVERVIEW.dist);
    },
    hover(entities) { hot = entities ? new Set(entities) : null; },
    source(want) {
      const key = want ? `${want.label}\u0000${want.entities.join(",")}` : "";
      // one let go is no longer open, so walking back to it frames it again
      for (const s of sources) { s.want = !!key && s.key === key; if (!s.want) s.open = false; }
      if (!want) return;
      const open = !!want.open;
      const home = !want.path ? null : entityAt.get(want.path) ?? (hooks.sources?.() ? sourceAt.get(want.path) : undefined) ?? null;
      const held = sources.find((s) => s.want);
      if (held) {
        const opening = open && !held.open;
        held.home = home;
        held.open = open;
        sourceLabel(held, want.label, want.text);
        // walked back to: placed anew (one tied to nothing comes to where you are)
        if (opening) { settle(held); follow(held); }
        return;
      }
      // a free slot (or the faintest), so the last one fades out where it was
      const s = sources.reduce((a, b) => (b.vis < a.vis ? b : a));
      Object.assign(s, { key, ties: want.entities, home, want: true, vis: 0, open });
      settle(s);
      sourceLabel(s, want.label, want.text);
      if (open) follow(s);
    },
    relate(j, text) {
      if (j == null || text === undefined) return unrelate();
      if (rl && rl.j !== j) unrelate();
      rl = { j, text };
      const lab = labels.get(j);
      if (lab) { lab.full = undefined; lab.w = undefined; }
    },
    keepView() { kept = viewOf(); },
    returnToView() {
      if (!kept) return false;
      setGoal(kept); kept = null;
      return true;
    },
    shift(px) { shiftGoal = px; },
    camera: () => ({ rig: { ...rig }, vel: { ...vel }, goal: viewOf(), shift: shiftGoal }),
    dragging: () => drag != null,
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect(); mo.disconnect(); schemeMQ.removeEventListener("change", theme);
      canvas.removeEventListener("pointerdown", onDown); canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp); canvas.removeEventListener("wheel", onWheel);
      labelLayer.removeEventListener("click", onLabel); labelLayer.removeEventListener("pointerover", onLabelOver);
      canvas.removeEventListener("pointerleave", onLeave);
      scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); const mat = m.material as THREE.Material | THREE.Material[] | undefined; if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose(); });
      for (const m of lineMats) m.dispose();
    scene.environment?.dispose(); pmrem.dispose(); renderer.dispose();
      canvas.remove(); labelLayer.remove();
    },
  };
}
