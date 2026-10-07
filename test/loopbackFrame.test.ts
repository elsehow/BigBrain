import { expect, test } from "bun:test";
import { otherLoopback } from "../web/ui/src/lib/loopbackFrame";

test("an agent's served page is shown under the loopback name the viewer is not on", () => {
  expect(otherLoopback("http://127.0.0.1:5173/a?b=1#c", "127.0.0.1")).toBe("http://localhost:5173/a?b=1#c");
  expect(otherLoopback("http://localhost:5173/", "localhost")).toBe("http://127.0.0.1:5173/");
  // Already on the other name, or not loopback at all: as given.
  expect(otherLoopback("http://localhost:5173/", "127.0.0.1")).toBe("http://localhost:5173/");
  expect(otherLoopback("https://example.com/", "127.0.0.1")).toBe("https://example.com/");
  expect(otherLoopback("not a url", "127.0.0.1")).toBe("not a url");
});
