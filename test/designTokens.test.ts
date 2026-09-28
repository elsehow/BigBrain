import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
test("extension vendors the complete offline app token sheet", () => {
  const app = readFileSync(new URL("../web/ui/src/design/tokens.css", import.meta.url), "utf8");
  const extension = readFileSync(new URL("../clients/browser-extension/tokens.css", import.meta.url), "utf8");
  expect(extension).toBe(app.replace(/^@import url\([^\n]+\);\s*/m, ""));
  expect(extension).not.toContain("display=swap");
});
