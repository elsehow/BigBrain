/** A no-op WebGL2 + DOM stand-in, so the production `GraphRenderer` can be
 * driven from `bun test`.
 *
 * SCOPE: camera, ordering and visibility maths only. Nothing is rasterized,
 * no shader is compiled and no pixel is read, so this can never stand in for
 * the browser suite — `test/support/unifiedGraph*.browser.cjs` own appearance,
 * shader correctness and GPU resource claims. It exists because a camera that
 * jumps on every background update is a logic bug, and logic bugs deserve a
 * test that runs without a browser binary. */
type Stub = Record<string, unknown>;

export function installHeadlessGraphDom(): void {
  const g = globalThis as Stub;
  if (g["__headlessGraphDom"]) return;
  g["__headlessGraphDom"] = true;
  let next = 1;
  const constants = new Map<string, number>();
  const gl = (): unknown => new Proxy({}, {
    get(_target, property: string) {
      // GL enums are upper case; everything else is a call the renderer makes.
      if (/^[A-Z0-9_]+$/.test(property)) {
        if (!constants.has(property)) constants.set(property, next++);
        return constants.get(property);
      }
      switch (property) {
        case "getShaderParameter": case "getProgramParameter": return () => true;
        case "isContextLost": return () => false;
        case "getError": return () => 0;
        case "getExtension": return () => null;
        case "getUniformLocation": return () => ({});
        case "getShaderInfoLog": case "getProgramInfoLog": return () => "";
        default: return () => ({});
      }
    },
  });
  const context2d = {
    font: "", fillStyle: "", textBaseline: "",
    clearRect() { /* no-op */ }, fillRect() { /* no-op */ }, fillText() { /* no-op */ },
    measureText: (text: string) => ({ width: text.length * 11 }),
    getImageData: () => ({ data: new Uint8ClampedArray([34, 34, 34, 255]) }),
  };
  const canvas = () => ({ width: 1, height: 1, style: {}, getContext: (kind: string) => kind === "2d" ? context2d : gl() });
  g["document"] = { documentElement: {}, createElement: () => canvas() };
  g["getComputedStyle"] = () => ({ colorScheme: "light", getPropertyValue: (name: string) => name === "--font-app" ? "system-ui" : "#222222" });
  g["devicePixelRatio"] = 2;
}

/** A canvas with a fixed size the renderer can frame a picture into. */
export function headlessCanvas(width = 1440, height = 1000): HTMLCanvasElement {
  installHeadlessGraphDom();
  const context = (globalThis as Stub)["document"] as { createElement: () => { getContext: (kind: string) => unknown } };
  const gl = context.createElement().getContext("webgl2");
  return { clientWidth: width, clientHeight: height, width: width * 2, height: height * 2,
    getContext: () => gl, style: {} } as unknown as HTMLCanvasElement;
}
