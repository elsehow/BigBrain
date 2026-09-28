import { describe, expect, test } from "bun:test";
import { errText } from "../lib/errText";

describe("errText", () => {
  test("an Error gives its message", () => {
    expect(errText(new Error("boom"))).toBe("boom");
  });
  test("a subclassed Error still gives its message", () => {
    class MyError extends Error {}
    expect(errText(new MyError("custom"))).toBe("custom");
  });
  test("a thrown string is coerced as-is", () => {
    expect(errText("just a string")).toBe("just a string");
  });
  test("a thrown plain object is coerced via String()", () => {
    expect(errText({ code: 42 })).toBe("[object Object]");
  });
  test("null and undefined coerce without throwing", () => {
    expect(errText(null)).toBe("null");
    expect(errText(undefined)).toBe("undefined");
  });
});
