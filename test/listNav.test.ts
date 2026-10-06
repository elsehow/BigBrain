import { describe, expect, test } from "bun:test";
import { stepped } from "../web/ui/src/lib/listNav";

describe("stepped", () => {
  test("walks, and stops at both ends", () => {
    expect(stepped(0, 1, 3)).toBe(1);
    expect(stepped(2, 1, 3)).toBe(2); // no wrap past the last row
    expect(stepped(1, -1, 3)).toBe(0);
  });
  test("k stops at the first row rather than deselecting", () => {
    // -1 would be "nothing selected", which is a place you arrive at by
    // Escape or an empty list — never by walking up off the top
    expect(stepped(0, -1, 3)).toBe(0);
  });
  test("j from nothing-selected lands on the first row", () => {
    expect(stepped(-1, 1, 3)).toBe(0);
  });
  test("an empty list holds still", () => {
    expect(stepped(-1, 1, 0)).toBe(-1);
    expect(stepped(0, -1, 0)).toBe(0);
  });
});
