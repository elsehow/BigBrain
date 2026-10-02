// The squad view's canvas: the vault's entities as a field of points and its
// memory topics as small glass octahedra. Imperative three.js behind a small
// API; the view (SquadView.svelte) owns every word of chrome and tells this
// what is in play — an opened entity, search matches, a hovered feed row.
// Loaded on demand, so the rest of the app never pays for three.js.
//
// Look (settled in the prototype, 2026-10-02): a long lens and no lens
// effects — a plan, not a cutscene; points not balls; hairline edges; glass
// only for memory; labels appear where attention is and give way to chrome.

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { Field } from "./model";

export interface SceneHooks {
  /** Screen rects labels must stay out of (the view's panels). */
  blockers(): DOMRect[];
}
export interface SquadScene {
  /** Back to the whole field. */
  overview(): void;
  /** Open an entity: it and its ties come forward. `text` is its latest word. */
  openEntity(i: number | null, ties?: number[], text?: string): void;
  /** Search state: null closes it; matches light up; `active` is in hand.
   * `move`: frame every match (a new query), glide to the active one (an
   * arrow key), or hold the camera (its text arriving). */
  search(state: { matches: number[]; active: number | null; text?: string; move: "frame" | "glide" | "none" } | null): void;
  /** A hovered feed row: what it mentions. */
  hover(entities: number[] | null): void;
  /** Pixels to slide the scene's centre right, clear of a left panel. */
  shift(px: number): void;
  dispose(): void;
}

const LENS = Math.tan(THREE.MathUtils.degToRad(17)) / Math.tan(THREE.MathUtils.degToRad(10));
const OVERVIEW_AT = { az: 0.05, el: 0.55, dist: 30, target: new THREE.Vector3(0, 3, -4) };

