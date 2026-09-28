// The app owns design tokens; the extension vendors an offline copy.
import { readFileSync, writeFileSync } from "node:fs";
const source = new URL("../web/ui/src/design/tokens.css", import.meta.url);
const target = new URL("../clients/browser-extension/tokens.css", import.meta.url);
const css = readFileSync(source, "utf8").replace(/^@import url\([^\n]+\);\s*/m, "");
writeFileSync(target, css);
