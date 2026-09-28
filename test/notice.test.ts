import { describe, expect, test } from "bun:test";
import { guardNotice, type Notice } from "../web/ui/src/lib/notice";

describe("guardNotice", () => {
  test("clears the notice before running, and leaves it alone on success — the caller sets it", async () => {
    const seen: (Notice | null)[] = [];
    let ran = false;
    await guardNotice(
      (n) => seen.push(n),
      async () => {
        ran = true;
      }
    );
    expect(ran).toBe(true);
    expect(seen).toEqual([null]); // only the clear — success text is the caller's job
  });

  test("a thrown Error becomes a failure notice with its message", async () => {
    const seen: (Notice | null)[] = [];
    await guardNotice(
      (n) => seen.push(n),
      async () => {
        throw new Error("saveConfig failed");
      }
    );
    expect(seen).toEqual([null, { ok: false, text: "saveConfig failed" }]);
  });

  test("a thrown non-Error is coerced the same way errText() does everywhere else", async () => {
    const seen: (Notice | null)[] = [];
    await guardNotice(
      (n) => seen.push(n),
      async () => {
        throw "plain string failure";
      }
    );
    expect(seen).toEqual([null, { ok: false, text: "plain string failure" }]);
  });
});