export function createSquadScene(host: HTMLElement, field: Field, hooks: SceneHooks): SquadScene {
  const OVERVIEW = { ...OVERVIEW_AT, target: OVERVIEW_AT.target.clone() };
  const reducedMQ = matchMedia("(prefers-reduced-motion: reduce)");
  const canvas = document.createElement("canvas");
  canvas.className = "sq-canvas";
  const labelLayer = document.createElement("div");
  labelLayer.className = "sq-labels";
  host.append(canvas, labelLayer);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const camera = new THREE.PerspectiveCamera(20, 1, 0.1, 400);
  const col = { bg: new THREE.Color(), fg: new THREE.Color(), act: new THREE.Color() };
  const fog = { near: { value: 30 }, far: { value: 80 } };

  // ── particles: every entity a point ──────────────────────────────────────
  const N = field.nodes.length;
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute("position", new THREE.Float32BufferAttribute(field.nodes.flatMap((n) => n.p), 3));
  const aSize = new THREE.BufferAttribute(new Float32Array(N), 1);
  const aColor = new THREE.BufferAttribute(new Float32Array(N * 3), 3);
  const aAlpha = new THREE.BufferAttribute(new Float32Array(N), 1);
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
  const baseSize = field.nodes.map((n) => (n.named ? 4.5 + 1.2 * Math.log1p(n.degree) : 1.8 + 0.75 * Math.log1p(n.degree)));
  const P = field.nodes.map((n) => new THREE.Vector3(...n.p));

  // ── lines ────────────────────────────────────────────────────────────────
  const lineSet = (pairs: Array<[THREE.Vector3, THREE.Vector3]>, opacity: number) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pairs.flatMap(([a, b]) => [a.x, a.y, a.z, b.x, b.y, b.z]), 3));
    const m = new THREE.LineBasicMaterial({ transparent: true, opacity, depthWrite: false });
    const l = new THREE.LineSegments(g, m);
    l.renderOrder = 1;
    l.frustumCulled = false;
    scene.add(l);
    return l;
  };
  const strong = lineSet(field.strong.map(([a, b]) => [P[a]!, P[b]!]), 0.14);
  const dynamic = (max: number) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(max * 6), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(max * 6), 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    l.frustumCulled = false;
    l.renderOrder = 2;
    scene.add(l);
    let k = 0;
    return {
      begin() { k = 0; },
      add(a: THREE.Vector3, b: THREE.Vector3, ca: THREE.Color, cb: THREE.Color) {
        if (k >= max) return;
        a.toArray(g.attributes.position!.array, k * 6); b.toArray(g.attributes.position!.array, k * 6 + 3);
        ca.toArray(g.attributes.color!.array, k * 6); cb.toArray(g.attributes.color!.array, k * 6 + 3);
        k++;
      },
      end() { g.setDrawRange(0, k * 2); g.attributes.position!.needsUpdate = true; g.attributes.color!.needsUpdate = true; },
    };
  };
  const ties = dynamic(64);

  // ── glass: memory topics ─────────────────────────────────────────────────
  const octa = new THREE.OctahedronGeometry(1, 0);
  interface Glass { mesh: THREE.Mesh; mat: THREE.MeshPhysicalMaterial; edges: THREE.LineSegments; vis: number }
  const glass = (geo: THREE.BufferGeometry): Glass => {
    const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.06, metalness: 0, transmission: 1, thickness: 1.1, ior: 1.45,
      dispersion: 4, iridescence: 0.15, iridescenceIOR: 1.3, attenuationDistance: 3, flatShading: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 4;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.14 }));
    mesh.add(edges);
    scene.add(mesh);
    return { mesh, mat, edges, vis: 1 };
  };
  const memory = field.nodes.filter((n) => n.memory).map((n) => {
    const g = glass(octa);
    g.mesh.position.set(...n.p);
    g.mesh.scale.setScalar(0.42);
    g.mesh.rotation.y = 0.4;
    return { ...g, i: n.i };
  });

  // ── state ────────────────────────────────────────────────────────────────
  let ent: { i: number; ties: number[]; text?: string } | null = null;
  let srch: { matches: Set<number>; active: number | null; text?: string } | null = null;
  let hot: Set<number> | null = null;
  let shiftGoal = 0, shiftNow = 0;
  const rel = new Float32Array(N), heat = new Float32Array(N), match = new Float32Array(N);
  let dim = 0, searchDim = 1;

  // camera: springs toward a goal, a long lens from further back
  const rig = { az: OVERVIEW.az, el: OVERVIEW.el, dist: OVERVIEW.dist, tx: OVERVIEW.target.x, ty: OVERVIEW.target.y, tz: OVERVIEW.target.z };
  const vel = { az: 0, el: 0, dist: 0, tx: 0, ty: 0, tz: 0 };
  const goal = { az: OVERVIEW.az, el: OVERVIEW.el, dist: OVERVIEW.dist, target: OVERVIEW.target.clone() };
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

  // ── labels: DOM, placed per frame, culled where they'd collide ──────────
  const labels = new Map<number, HTMLDivElement & { w?: number; h?: number; full?: boolean; op?: number }>();
  const labelOf = (i: number) => {
    let L = labels.get(i);
    if (!L) {
      L = document.createElement("div") as HTMLDivElement & { w?: number };
      L.className = "sq-lab sq-node" + (field.nodes[i]!.memory ? " memory" : "");
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = field.nodes[i]!.label;
      const q = document.createElement("span");
      q.className = "q";
      L.append(t, q);
      labelLayer.append(L);
      labels.set(i, L);
    }
    return L;
  };
  const say = (L: HTMLDivElement, name: string, text: string | undefined) => {
    const q = L.querySelector(".q")!;
    if (!text) { q.textContent = ""; return; }
    const at = text.toLowerCase().indexOf(name.toLowerCase());
    q.replaceChildren();
    const b = document.createElement("b");
    if (at >= 0) { b.textContent = text.slice(at, at + name.length); q.append(text.slice(0, at), b, text.slice(at + name.length)); }
    else { b.textContent = name; q.append(b, " · " + text); }
  };
  const place = (L: HTMLElement & { op?: number }, x: number, y: number, op: number) => {
    L.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(0,-50%)`;
    const o = Math.round(op * 40) / 40;
    if (o !== L.op) { L.style.opacity = String(o); L.style.visibility = o <= 0 ? "hidden" : "visible"; L.op = o; }
  };
  const v3 = new THREE.Vector3();
  const toScreen = (p: THREE.Vector3, out: { x: number; y: number; ok: boolean }) => {
    v3.copy(p).project(camera);
    out.x = (v3.x * 0.5 + 0.5) * W; out.y = (-v3.y * 0.5 + 0.5) * H; out.ok = v3.z < 1 && v3.z > -1;
  };

  // ── input ────────────────────────────────────────────────────────────────
  let W = 1, H = 1, drag: { x: number; y: number; moved: number } | null = null;
  const onDown = (e: PointerEvent) => { drag = { x: e.clientX, y: e.clientY, moved: 0 }; canvas.setPointerCapture(e.pointerId); };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy); drag.x = e.clientX; drag.y = e.clientY;
    goal.az -= dx * 0.005; goal.el = THREE.MathUtils.clamp(goal.el + dy * 0.004, 0.08, 1.35);
  };
  const onUp = () => { drag = null; };
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
    // the overview fits the field's width (radius 15, plus room) to the window
    const fit = THREE.MathUtils.clamp(17 / (LENS * Math.tan(THREE.MathUtils.degToRad(10)) * camera.aspect), 22, 46);
    const atRest = !ent && !srch;
    OVERVIEW.dist = fit;
    if (atRest) goal.dist = fit;
    if (!sized) { rig.dist = fit; sized = true; }
  };
  let sized = false;
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const theme = () => {
    const cs = getComputedStyle(host);
    col.bg.set(cs.getPropertyValue("--bg").trim() || "#ffffff");
    col.fg.set(cs.getPropertyValue("--fg").trim() || "#211a18");
    col.act.set(cs.getPropertyValue("--activity").trim() || "#cc4a3e");
    scene.background = col.bg.clone();
    (strong.material as THREE.LineBasicMaterial).color.copy(col.fg);
    for (const g of memory) {
      (g.edges.material as THREE.LineBasicMaterial).color.copy(col.fg);
      // faintly ink-tinted glass, never tinted by state
      g.mat.color.setRGB(1, 1, 1).lerp(col.fg, 0.03);
      g.mat.attenuationColor.copy(col.fg);
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
  const s1 = { x: 0, y: 0, ok: false };
  let raf = 0;
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
    const inPlay: Set<number> | null = srch ? null : ent ? new Set([ent.i, ...ent.ties]) : null;
    const k = ease(9);
    dim += ((inPlay ? 1 : 0) - dim) * k;
    searchDim += ((srch && srch.matches.size ? 0.12 : srch ? 0.5 : 1) - searchDim) * ease(10);
    dust.copy(col.fg).lerp(col.bg, 0.42);
    const sizes = aSize.array as Float32Array, colors = aColor.array as Float32Array, alphas = aAlpha.array as Float32Array;
    for (let i = 0; i < N; i++) {
      const n = field.nodes[i]!;
      rel[i]! += ((inPlay?.has(i) ? 1 : 0) - rel[i]!) * k;
      heat[i]! += ((hot?.has(i) ? 1 : 0) - heat[i]!) * ease(hot?.has(i) ? 18 : 10);
      match[i]! += ((srch?.matches.has(i) ? 1 : 0) - match[i]!) * ease(12);
      if (n.memory) { alphas[i] = 0; continue; }
      const h = Math.max(heat[i]!, match[i]!);
      const r = rel[i]!;
      sizes[i] = baseSize[i]! * (1 + 0.7 * h) * (1 + 0.45 * r * dim);
      const rest = n.named ? 0.95 : 0.6;
      alphas[i] = Math.max(h, THREE.MathUtils.lerp(rest, THREE.MathUtils.lerp(n.named ? 0.22 : 0.12, 1, r), dim)) * THREE.MathUtils.lerp(searchDim, 1, match[i]!);
      c1.copy(n.named || r > 0.5 ? col.fg : dust).lerp(col.act, h * 0.9).toArray(colors, i * 3);
    }
    aSize.needsUpdate = true; aColor.needsUpdate = true; aAlpha.needsUpdate = true;
    (strong.material as THREE.LineBasicMaterial).opacity = 0.14 * searchDim * (1 - 0.5 * dim);

    // memory glass recedes with everything else when something is in play
    for (const g of memory) {
      const linked = inPlay ? field.edges.some(([a, b]) => (a === g.i && inPlay.has(b)) || (b === g.i && inPlay.has(a))) : true;
      g.vis += (THREE.MathUtils.lerp(1, linked ? 1 : 0.3, dim) * THREE.MathUtils.lerp(searchDim, 1, match[g.i]!) - g.vis) * k;
      const tr = g.vis < 0.99;
      if (g.mat.transparent !== tr) { g.mat.transparent = tr; g.mat.depthWrite = !tr; g.mat.needsUpdate = true; }
      g.mat.opacity = g.vis;
      (g.edges.material as THREE.LineBasicMaterial).opacity = 0.14 * g.vis;
    }

    // the ties of an opened entity
    ties.begin();
    if (ent) for (const j of ent.ties) ties.add(P[ent.i]!, P[j]!, c1.copy(col.bg).lerp(col.fg, 0.55), c2.copy(col.bg).lerp(col.fg, 0.4));
    ties.end();

    renderer.render(scene, camera);
    placeLabels();
  };

  type Cand = { L: HTMLDivElement & { w?: number; h?: number; full?: boolean; op?: number }; x: number; y: number; op: number; full: boolean; pri: number };
  const placed: number[][] = [];
  const placeLabels = () => {
    placed.length = 0;
    for (const r of hooks.blockers()) placed.push([r.left - 8, r.top - 8, r.right + 16, r.bottom + 8]);
    const cand: Cand[] = [];
    const inHand = srch ? srch.active : ent ? ent.i : null;
    const handText = srch ? srch.text : ent?.text;
    for (let i = 0; i < N; i++) {
      const n = field.nodes[i]!;
      const full = i === inHand && !!handText;
      const restOp = n.named && (field.hubs.has(i) || n.memory) ? 1 : 0;
      let op = srch && srch.matches.size ? match[i]! : Math.max(heat[i]!, THREE.MathUtils.lerp(restOp, rel[i]!, dim)) * (srch ? searchDim : 1);
      if (i === inHand) op = 1;
      const L = labels.get(i);
      if (op < 0.04 && !full) { if (L && L.op !== 0) place(L, -999, -999, 0); continue; }
      const lab = labelOf(i);
      if (lab.full !== full) {
        lab.full = full;
        lab.classList.toggle("full", full);
        say(lab, n.label, full ? handText : undefined);
        lab.w = undefined;
      }
      toScreen(P[i]!, s1);
      if (!s1.ok) { place(lab, -999, -999, 0); continue; }
      cand.push({ L: lab, x: s1.x + (n.memory ? 16 : 9), y: s1.y, op, full, pri: (full ? 1e4 : 0) + heat[i]! * 2e3 + match[i]! * 400 + Math.log1p(n.degree) * 5 + (n.named ? 20 : 0) });
    }
    cand.sort((a, b) => b.pri - a.pri);
    for (const c of cand) {
      if (c.L.w == null) { c.L.w = c.L.offsetWidth; c.L.h = c.L.offsetHeight; }
      const r = [c.x - 4, c.y - c.L.h! / 2 - 3, c.x + c.L.w + 4, c.y + c.L.h! / 2 + 3];
      let ok = true;
      for (const p of placed) if (r[0]! < p[2]! && r[2]! > p[0]! && r[1]! < p[3]! && r[3]! > p[1]!) { ok = false; break; }
      if (ok) placed.push(r);
      place(c.L, c.x, c.y, ok ? c.op : 0);
    }
  };
  frame();
  void document.fonts?.ready.then(() => { for (const L of labels.values()) L.w = undefined; });

  return {
    overview() { ent = null; setGoal({ ...OVERVIEW, az: rig.az }); },
    openEntity(i, tiesTo = [], text) {
      if (i == null) { ent = null; return; }
      ent = { i, ties: tiesTo, text };
      const lab = labels.get(i);
      if (lab) lab.full = undefined;
      frameAround([P[i]!, ...tiesTo.map((t) => P[t]!)], 0.5, 2.6, 7, 16);
    },
    search(state) {
      if (!state) { srch = null; return; }
      srch = { matches: new Set(state.matches), active: state.active, text: state.text };
      const lab = state.active != null ? labels.get(state.active) : undefined;
      if (lab) lab.full = undefined;
      if (state.move === "glide" && state.active != null) setGoal({ el: 0.5, dist: 9, target: P[state.active]!.clone() });
      else if (state.move === "frame") frameAround(state.matches.map((m) => P[m]!), 0.55, 3.2, 7, OVERVIEW.dist);
    },
    hover(entities) { hot = entities ? new Set(entities) : null; },
    shift(px) { shiftGoal = px; },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect(); mo.disconnect(); schemeMQ.removeEventListener("change", theme);
      canvas.removeEventListener("pointerdown", onDown); canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp); canvas.removeEventListener("wheel", onWheel);
      scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); const mat = m.material as THREE.Material | THREE.Material[] | undefined; if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose(); });
      scene.environment?.dispose(); pmrem.dispose(); renderer.dispose();
      canvas.remove(); labelLayer.remove();
    },
  };
}
