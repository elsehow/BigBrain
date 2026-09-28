import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { mdVault } from "./support/vault";
import { makeApiHandler } from "../lib/api";
import { mintToken } from "../lib/auth";
import { handleMcpTool, McpToolError } from "../lib/mcp";
import { markdownDocument } from "../lib/markdownGraph";
import { notePayload } from "../lib/noteRead";
import { noteBriefingInput } from "../lib/noteBriefing";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

test("HTTP and MCP apply the same note-window limits, errors and boundary values", async () => {
  const root = mdVault({ files: { "references/topic.md": "# Topic\n\nBefore.\n\nA needle.\n\nAfter." } }); roots.push(root);
  const storePath = join(root, ".state/tokens.json");
  const { token } = mintToken(storePath, root, "reader", ["vault:read"]);
  const handler = makeApiHandler({ root, storePath, log: () => {} });
  const context = { root, via: "cli" as const };
  const path = "references/topic.md";
  const http = (args: Record<string, unknown>) => handler(new Request(`http://api.test/v1/note?${new URLSearchParams({ path, ...Object.fromEntries(Object.entries(args).map(([k,v]) => [k, String(v)])) })}`,
    { headers: { Authorization: `Bearer ${token}` } }));
  for (const args of [{ n: 0 }, { n: 1001 }, { n: "Infinity" }, { n: "bad" }, { slack: -1 }, { slack: 21 }, { order: "sideways" }, { after: "yesterday" }]) {
    const response = await http(args), body = await response.json() as { error: string };
    expect(response.status).toBe(400);
    expect(() => handleMcpTool(context, "read_note", { path, ...args })).toThrow(McpToolError);
    expect(() => handleMcpTool(context, "read_note", { path, ...args })).toThrow(body.error);
  }
  for (const args of [{}, { n: 1, slack: 0, q: "needle" }, { n: 1000, slack: 20, order: "desc" }, { toc: true }]) {
    const response = await http(args);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(handleMcpTool(context, "read_note", { path, ...args }));
  }
});

test("graph, note and briefing share frontmatter, heading and filename title precedence", () => {
  const cases = [
    { raw: '# Actual title\n\ntitle: This is body text', title: 'Actual title' },
    { raw: '---\ntitle: "Named: topic"\n---\n# Heading\n\nContent', title: 'Named: topic' },
    { raw: '---\ntitle: ""\n---\n# Heading\n\nContent', title: 'Heading' },
    { raw: 'Content without a heading.', title: 'hyphenated-name' },
  ];
  for (const { raw, title } of cases) {
    const path = "memory/hyphenated-name.md", root = mdVault({ files: { [path]: raw } }); roots.push(root);
    expect(markdownDocument(path, raw).title).toBe(title);
    expect(notePayload(root, path)).toMatchObject({ status: 200, note: { title } });
    expect(noteBriefingInput(root, path).items[0]!.title).toBe(title);
  }
});
