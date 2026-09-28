import { describe, expect, test } from "bun:test";
import { clamped, currentRow, navDelta, stepped, createListJump } from "../web/ui/src/lib/listNav";

const key = (k: string): KeyboardEvent => ({ key: k }) as KeyboardEvent;

describe("navDelta", () => {
  test("arrows always move; j/k move only where letters count", () => {
    expect(navDelta(key("ArrowDown"))).toBe(1);
    expect(navDelta(key("ArrowUp"))).toBe(-1);
    expect(navDelta(key("j"))).toBe(1);
    expect(navDelta(key("k"))).toBe(-1);
    // a text field has the keyboard — j and k are letters someone is typing
    expect(navDelta(key("j"), false)).toBeNull();
    expect(navDelta(key("k"), false)).toBeNull();
    expect(navDelta(key("ArrowDown"), false)).toBe(1);
  });
  test("anything else moves nothing — Enter and Escape stay the caller's", () => {
    for (const k of ["Enter", "Escape", "J", "K", "a", " "]) expect(navDelta(key(k))).toBeNull();
  });
});

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

describe("clamped", () => {
  test("a cursor inside the list is left alone", () => {
    expect(clamped(1, 3, -1)).toBe(1);
  });
  test("a list that shrank under the cursor pulls it to the last row", () => {
    expect(clamped(7, 3, -1)).toBe(2);
  });
  test("an emptied list parks at the caller's rest, which differs by surface", () => {
    expect(clamped(7, 0, -1)).toBe(-1); // the feed: nothing highlighted
    expect(clamped(7, 0, 0)).toBe(0); // the palette: a row is always current
  });
});

describe("currentRow", () => {
  test("the row under the pointer, while the mouse owns selection and is on one", () => {
    expect(currentRow("mouse", 4, 1)).toBe(4);
  });
  test("the keyboard cursor's row while the keyboard owns selection — even with a row under a parked pointer", () => {
    expect(currentRow("kbd", 4, 1)).toBe(1);
  });
  test("a keyboard selection holds while the pointer roams off the rows", () => {
    expect(currentRow("mouse", -1, 1)).toBe(1);
  });
  test("nothing selected anywhere is nothing", () => {
    expect(currentRow("mouse", -1, -1)).toBe(-1);
    expect(currentRow("kbd", 3, -1)).toBe(-1);
  });
});

test("list endpoints support Home/End and gg/G without taking text input", () => {
  const jump = createListJump();
  expect(jump(key("Home"))).toBe("first");
  expect(jump(key("End"))).toBe("last");
  expect(jump(key("G"))).toBe("last");
  expect(jump(key("g"))).toBe("pending");
  expect(jump(key("g"))).toBe("first");
  expect(jump(key("g"))).toBe("pending");
  expect(jump(key("j"))).toBe(null);
  expect(jump(key("g"))).toBe("pending");
  expect(jump(key("g"), false)).toBe(null);
  expect(jump(key("G"), false)).toBe(null);
});
