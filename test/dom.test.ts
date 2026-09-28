import { describe, expect, test } from "bun:test";
import { editable } from "../web/ui/src/lib/dom";

const el = (props: Partial<{ tagName: string; isContentEditable: boolean }>): EventTarget =>
  ({ tagName: "DIV", isContentEditable: false, ...props }) as unknown as EventTarget;

describe("editable", () => {
  test("null target is not editable", () => {
    expect(editable(null)).toBe(false);
  });
  test("an INPUT is editable", () => {
    expect(editable(el({ tagName: "INPUT" }))).toBe(true);
  });
  test("a TEXTAREA is editable", () => {
    expect(editable(el({ tagName: "TEXTAREA" }))).toBe(true);
  });
  test("a contenteditable DIV is editable", () => {
    expect(editable(el({ tagName: "DIV", isContentEditable: true }))).toBe(true);
  });
  test("a plain button or row is not editable", () => {
    expect(editable(el({ tagName: "BUTTON" }))).toBe(false);
    expect(editable(el({ tagName: "DIV" }))).toBe(false);
  });
});
