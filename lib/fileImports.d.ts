/** `import path from "./x.woff2" with { type: "file" }` — Bun hands back a path
 * it can read from source or from inside a compiled binary (lib/sharedPages.ts). */
declare module "*.woff2" {
  const path: string;
  export default path;
}
