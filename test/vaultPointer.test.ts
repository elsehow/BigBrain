/**
 * The machine's default-vault pointer (#604). On 2026-08-28 an end-to-end
 * run created a scratch vault with a plain `bigbrain init` and the real
 * `~/.config/bigbrain/vault` was overwritten with its path: every launch of
 * the app afterwards found no vault, opened the setup door, and adopted the
 * right vault again without ever writing the pointer back — so it repeated.
 * Two rules come out of that, and both live in `pointerPlan`: the first
 * vault on a machine is the machine's vault, and a second one never takes
 * the pointer unless it is asked to.
 */
import { describe, expect, test } from "bun:test";
import { pointerPlan } from "../lib/engine";

describe("pointerPlan", () => {
  test("an unset pointer is claimed — the first vault is the machine's vault", () => {
    expect(pointerPlan("", "/Users/x/vault", false)).toEqual({ opens: "/Users/x/vault", changed: true });
  });

  test("a second vault leaves the pointer where it is, and says what the machine opens", () => {
    const plan = pointerPlan("/Users/x/vault", "/scratch/vault597", false);
    expect(plan).toEqual({ opens: "/Users/x/vault", changed: false });
    expect(plan.opens).not.toBe("/scratch/vault597"); // the #604 regression
  });

  test("--make-default takes it, and reports what it replaced", () => {
    expect(pointerPlan("/Users/x/vault", "/Users/x/work", true)).toEqual({
      opens: "/Users/x/work",
      changed: true,
      replaced: "/Users/x/vault",
    });
  });

  test("re-running init on the vault the machine already opens writes nothing", () => {
    expect(pointerPlan("/Users/x/vault", "/Users/x/vault", false)).toEqual({ opens: "/Users/x/vault", changed: false });
    expect(pointerPlan("/Users/x/vault", "/Users/x/vault", true)).toEqual({ opens: "/Users/x/vault", changed: false });
  });

  test("a pointer file's trailing newline is not a different vault", () => {
    expect(pointerPlan("/Users/x/vault\n", "/Users/x/vault", false)).toEqual({ opens: "/Users/x/vault", changed: false });
  });

  test("whitespace-only pointer counts as unset", () => {
    expect(pointerPlan("  \n", "/Users/x/vault", false)).toEqual({ opens: "/Users/x/vault", changed: true });
  });
});
