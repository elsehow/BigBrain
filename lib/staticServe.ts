/**
 * staticServe.ts — the viewer's static-file leg, extracted from
 * web/server.ts (#260 seam list), and since #259 the ONE extension →
 * content-type table the viewer answers from. The policy is the part
 * worth pinning: which extension gets which content-type, and which paths
 * may cache hard (hashed /assets/ filenames) versus not at all (index.html
 * — a stale one points at assets that no longer exist).
 */

import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";

const STATIC_TYPES: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  map: "application/json",
  json: "application/json",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  yaml: "text/yaml",
  yml: "text/yaml",
  csv: "text/csv",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
};

/** Content-type by extension — the shared table's one lookup. Types where we
 * know them, opaque bytes otherwise, never a guess. */
export function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return STATIC_TYPES[ext] ?? "application/octet-stream";
}

/** The response headers one static path earns — pure, so the cache policy
 * is testable without a socket or a filesystem. */
export function staticHeaders(path: string): Record<string, string> {
  return {
    "content-type": contentTypeFor(path),
    // never let the browser MIME-sniff a served file into script (#552)
    "x-content-type-options": "nosniff",
    // hashed asset filenames can cache hard; index.html must not
    "cache-control": path.includes("/assets/") ? "max-age=31536000, immutable" : "no-cache",
  };
}

/** Answer `res` with the file at `path`, or return false (unreadable /
 * missing) so the route can 404 or fall back. `download` forces
 * `Content-Disposition: attachment` — set it for VAULT files, whose bytes are
 * attacker-controlled and may be text/html or image/svg+xml: a note link to
 * one would otherwise render script on the origin when navigated (#552).
 * `<img>`/`<video>`/pdf.js-`fetch` ignore the header, so inline media is
 * unaffected. Left off for the trusted app shell/assets. */
export function serveStatic(res: ServerResponse, path: string, opts?: { download?: boolean }): boolean {
  try {
    const buf = readFileSync(path);
    const headers = staticHeaders(path);
    if (opts?.download) headers["content-disposition"] = "attachment";
    res.writeHead(200, headers);
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}
