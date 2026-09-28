/** Disposable real intake API for extension release checks; no supervisor/model jobs. */
import { gitVault, NATIVE_YAML } from "./vault";
import { declareUserIdentity } from "../../lib/userIdentity";
import { mintPairCode } from "../../lib/pair";
import { listTokens, revokeToken, tokenStorePath } from "../../lib/auth";
import { makeApiHandler } from "../../lib/api";
import { readSourceInsertionLog } from "../../lib/insertionLog";
import { rmSync } from "node:fs";
const root = gitVault({ prefix: "bb-extension-store-", files: { "vault.yaml": NATIVE_YAML } });
declareUserIdentity(root, { name: "Alex Example", email: "alex@example.test" });
const storePath = tokenStorePath(root);
const api = makeApiHandler({ root, storePath, pairOwner: () => "alex@example.test" });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/fixture/pair") return Response.json(mintPairCode(root));
  if (path === "/fixture/revoke") {
    for (const token of listTokens(storePath)) revokeToken(storePath, token.id);
    return Response.json({ ok: true });
  }
  if (path === "/fixture/evidence") return Response.json(readSourceInsertionLog(root, { strict: true }).map(s => ({ title: s.title, body: s.body })));
  if (path === "/article") return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A small guide to urban gardens</title><meta name="author" content="Alex Example"><style>body{font:20px/1.7 Georgia,serif;background:#f8f6ef;color:#263e32;max-width:760px;margin:72px auto;padding:0 32px}h1{font-size:52px;line-height:1.12}small{font:14px system-ui;color:#59705f}.plot{height:160px;background:linear-gradient(120deg,#c6d8b1,#e2dfb7);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:70px}</style></head><body><main><small>FIELD NOTES · EXAMPLE ARTICLE</small><h1>A small guide to urban gardens</h1><p>Good gardens begin with observation. Notice where the sunlight falls, which corners hold water, and where people naturally pause.</p><div class="plot">🌱</div><h2>Start with one small bed</h2><p>Choose plants that suit the light you have. Keep a simple record of what thrives, share your harvest, and let each season teach you what to try next.</p><p>This fictional article is used to demonstrate saving a page with BigBrain.</p></main></body></html>`, { headers: { "content-type": "text/html" } });
  return api(req);
}});
console.log(JSON.stringify({ base: `http://127.0.0.1:${server.port}`, root }));
function stop() { server.stop(true); rmSync(root, { recursive: true, force: true }); process.exit(0); }
process.on("SIGTERM", stop); process.on("SIGINT", stop);
