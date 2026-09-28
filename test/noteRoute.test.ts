import { describe, expect, test } from "bun:test";
import { isNotePath } from "../web/ui/src/lib/noteRoute";

describe("note routes", () => {
  test("accepts legacy Markdown and exact native source-event paths", () => {
    expect(isNotePath("references/one.md")).toBe(true);
    expect(isNotePath("projection/entities/ent_0123456789abcdef0123.md")).toBe(true);
    expect(isNotePath("log/insertions/2026-08/ins_0123456789abcdef01234567.json")).toBe(true);
    expect(isNotePath("log/insertions/undated/ins_0123456789abcdef01234567.json")).toBe(true);
  });

  test("does not turn arbitrary log JSON into a browsable path", () => {
    expect(isNotePath("log/assertions/2026-08/a.json")).toBe(false);
    expect(isNotePath("log/insertions/2026-08/not-an-insertion.json")).toBe(false);
    expect(isNotePath("log/insertions/../../.env")).toBe(false);
  });
});
