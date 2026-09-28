import { expect, test } from "bun:test";
import { frontmatter } from "../lib/fsx";
import { parseEnvelope } from "../lib/envelope";

const ada = { raw: "Ada <ada@example.com>", name: "Ada", emails: ["ada@example.com"], role: "attendee" };
const bob = { raw: "Bob <bob@example.com>", name: "Bob", emails: ["bob@example.com"], role: "attendee" };

test("structured participants survive frontmatter serialization", () => {
  const text = frontmatter([["participants", [ada]]]);
  expect(parseEnvelope(text).envelope.participants).toEqual([ada]);
});

// The granola runner splices `participants` in with a conditional spread
// alongside plain scalar pairs. Build the pair array the same way here: a bare
// `...(c ? pair : [])` scatters the pair and silently produces `p: a` plus an
// `[object Object]` key, which the single-pair test above cannot see.
test("participants splice into a mixed pair array without scattering", () => {
  const participants = [ada, bob];
  const text = frontmatter([
    ["title", "Weekly sync"],
    ["attendees", participants.map((p) => p.raw).join(", ")],
    ...(participants.length ? ([["participants", participants]] as [string, typeof participants][]) : []),
    ["url", "https://example.com"],
  ]);
  const env = parseEnvelope(text).envelope;
  expect(env.participants).toEqual([ada, bob]);
  expect(env.attendees).toBe("Ada <ada@example.com>, Bob <bob@example.com>");
  expect(text).not.toContain("[object Object]");
  expect(text).not.toContain("\np: a");
});

test("an empty participant list omits the key entirely", () => {
  const participants: typeof ada[] = [];
  const text = frontmatter([
    ["title", "Solo note"],
    ...(participants.length ? ([["participants", participants]] as [string, typeof participants][]) : []),
  ]);
  expect(parseEnvelope(text).envelope.participants).toBeUndefined();
});

test("frontmatter refuses a scattered pair instead of writing junk", () => {
  // Exactly what the wrong bracket count produces.
  const scattered = ["participants", [ada]] as never;
  expect(() => frontmatter(scattered)).toThrow("expected [key, value] pairs");
});
