import type { GraphViewState } from '../../../../../lib/graphView';
import { graphIdentityIndex } from '../../../../../lib/graphIdentity';
import { graphView } from './view';
import { VERTEX, FRAGMENT } from './shaders';
import type { GraphData } from '../types';
import { nodeRadius, seedPosition } from '../../../../../lib/graphGeometry';
import { createDisplayLayout } from '../graphDisplayLayout';
import { GRAPH_FOCUS, overviewNodes } from '../graphFocus';
import { memoryThemeLayout } from '../memoryThemeLayout';
import { memoryDomain, memoryDomainDepth, memoryDomainEdge } from '../memoryDomain';
import { importanceScores, FOREGROUND_IMPORTANCE } from '../../../../../lib/graphImportance';
import { memoryHomeDepth } from '../graphHomeDepth';
import { applyOverviewAttention } from '../graphOverviewAttention';
import { fitCamera, revealCamera } from './framing';
import { edgeContrast } from '../graphEdgeContrast';
import { SELECTOR_RATIO } from '../../../../../lib/pilotChatTypes';
import { animatedStatus, graphGeometryKey, needsAttention, phaseCode } from './status';
import { activeContextPilot } from '../graphPilotContext';

import { graphSine, GRAPH_SINE_MS, FOCUS_MOTION, EXPLORE_MOTION } from './motion';
import { GraphCameraController, projectPoint, unprojectPoint, type Point } from './camera';
import { placeGraphLabels, type LabelBox, type LabelCandidate } from './labels';
import { GraphHoverHistory } from '../graphHoverHistory';
import { graphEffects, type EffectPreset } from './effects';

/** One WebGL context with static geometry. Interaction changes upload targets;
 * shaders animate them without per-frame graph traversal or buffer uploads. */
