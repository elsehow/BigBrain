import { describe, expect, test } from "bun:test";
import { errText, modelErrText } from "../lib/errText";

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

describe("modelErrText", () => {
  test("a provider rate limit reads as one sentence, not raw JSON", () => {
    const raw = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."},"request_id":"req_fixture"}';
    const out = modelErrText(new Error(raw));
    expect(out).toContain("rate-limiting");
    expect(out).not.toContain("{");
  });
  test("an overload reads as one sentence", () => {
    expect(modelErrText(new Error('529 {"type":"overloaded_error"}'))).toContain("overloaded");
  });
  test("anything else passes through", () => {
    expect(modelErrText(new Error("No model is configured."))).toBe("No model is configured.");
  });
});
