import { expect, test } from "bun:test";
import { mentionText, parseMentions, serializeMentions } from "../lib/pilotMentions";

test("mentions retain exact references and safe labels through durable plain text", () => {
  const parts = [{ text: "Compare " }, { mention: { id: "memory/a[b]|100%.md", title: "A [test] | 100%\nnext", tag: "MEMORY" as const } }, { text: "\nwith " }, { mention: { id: "pilot-" + "a".repeat(32), title: "Other session", tag: "PILOT" as const } }];
  const text = serializeMentions(parts);
  expect(parseMentions(text)).toEqual(parts);
  expect(mentionText(parseMentions(text))).toBe("Compare A [test] | 100%\nnext\nwith Other session");
  expect(serializeMentions(parseMentions(text))).toBe(text);
});
test("plain text and existing wiki references stay readable", () => {
  expect(parseMentions("email@example.com\n@incomplete")).toEqual([{ text: "email@example.com\n@incomplete" }]);
  expect(parseMentions("[[memory/career|Career]]")).toEqual([{ mention: { id: "memory/career", title: "Career", tag: "MEMORY" } }]);
  expect(parseMentions("[[source|100% sure]]")[0]).toEqual({ mention: { id: "source", title: "100% sure", tag: "SOURCE" } });
});