export class GraphRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null>;
  private stateTexture: WebGLTexture;
  private labelTexture: WebGLTexture;
  private edgeTexture: WebGLTexture;
  private edgeFramebuffer: WebGLFramebuffer;
  private edgeSize = [0, 0];
  private reducedMotion = false;
  private homeDepth: Float32Array;
  private homeVisible: Set<number>;
  private overview: Set<number>;
  private geometryKey: string;
  private statusKey = '';
  private labelsKey = '';
  private labels: { i: number; text: string; draft: boolean; key: string; width: number; uv: number[] }[] = [];
  private labelBoxes: LabelBox[] = [];
  private labelData = new Float32Array();
  private nodeData: Float32Array;
  private animatingStatus = false;
  private hasWorkingAgent = false;
  private activityKey = '';
  private activityData = new Float32Array();
  private activityEdges: number[] = [];
  private activityVisible: boolean[] = [];
  private activityMoving: boolean[] = [];
  private hasActivity = false;
  private draft: { id: string; text: string } | null = null;
  private bg = [1, 1, 1];
  private dark = false;
  private lastEffectsFrame: { time: number; camera: { x: number; y: number; zoom: number }; width: number; height: number } | null = null;
  private edgeInk = [.15, .13, .12];
  private edgeOpacity = .3;
  private passes: { vao: WebGLVertexArrayObject; buffer: WebGLBuffer; count: number }[] = [];
  private states: Float32Array;
  private width = 1024;
  private started = 0;
  private selected = -1;
  private view: GraphViewState = { selected: [], excluded: [] };
  private selectedNodes = new Set<number>();
  private excluded = new Set<number>();
  private highlighted = new Set<number>();
  private previous = -1;
  private hovered = -1;
  private edges: number[][];
  private edgeHome: number[] = [];
  private motion = EXPLORE_MOTION;
  private get duration() { return this.motion.duration; }
  private recordCount: number;
  private adjacency: number[][];
  private positions: { x: number; y: number }[];
  private navigation = new GraphCameraController();
  private get camera() { return this.navigation.value; }
  private cameraReady = false;
  private drag: { index: number; depth: number; offset: Point } | null = null;
  private get size() { return { width: this.canvas.clientWidth, height: this.canvas.clientHeight }; }
  private focusCamera: { x: number; y: number; zoom: number } | null = null;
  private centerFocus = false;
  private hoverHistory = new GraphHoverHistory();
  private hoverTargets: Float32Array | null = null;
  private hoverSurface = 0;
  private hoverRestDepth: Float32Array | null = null;
  private hoverVisitHeights = new Map<number, number>();
  private hoverFocusDepth = 0;
  private hoverReturnAt: number | null = null;
  private hoverReturning = false;
  private depthStarted = 0;
  private depthDuration = 0;
  get nextWake() { return this.hoverReturnAt; }
  private clearDepthHistory() { this.hoverReturning = false; this.hoverHistory.clear(); this.hoverTargets = null; this.hoverRestDepth = null; this.hoverVisitHeights.clear(); this.hoverReturnAt = null; }
  private depthCurve(now: number) {
    return this.depthDuration ? graphSine(now - this.depthStarted, this.depthDuration) : this.motion.sample(now - this.started);
  }
  private ids: Map<string, number>;
  private ink = [0.15, 0.13, 0.12];
  private accent = [.8, .2, .15];
  readonly stats = { frames: 0, uploads: 0, statusUploads: 0, inkUploads: 0, labelUploads: 0, labelPlacementUploads: 0, activityUploads: 0, activityDrawCalls: 0, positionUploads: 0, effectDrawCalls: 0, breathingDrawCalls: 0, drawCalls: 0, nodes: 0, edges: 0 };
  constructor(private canvas: HTMLCanvasElement, private graph: GraphData, private inset = { top: 0, bottom: 0 }, private coveredLeft = 0, private effects: EffectPreset = 'none') {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) throw Error('WebGL2 is unavailable');
    this.gl = gl;
    const program = gl.createProgram()!;
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
        const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const message = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw Error(message ?? 'Shader compilation failed'); }
        gl.attachShader(program, shader); gl.deleteShader(shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program) ?? 'Shader linking failed');
    } catch (error) { gl.deleteProgram(program); throw error; }
    this.program = program;
    this.uniforms = Object.fromEntries(['depthSpring', 'nodeCount', 'state', 'stateWidth', 'recordCount', 'spring', 'size', 'camera', 't', 'selected', 'previous', 'hovered', 'pass', 'ink', 'accent', 'bg', 'time', 'reduced', 'labels', 'edges', 'edgeOpacity', 'edgeInk', 'nodeScale', 'oldCamera', 'oldSpring', 'motionScale'].map(n => [n, gl.getUniformLocation(program, `u_${n}`)]));
    this.geometryKey = graphGeometryKey(graph);
    this.ids = graphIdentityIndex(graph.nodes);
    this.adjacency = graph.nodes.map(() => []);
    const edges = this.edges = graph.edges.flatMap(e => { const a = this.ids.get(e.source), b = this.ids.get(e.target); return a === undefined || b === undefined ? [] : [[a, b]]; });
    for (const [a, b] of edges) { this.adjacency[a!]!.push(b!); this.adjacency[b!]!.push(a!); }
    const importance = importanceScores(this.adjacency, graph.nodes.map(n => n.group === 'memory'), Uint8Array.from(graph.nodes, n => n.live ? 1 : 0), graph.nodes.map(n => n.memorySupport ?? 0));
    const overview = overviewNodes(importance, GRAPH_FOCUS.overviewCount, graph.nodes.map(n => n.id), this.adjacency, GRAPH_FOCUS.preferConnected);
    this.homeVisible = new Set(graph.nodes.flatMap((_, i) => overview[i] ? [i] : []));
    this.overview = new Set(this.homeVisible);
    applyOverviewAttention(graph.nodes.map(n => ({ ...n, unread: n.readState?.unread === true })), this.homeVisible, new Set(), true);
    graph.nodes.forEach((n, i) => { if (n.group === 'memory') this.homeVisible.add(i); });
    this.homeDepth = memoryHomeDepth(graph.nodes.map(n => n.group), this.adjacency);
    graph.nodes.forEach((n, i) => { if (activeContextPilot(n)) this.homeDepth[i] = 80; });
    const display = createDisplayLayout()(graph, GRAPH_FOCUS);
    this.positions = memoryThemeLayout(graph.nodes.map((n, i) => ({ ...n, ...(display[i] ?? { x: seedPosition(i)[0], y: seedPosition(i)[1] }) })), this.adjacency);
    this.recordCount = graph.nodes.length + edges.length + 1;
    this.states = new Float32Array(this.width * Math.max(1, Math.ceil(this.recordCount * 2 / this.width)) * 4);
    graph.nodes.forEach((_, i) => { this.states[i * 4] = this.states[i * 4 + 1] = this.homeDepth[i]!; this.states[i * 4 + 2] = this.states[i * 4 + 3] = Number(this.homeVisible.has(i)); });
    edges.forEach((_, i) => { const k = (graph.nodes.length + i) * 4; this.states[k] = this.states[k + 1] = 1; });
    this.states[(this.recordCount - 1) * 4] = this.states[(this.recordCount - 1) * 4 + 1] = 1;
    this.positions.forEach((p, i) => { const k = (this.recordCount + i) * 4; this.states[k + 2] = p.x; this.states[k + 3] = p.y; });
    this.stateTexture = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.width, this.states.length / 4 / this.width, 0, gl.RGBA, gl.FLOAT, this.states);
    const row = (i: number) => {
      const n = graph.nodes[i]!;
      const ink = this.homeDepth[i]! < -18 ? .18 : 1;
      // a_node.x / a_other.w hold the previous/next hover-neighborhood emphasis.
      return [0, this.homeDepth[i]!, (n.group === 'memory' ? 8 : nodeRadius(n.degree)), n.pilotPhase ? (n.group === 'agent' ? 3 : 2) : n.group === 'memory' ? 1 : 0, i, 0, 0, 0, n.degree >= 5 || n.group === 'memory' || n.pilotPhase ? 1 : .55, ink, 0, ink];
    };
    let edgeIndex = 0;
    this.passes.push(this.buffer(graph.edges.flatMap(e => {
      const a = this.ids.get(e.source), b = this.ids.get(e.target);
      if (a === undefined || b === undefined) return [];
      const p = this.positions[a]!, q = this.positions[b]!;
      const band = Math.round(Math.min(1, Math.log2(Math.max(1, e.weight ?? 1)) / 3) * 3);
      const presence = (score: number) => { const t = Math.max(0, Math.min(1, (score - FOREGROUND_IMPORTANCE + .18) / .36)); return t * t * (3 - 2 * t); };
      const high = presence(Math.max(importance[a]!, importance[b]!));
      const low = presence(Math.min(importance[a]!, importance[b]!));
      const salience = .035 + .965 * high * (.35 + .65 * low);
      const homeInk = graph.nodes[a]!.group === 'memory' || graph.nodes[b]!.group === 'memory' ? Math.max(.45, salience) : .06 * salience;
      this.edgeHome.push(homeInk);
      const stateIndex = graph.nodes.length + edgeIndex++;
      this.states[stateIndex * 4] = this.states[stateIndex * 4 + 1] = homeInk;
      return [p.x, p.y, [.65,.85,1.05,1.35][band]!, 0, a, q.x, q.y, b, homeInk, Math.min(1, [.08,.16,.26,.4][band]! / .24), stateIndex, 0];
    })));
    this.edgeTexture = this.texture();
    this.edgeFramebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.edgeFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.edgeTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.nodeData = new Float32Array(graph.nodes.flatMap((_, i) => row(i)));
    this.passes.push(this.buffer(Array.from(this.nodeData)));
    this.passes.push(this.buffer([]));
    this.labelTexture = this.texture(); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // One optional instanced foreground pass, with one boundary-trimmed line per real agent edge.
    this.passes.push(this.buffer([]));
    this.update(graph);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST); gl.clearColor(0, 0, 0, 0);
    this.stats.nodes = graph.nodes.length; this.stats.edges = edges.length;
    gl.bindTexture(gl.TEXTURE_2D, this.stateTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.states.length / 4 / this.width, gl.RGBA, gl.FLOAT, this.states);
    this.setPalette();
  }
  private texture() {
    const gl = this.gl, texture = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return texture;
  }
  private buffer(data: number[]) {
    const gl = this.gl, vao = gl.createVertexArray()!, buffer = gl.createBuffer()!; gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    for (let i = 0; i < 3; i++) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 48, i * 16); gl.vertexAttribDivisor(i, 1); }
    return { vao, buffer, count: data.length / 12 };
  }
  /** Called on data changes, never per animation frame. False means new topology. */
  update(graph: GraphData, draft: { id: string; text: string } | null = null) {
    if (graphGeometryKey(graph) !== this.geometryKey) return false;
    const visibilityChanged = graph.nodes.some((n, i) => n.readState?.unread !== this.graph.nodes[i]!.readState?.unread);
    this.graph = graph; this.draft = draft;
    const activityKey = JSON.stringify(graph.nodes.map(n => [activeContextPilot(n), n.pilotPhase]));
    const activityChanged = activityKey !== this.activityKey;
    if (activityChanged) {
      this.activityKey = activityKey;
      const natural = memoryHomeDepth(graph.nodes.map(n => n.group), this.adjacency);
      graph.nodes.forEach((n, i) => {
        const depth = activeContextPilot(n) ? 80 : natural[i]!;
        const delta = depth - this.homeDepth[i]!;
        if (!delta) return;
        this.homeDepth[i] = this.nodeData[i * 12 + 1] = depth;
        // Lifecycle changes release the old foreground plane even in an
        // excavation, without discarding the rest of the exploration history.
        if (this.hoverRestDepth) this.hoverRestDepth[i] += delta;
        if (this.hoverTargets) this.hoverTargets[i] += delta;
        if (this.hoverVisitHeights.has(i)) this.hoverVisitHeights.set(i, this.hoverVisitHeights.get(i)! + delta);
      });
    }
    const statusKey = JSON.stringify(graph.nodes.map(n => [phaseCode(n), needsAttention(n)]));
    if (statusKey !== this.statusKey) {
      this.statusKey = statusKey;
      graph.nodes.forEach((n, i) => { this.nodeData[i * 12 + 5] = phaseCode(n); this.nodeData[i * 12 + 6] = Number(needsAttention(n)); });
      const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.passes[1]!.buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.nodeData); this.stats.statusUploads++;
    }
    this.updateLabels();
    if (visibilityChanged || activityChanged) {
      this.homeVisible = new Set(this.overview);
      applyOverviewAttention(graph.nodes.map(n => ({ ...n, unread: n.readState?.unread === true })), this.homeVisible, new Set(), true,
        // All actual connections of active agents stay visible, including
        // endpoints outside the compact overview. This does not recurse.
        this.edges.map(([a, b]) => ({ a: a!, b: b!, pilotContext: true })));
      graph.nodes.forEach((n, i) => { if (n.group === 'memory') this.homeVisible.add(i); });
      this.cachedBounds = undefined;
      if (this.cameraReady) {
        this.previous = this.selected; this.retarget(performance.now(), this.reducedMotion);
      } else {
        graph.nodes.forEach((_, i) => { this.states[i * 4 + 2] = this.states[i * 4 + 3] = Number(this.homeVisible.has(i)); });
        this.updateActivity();
        this.activityVisible.forEach((visible, i) => { const k = (graph.nodes.length + i) * 4; this.states[k + 2] = this.states[k + 3] = Number(visible); });
      }
    }
    this.updateAnimation();
    return true;
  }
  setEffects(effects: EffectPreset) { this.effects = effects; }
  setViewport(inset: { top: number; bottom: number }, coveredLeft: number) { this.inset = inset; this.coveredLeft = coveredLeft; }
  private updateAnimation() {
    this.hasWorkingAgent = this.graph.nodes.some((n, i) => n.pilotPhase === 'working' && this.states[i * 4 + 3]! > 0);
    this.animatingStatus = this.graph.nodes.some((n, i) => animatedStatus(n) && this.states[i * 4 + 3]! > 0)
      || this.activityMoving.some((moving, i) => moving && this.activityVisible[i]);
  }
  private updateActivity() {
    const nodes = this.graph.nodes;
    this.activityVisible = this.edges.map(([a, b]) =>
      (activeContextPilot(nodes[a!]!) || activeContextPilot(nodes[b!]!))
      && this.states[a! * 4 + 3]! > 0 && this.states[b! * 4 + 3]! > 0);
    this.activityMoving = [...this.activityVisible];
    this.hasActivity = this.activityVisible.some(Boolean);
    const data: number[] = []; this.activityEdges = [];
    const radius = (i: number) => nodes[i]!.pilotPhase ? -nodeRadius(nodes[i]!.degree) - (nodes[i]!.group === 'agent' ? 200 : 0) - (nodes[i]!.pilotPhase === 'working' ? 100 : 0) : nodes[i]!.group === 'memory' ? 108 : nodeRadius(nodes[i]!.degree);
    this.edges.forEach(([a, b], index) => {
      const agent = nodes[a!]!.pilotPhase ? a! : nodes[b!]!.pilotPhase ? b! : -1;
      if (agent < 0) return;
      this.activityEdges.push(index);
      const p = this.positions[a!]!, q = this.positions[b!]!;
      data.push(p.x, p.y, 0, agent, a!, q.x, q.y, b!, radius(a!), radius(b!), nodes.length + index, Number(this.activityMoving[index]));
    });
    // Selection changes usually only change texture opacity and uniforms.
    if (data.length === this.activityData.length && data.every((n, i) => Math.fround(n) === this.activityData[i])) return;
    this.activityData = new Float32Array(data);
    const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.passes[3]!.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.activityData, gl.STATIC_DRAW); this.passes[3]!.count = data.length / 12; this.stats.activityUploads++;
  }
  private updateLabels() {
    const nodes = this.graph.nodes;
    const named = new Set(nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.group === 'memory')
      .sort((a, b) => b.n.degree - a.n.degree).slice(0, 64).map(({ i }) => i));
    for (const i of [this.selected, this.previous, this.hovered, ...this.selectedNodes, ...this.highlighted]) if (i >= 0) named.add(i);
    const labels = [...named].map(i => ({ i, text: nodes[i]!.title, draft: false }));
    nodes.forEach((n, i) => {
      const draft = this.draft?.id === n.id ? this.draft.text : n.pilotDraft;
      if (n.pilotPhase === 'draft' && draft && labels.length < 100)
        labels.push({ i, text: draft.replace(/\s+/g, ' ').slice(0, 65), draft: true });
    });
    const font = getComputedStyle(document.documentElement).getPropertyValue('--font-app').trim() || 'system-ui, sans-serif';
    const key = JSON.stringify([font, labels]);
    if (key === this.labelsKey) return;
    this.labelsKey = key;
    const atlas = document.createElement('canvas'); atlas.width = 2048; atlas.height = Math.max(64, Math.ceil(labels.length / 2) * 40);
    const ctx = atlas.getContext('2d')!; ctx.font = `22px ${font}`; ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
    this.labels = labels.map(({ i, text, draft }, index) => {
      const x = index % 2 * 1024, y = Math.floor(index / 2) * 40;
      let name = draft || text.length <= 32 ? text : text.slice(0, 31) + '…';
      while (ctx.measureText(name).width > (draft ? 994 : 460)) name = name.slice(0, -2) + '…';
      const size = Math.ceil(ctx.measureText(name).width) + 28;
      ctx.fillText(name, x + 14, y + 20);
      return { i, text: name, draft, key: `${i}:${Number(draft)}`, width: size / 2,
        uv: [x / atlas.width, y / atlas.height, (x + size) / atlas.width, (y + 40) / atlas.height] };
    });
    const gl = this.gl; gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.labelTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    this.stats.labelUploads++;
  }
  private placeLabels(now: number) {
    const t = this.reducedMotion ? 1 : this.progress(now), nodes = this.graph.nodes;
    const candidates: LabelCandidate[] = this.labels.map(label => {
      const { i, draft, key, width } = label, n = nodes[i]!, state = this.sample(i, now);
      const memory = n.group === 'memory', hovered = i === this.hovered || this.highlighted.has(i), selected = this.selectedNodes.has(i);
      const wanted = (selection: number) => selection === i || memory && selection < 0 ? 1 : 0;
      const opacity = (draft || hovered || selected ? 1 : wanted(this.previous) * (1 - t) + wanted(this.selected) * t) * state.alpha;
      const point = projectPoint(this.positions[i]!, state.x, this.camera, this.size);
      const radius = Math.max(n.pilotPhase ? 6 : 3, (memory ? 8 : nodeRadius(n.degree)) * Math.min(1, Math.sqrt(this.camera.zoom)) * 600 / (600 - state.x));
      return { key, index: i, ...point, width, opacity, above: hovered && !selected && !memory,
        gap: draft ? radius * SELECTOR_RATIO + 25 : radius * (selected || hovered || n.pilotPhase ? SELECTOR_RATIO : 1) + 4,
        priority: selected && !draft ? 0 : hovered && !draft ? 1 : draft ? 2 : memory ? 3 : 4 };
    });
    this.labelBoxes = placeGraphLabels(candidates, this.size);
    const byKey = new Map(this.labels.map(label => [label.key, label]));
    const data = new Float32Array(this.labelBoxes.flatMap(box => {
      const label = byKey.get(box.key)!, n = nodes[box.index]!;
      return [0, .45 + .4 * Math.min(1, n.degree / 12), box.width, n.pilotPhase && n.pilotPhase !== 'idle' && !label.draft ? 2 : 1,
        box.index, box.left + box.width / 2 - box.x, box.top + box.height / 2 - box.y, box.opacity, ...label.uv];
    }));
    if (data.length === this.labelData.length && data.every((value, i) => value === this.labelData[i])) return;
    this.labelData = data;
    const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.passes[2]!.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW); this.passes[2]!.count = data.length / 12;
    this.stats.labelPlacementUploads++;
  }

  setPalette() {
    const style = getComputedStyle(document.documentElement), c = document.createElement('canvas'), ctx = c.getContext('2d')!; c.width = c.height = 1;
    const parse = (name: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = style.getPropertyValue(name).trim() || '#222'; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3).map(n => n / 255); };
    this.dark = style.colorScheme === 'dark';
    this.ink = parse('--mark'); this.accent = parse('--activity'); this.bg = parse('--bg');
    const contrast = edgeContrast(this.ink.map(c => c * 255), this.bg.map(c => c * 255));
    this.edgeInk = contrast.color.map(c => c / 255); this.edgeOpacity = contrast.opacity;
  }
  private progress(now: number) { return 1 - this.motion.sample(now - this.started).position; }
  private sample(i: number, now: number) {
    const k = i * 4, v = (this.recordCount + i) * 4, c = this.motion.sample(now - this.started);
    const depth = i < this.graph.nodes.length ? this.depthCurve(now) : c;
    const dx = this.states[k]! - this.states[k + 1]!, da = this.states[k + 2]! - this.states[k + 3]!;
    return { x: this.states[k + 1]! + dx * depth.position + this.states[v]! * depth.velocity,
      alpha: Math.max(0, Math.min(1, this.states[k + 3]! + da * c.position + this.states[v + 1]! * c.velocity)),
      vx: dx * depth.positionRate + this.states[v]! * depth.velocityRate,
      va: da * c.positionRate + this.states[v + 1]! * c.velocityRate };
  }
  private retain(i: number, now: number) {
    const p = this.sample(i, now), k = i * 4, v = (this.recordCount + i) * 4;
    this.states[k] = p.x; this.states[k + 2] = p.alpha;
    this.states[v] = p.vx; this.states[v + 1] = p.va;
  }
  pan(delta: Point, now = performance.now()) { this.navigation.pan(delta, now); }
  zoomAt(pointer: Point, factor: number, now = performance.now()) {
    const hit = this.pick(pointer.x, pointer.y), i = hit ? this.ids.get(hit) : undefined;
    const depth = i === undefined ? 0 : this.sample(i, now).x;
    this.navigation.zoomAt(pointer, factor, depth, this.size, now);
  }
  refit(now = performance.now()) {
    this.clearDepthHistory(); this.focusCamera = null;
    this.navigation.resume(now);
    this.previous = this.selected; this.selected = this.hovered = -1;
    this.view = { selected: [], excluded: [] }; this.selectedNodes.clear(); this.excluded.clear();
    this.retarget(now, this.reducedMotion);
  }
  beginNodeDrag(id: string, pointer: Point, now = performance.now()) {
    const i = this.ids.get(id); if (i === undefined) return;
    this.navigation.grab(now);
    const depth = this.sample(i, now).x;
    const point = projectPoint(this.positions[i]!, depth, this.camera, this.size);
    this.drag = { index: i, depth, offset: { x: point.x - pointer.x, y: point.y - pointer.y } };
    // Hold this node's height under the hand; all other springs keep running.
    this.states[i * 4] = this.states[i * 4 + 1] = depth;
    this.states[(this.recordCount + i) * 4] = 0;
    this.uploadRecord(i); this.uploadRecord(this.recordCount + i);
  }
  dragNode(pointer: Point) {
    if (!this.drag) return;
    const { index, depth, offset } = this.drag;
    const p = unprojectPoint({ x: pointer.x + offset.x, y: pointer.y + offset.y }, depth, this.camera, this.size);
    this.positions[index] = p;
    const k = (this.recordCount + index) * 4;
    this.states[k + 2] = p.x; this.states[k + 3] = p.y;
    this.uploadRecord(this.recordCount + index); this.stats.positionUploads++;
    this.cachedBounds = undefined;
  }
  endNodeDrag(now = performance.now()) {
    if (!this.drag) return;
    this.drag = null; this.previous = this.selected;
    this.retarget(now, this.reducedMotion);
  }
  private uploadRecord(index: number) {
    const gl = this.gl; gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.stateTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, index % this.width, Math.floor(index / this.width), 1, 1, gl.RGBA, gl.FLOAT, this.states.subarray(index * 4, index * 4 + 4));
  }
  select(id: string | null, now = performance.now(), reduced = false) {
    this.setView({ selected: id ? [id] : [], excluded: [] }, id, now, reduced);
  }
  setView(view: GraphViewState, focus: string | null = null, now = performance.now(), reduced = false, centerFocus = false) {
    const next = graphView(this.graph.nodes, this.adjacency, view, focus);
    if (JSON.stringify(next.view) === JSON.stringify(this.view) && next.anchor === this.selected
      && reduced === this.reducedMotion && centerFocus === this.centerFocus && !this.navigation.manual && !this.hoverTargets && !this.hoverReturning && this.hovered < 0) return;
    this.clearDepthHistory();
    this.view = next.view; this.selectedNodes = next.selected; this.excluded = next.excluded;
    this.reducedMotion = reduced; this.hovered = -1;
    this.centerFocus = centerFocus;
    this.navigation.resume(now);
    this.focusCamera = next.anchor >= 0 && this.cameraReady ? { ...this.camera } : null;
    this.previous = this.selected; this.selected = next.anchor;
    this.retarget(now, reduced);
  }
  highlight(ids: readonly (string | null)[], now = performance.now()) {
    const next = new Set(ids.flatMap(id => id && this.ids.has(id) ? [this.ids.get(id)!] : []).filter(i => !this.excluded.has(i)));
    if (next.size === this.highlighted.size && [...next].every(i => this.highlighted.has(i))) return;
    this.highlighted = next;
    // App-driven inspection is a light only: no hover history or camera flight.
    this.previous = this.selected; this.retarget(now, this.reducedMotion);
  }
  hover(id: string | null, now = performance.now()) {
    const candidate = id ? this.ids.get(id) ?? -1 : -1;
    const hovered = this.excluded.has(candidate) ? -1 : candidate;
    if (hovered === this.hovered) return;
    if (this.hoverReturning && now >= this.depthStarted + this.depthDuration) this.clearDepthHistory();
    if (hovered >= 0 && !this.navigation.manual && this.navigation.animating(now)) {
      // Pointer exploration takes over a flight at the last displayed camera.
      this.navigation.grab(this.lastEffectsFrame?.time ?? now);
    }
    if (!this.reducedMotion && hovered >= 0) {
      const ids = this.graph.nodes.map(n => n.id), held = this.sample(hovered, now).x;
      if (!this.hoverRestDepth) {
        this.hoverSurface = held;
        this.hoverRestDepth = Float32Array.from(this.graph.nodes, (_, i) => this.states[i * 4 + 1]!);
        this.hoverFocusDepth = this.selected >= 0 ? this.states[this.selected * 4 + 1]! : 0;
      }
      for (const i of [hovered, ...this.adjacency[hovered]!]) this.hoverVisitHeights.set(i, Math.max(this.sample(i, now).x, this.hoverSurface));
      this.hoverVisitHeights.set(hovered, held);
      this.hoverHistory.enter([hovered, ...this.adjacency[hovered]!].map(i => ids[i]!), ids, now);
      const offsets = this.hoverHistory.sample(ids, now + 350).offsets;
      this.hoverTargets = Float32Array.from(offsets, (offset, i) => offset <= -80
        ? Math.min(this.hoverRestDepth![i]!, this.hoverSurface) + offset : this.hoverVisitHeights.get(i)! + offset);
      this.hoverTargets[hovered] = held;
      this.hoverReturnAt = null; this.hoverReturning = false;
    } else if (this.hoverTargets && this.hovered >= 0) {
      this.hoverHistory.leave(now); this.hoverReturnAt = now + this.hoverHistory.holdMs;
    }
    this.hovered = hovered; this.previous = this.selected;
    this.retarget(now, this.reducedMotion);
  }
  private retarget(now: number, reduced: boolean, depthDuration?: number) {
    this.lastEffectsFrame = null;
    const selected = this.selected, hovered = this.hovered, inkProgress = this.progress(now);
    const hoverNeighborhood = new Set(hovered >= 0 ? [hovered, ...this.adjacency[hovered]!] : []);
    const root = selected >= 0 ? selected : hovered;
    const domain = root >= 0 ? memoryDomain(this.adjacency, root, this.excluded) : null;
    const domains = [...this.selectedNodes].filter(i => i !== root).map(i => memoryDomain(this.adjacency, i, this.excluded));
    const held = new Set([...this.selectedNodes, ...domains.flatMap(d => [...d.direct])]);
    const emphasized = new Set([...hoverNeighborhood, ...this.highlighted]);
    for (const i of this.highlighted) for (const neighbor of this.adjacency[i]!) emphasized.add(neighbor);
    const memory = root >= 0 && this.graph.nodes[root]!.group === 'memory';
    this.graph.nodes.forEach((n, i) => {
      const k = i * 4; this.retain(i, now);
      const offset = !domain ? 0 : memory ? memoryDomainDepth(domain, i, hovered, this.adjacency)
        : i === root || i === hovered ? 0 : domain.direct.has(i) ? -12 : -240;
      // Preserve the home silhouette: focus keeps its own depth, while the
      // unrelated background steps back a little instead of changing planes.
      this.states[k + 1] = this.homeDepth[i]! + (domain && i !== root && !domain.direct.has(i) && !held.has(i) ? offset * .25 : 0);
      if (this.hoverTargets) this.states[k + 1] = this.hoverTargets[i]!;
      const active = activeContextPilot(n);
      if (active) this.states[k + 1] = 80;
      if (reduced) this.states[k + 1] = 0;
      if ((i === hovered && this.hoverTargets) || reduced) {
        this.states[(this.recordCount + i) * 4] = 0;
      }
      const inkIndex = i * 12, baseline = this.homeDepth[i]! < -18 ? .18 : 1;
      this.nodeData[inkIndex + 10] = Number(this.selectedNodes.has(i));
      this.nodeData[inkIndex] += (this.nodeData[inkIndex + 7]! - this.nodeData[inkIndex]!) * inkProgress;
      this.nodeData[inkIndex + 7] = Number(emphasized.has(i));
      this.nodeData[inkIndex + 9] += (this.nodeData[inkIndex + 11]! - this.nodeData[inkIndex + 9]!) * inkProgress;
      this.nodeData[inkIndex + 11] = active || i === root || i === hovered || held.has(i) ? 1
        : (this.hoverTargets && this.hoverVisitHeights.has(i)) || domain?.direct.has(i) ? Math.max(baseline, .7) : baseline;
      if (this.drag?.index === i) {
        this.states[k] = this.states[k + 1] = this.drag.depth;
        this.states[(this.recordCount + i) * 4] = 0;
      }
      const member = emphasized.has(i) || held.has(i) || domains.some(d => this.graph.nodes[d.root]!.group === 'memory' && d.second.has(i)) || hoverNeighborhood.has(i) || this.homeVisible.has(i) || !!this.hoverTargets && this.hoverVisitHeights.has(i) || !!domain && (i === root || domain.direct.has(i) || memory && domain.second.has(i));
      const opacityOffset = active || emphasized.has(i) || held.has(i) ? 0 : this.hoverTargets ? this.hoverVisitHeights.has(i) ? 0 : selected < 0 ? -80 : offset * (100 / 240) : offset * (100 / 240);
      this.states[k + 3] = Number(member && !this.excluded.has(i)) * (1 - .92 * Math.max(0, Math.min(1, (-opacityOffset - 24) / 216)));
    });
    const density = 1 / Math.sqrt(Math.max(1, domain ? this.adjacency[root]!.length / 30 : 0, hovered >= 0 ? this.adjacency[hovered]!.length / 30 : 0));
    this.updateActivity();
    this.retain(this.recordCount - 1, now);
    this.states[(this.recordCount - 1) * 4 + 1] = density;
    this.edges.forEach(([a, b], index) => {
      const k = (this.graph.nodes.length + index) * 4;
      this.retain(this.graph.nodes.length + index, now);
      this.states[k + 3] = Number(this.activityVisible[index]);
      this.states[k + 1] = a === hovered || b === hovered || this.highlighted.has(a!) || this.highlighted.has(b!) ? 1
        : domains.some(d => (a === d.root || d.direct.has(a!)) && (b === d.root || d.direct.has(b!)))
          ? this.selectedNodes.has(a!) || this.selectedNodes.has(b!) ? 1 : this.edgeHome[index]! : !domain ? this.edgeHome[index]!
        : memory ? memoryDomainEdge(domain, a!, b!, hovered)
        : Number((a === root || domain.direct.has(a!)) && (b === root || domain.direct.has(b!))
          || (a === hovered || b === hovered) && (domain.direct.has(a!) || domain.direct.has(b!)))
          * (a === root || b === root || a === hovered || b === hovered ? 1 : this.edgeHome[index]!);
    });
    this.depthDuration = reduced ? 0 : depthDuration ?? (this.hoverTargets ? GRAPH_SINE_MS : this.hoverReturning ? Math.max(0, this.depthStarted + this.depthDuration - now) : 0);
    this.depthStarted = now;
    // Sample the previous curve before changing its duration on an interruption.
    this.motion = this.hoverTargets || this.hoverReturning || hovered >= 0 ? EXPLORE_MOTION : FOCUS_MOTION;
    this.started = reduced ? now - this.duration : now;
    const gl = this.gl; gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.stateTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.states.length / 4 / this.width, gl.RGBA, gl.FLOAT, this.states); this.stats.uploads++;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.passes[1]!.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.nodeData); this.stats.inkUploads++;
    this.updateAnimation();
    this.updateLabels();
  }
  private followCamera(now: number) {
    if (this.navigation.manual) { this.navigation.advance(now, this.size); return; }
    const { width: w, height: h } = this.size;
    const xs = this.bounds;
    let fit = fitCamera({ minX: xs[0]!, minY: xs[1]!, maxX: xs[2]!, maxY: xs[3]! }, { w, h, ...this.inset });
    if (this.selected >= 0) {
      if (this.focusCamera) fit = { scale: this.focusCamera.zoom, tx: w / 2 - this.focusCamera.x * this.focusCamera.zoom, ty: h / 2 - this.focusCamera.y * this.focusCamera.zoom };
      const p = this.positions[this.selected]!, z = this.hoverTargets ? this.hoverFocusDepth : this.states[this.selected * 4 + 1]!, m = 600 / (600 - z);
      const x = w / 2 + (p.x * fit.scale + fit.tx - w / 2) * m;
      const y = h / 2 + (p.y * fit.scale + fit.ty - h / 2) * m - z * .6;
      const cy = this.inset.top + Math.max(1, h - this.inset.top - this.inset.bottom) / 2;
      const cx = (Math.min(this.coveredLeft, w) + w) / 2;
      fit = revealCamera(fit, { x, y }, {
        minX: this.centerFocus ? cx : Math.min(cx, this.coveredLeft + 80), maxX: this.centerFocus ? cx : Math.max(cx, w - 80),
        minY: this.centerFocus ? cy : Math.min(cy, this.inset.top + 80), maxY: this.centerFocus ? cy : Math.max(cy, h - this.inset.bottom - 80),
      }, m);
    }
    const target = { x: (w / 2 - fit.tx) / fit.scale, y: (h / 2 - fit.ty) / fit.scale, zoom: fit.scale };
    this.navigation.follow(target, now, this.reducedMotion, this.selected >= 0 ? FOCUS_MOTION : EXPLORE_MOTION);
    this.cameraReady = true;
  }
  draw(now: number) {
    if (this.hoverReturning && now >= this.depthStarted + this.depthDuration) this.clearDepthHistory();
    if (this.hoverReturnAt !== null && now >= this.hoverReturnAt) {
      this.hoverReturnAt = null; this.hoverTargets = null; this.hoverReturning = true;
      this.retarget(now, this.reducedMotion, this.hoverHistory.returnMs);
    }
    const gl = this.gl, w = this.canvas.clientWidth, h = this.canvas.clientHeight, dpr = devicePixelRatio || 1;
    if (!w || !h || gl.isContextLost()) return false;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    }
    if (this.edgeSize[0] !== this.canvas.width || this.edgeSize[1] !== this.canvas.height) {
      this.edgeSize = [this.canvas.width, this.canvas.height];
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.edgeTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.canvas.width, this.canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    this.followCamera(now);
    this.placeLabels(now);
    const effects = graphEffects(this.effects), old = this.lastEffectsFrame;
    const recent = old && now > old.time && now - old.time < 100 && old.width === w && old.height === h;
    const trails = effects.trails && !this.reducedMotion && !!recent && (now - this.started < this.duration || now - this.depthStarted < this.depthDuration ||
      old.camera.x !== this.camera.x || old.camera.y !== this.camera.y || old.camera.zoom !== this.camera.zoom);
    this.lastEffectsFrame = { time: now, camera: { ...this.camera }, width: w, height: h };
    gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.clear(gl.COLOR_BUFFER_BIT); gl.useProgram(this.program);
    const u = this.uniforms;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.stateTexture); gl.uniform1i(u.state!, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.labelTexture); gl.uniform1i(u.labels!, 1);
    const spring = this.motion.sample(now - this.started);
    const depth = this.depthCurve(now); gl.uniform2f(u.depthSpring!, depth.position, depth.velocity); gl.uniform1i(u.nodeCount!, this.graph.nodes.length);
    gl.uniform2f(u.spring!, spring.position, spring.velocity); gl.uniform1i(u.recordCount!, this.recordCount);
    gl.uniform1i(u.stateWidth!, this.width); gl.uniform2f(u.size!, w, h); gl.uniform3f(u.camera!, this.camera.x, this.camera.y, this.camera.zoom);
    gl.uniform1f(u.t!, this.progress(now)); gl.uniform1f(u.selected!, this.selected); gl.uniform1f(u.previous!, this.previous); gl.uniform1f(u.hovered!, this.hovered);
    if (trails && old) {
      const previousSpring = this.depthCurve(old.time);
      gl.uniform3f(u.oldCamera!, old.camera.x, old.camera.y, old.camera.zoom);
      gl.uniform2f(u.oldSpring!, previousSpring.position, previousSpring.velocity);
      gl.uniform1f(u.motionScale!, Math.min(8, 100 / (now - old.time)));
    }
    gl.uniform1f(u.nodeScale!, Math.min(1, Math.sqrt(this.camera.zoom)));
    gl.uniform3fv(u.edgeInk!, this.edgeInk); gl.uniform1f(u.edgeOpacity!, this.edgeOpacity);
    gl.uniform3fv(u.ink!, this.ink); gl.uniform3fv(u.accent!, this.accent);
    gl.uniform3fv(u.bg!, this.bg); gl.uniform1f(u.time!, now / 1000); gl.uniform1f(u.reduced!, Number(this.reducedMotion));
    const draw = (i: number, buffer = i) => { const p = this.passes[buffer]!; gl.uniform1i(u.pass!, i); gl.bindVertexArray(p.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, p.count); };
    // Unbind the sampled edge texture before attaching it as the render target.
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.edgeFramebuffer); gl.clear(gl.COLOR_BUFFER_BIT); draw(0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.edgeTexture); gl.uniform1i(u.edges!, 2);
    gl.uniform1i(u.pass!, 3); gl.bindVertexArray(null); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const effect = (pass: number) => { draw(pass, 1); this.stats.drawCalls++; this.stats.effectDrawCalls++; };
    if (effects.shadows) effect(7);
    if (effects.glow && this.dark && (this.selected >= 0 || this.hovered >= 0 || this.previous >= 0 && now - this.started < this.duration)) effect(5);
    if (trails) effect(6);
    if (effects.breathing && this.hasWorkingAgent) { effect(8); this.stats.breathingDrawCalls++; }
    if (this.passes[3]!.count && (this.hasActivity || now - this.started < this.duration)) { draw(4, 3); this.stats.drawCalls++; this.stats.activityDrawCalls++; }
    draw(1); draw(2);
    this.stats.frames++; this.stats.drawCalls += 4;
    return trails || now - this.depthStarted < this.depthDuration || now - this.started < this.duration || this.navigation.animating(now) || this.animatingStatus && !this.reducedMotion;
  }
  private cachedBounds?: number[];
  private get bounds() { return this.cachedBounds ??= this.positions.reduce((b, p, i) => !this.homeVisible.has(i) ? b : [Math.min(b[0]!, p.x), Math.min(b[1]!, p.y), Math.max(b[2]!, p.x), Math.max(b[3]!, p.y)], [Infinity, Infinity, -Infinity, -Infinity]); }
  /** On-demand inspection only; never iterates nodes in the animation loop. */
  getCamera() { return { ...this.camera }; }
  getPresentation(now = performance.now()) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return { view: { selected: [...this.view.selected], excluded: [...this.view.excluded] }, highlighted: [...this.highlighted].map(i => this.graph.nodes[i]!.id), effects: this.effects, labels: this.labelBoxes.map(b => ({ ...b, id: this.graph.nodes[b.index]!.id })), camera: { ...this.getCamera(), manual: this.navigation.manual }, hovered: this.hovered >= 0 ? this.graph.nodes[this.hovered]!.id : null,
      edges: this.edges.map(([a, b], i) => ({ source: this.graph.nodes[a!]!.id, target: this.graph.nodes[b!]!.id,
        ink: Math.max(0, Math.min(1, this.sample(this.graph.nodes.length + i, now).x)),
        activity: this.activityEdges.includes(i) ? this.sample(this.graph.nodes.length + i, now).alpha : 0,
        moving: this.activityMoving[i] && !this.reducedMotion })),
      nodes: this.graph.nodes.map((n, i) => {
      const state = this.sample(i, now), height = state.x, opacity = state.alpha;
      const p = this.positions[i]!, m = 600 / (600 - height);
      const ink = this.nodeData[i * 12 + 9]! * (1 - this.progress(now)) + this.nodeData[i * 12 + 11]! * this.progress(now);
      const hoverEmphasis = this.nodeData[i * 12]! * (1 - this.progress(now)) + this.nodeData[i * 12 + 7]! * this.progress(now);
      const baseInk = ink * this.nodeData[i * 12 + 8]! * Math.exp(Math.min(0, height - this.homeDepth[i]!) / 95);
      const inkOpacity = i === this.hovered ? 1 : opacity * (baseInk * (1 - hoverEmphasis) + hoverEmphasis);
      return { id: n.id, group: n.group, selected: this.selectedNodes.has(i), excluded: this.excluded.has(i), visible: opacity > 0, opacity, inkOpacity, height,
        phase: n.pilotPhase ?? null, attention: needsAttention(n),
        draft: n.pilotPhase === 'draft' ? (this.draft?.id === n.id ? this.draft.text : n.pilotDraft) ?? '' : '',
        radius: Math.max(n.pilotPhase ? 6 : 1, (n.group === 'memory' ? 8 : nodeRadius(n.degree)) * Math.min(1, Math.sqrt(this.camera.zoom)) * m),
        x: w / 2 + (p.x - this.camera.x) * this.camera.zoom * m,
        y: h / 2 + (p.y - this.camera.y) * this.camera.zoom * m - height * .6 };
    }) };
  }
  pick(x: number, y: number) {
    const now = performance.now(), w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    for (const box of this.labelBoxes) {
      if (!this.excluded.has(box.index) && this.graph.nodes[box.index]!.group === 'memory' && box.opacity > .5 && x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height)
        return this.graph.nodes[box.index]!.id;
    }
    let hit = -1, distance = 18;
    this.positions.forEach((p, i) => { if (this.excluded.has(i)) return; const state = this.sample(i, now), alpha = state.alpha; if (alpha < .1) return;
      const z = state.x, m = 600 / (600 - z);
      const d = Math.hypot(x - (w / 2 + (p.x - this.camera.x) * this.camera.zoom * m), y - (h / 2 + (p.y - this.camera.y) * this.camera.zoom * m - z * .6));
      if (d < distance) { distance = d; hit = i; }
    });
    return hit >= 0 ? this.graph.nodes[hit]!.id : null;
  }
  dispose() { const gl = this.gl; this.passes.forEach(p => { gl.deleteBuffer(p.buffer); gl.deleteVertexArray(p.vao); }); gl.deleteFramebuffer(this.edgeFramebuffer); gl.deleteTexture(this.edgeTexture); gl.deleteTexture(this.stateTexture); gl.deleteTexture(this.labelTexture); gl.deleteProgram(this.program); }
}
