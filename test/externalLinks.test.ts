import { describe, expect, test } from "bun:test";
import { isExternalHref } from "../web/ui/src/lib/links";

// The viewer is one document; every route is a hash on it. A link to anything
// else must open OUTSIDE the desktop shell's webview, which has no way back
// (Nick, 2026-09-02: "it opens the link inside the bigbrain app and then i
// can't leave").
const HERE = "http://127.0.0.1:4747/#/vault/inbox/clip.md";

describe("isExternalHref", () => {
  test("another site leaves the document", () => {
    expect(isExternalHref("https://example.com/story", HERE)).toBe(true);
    expect(isExternalHref("http://example.com", HERE)).toBe(true);
  });

  test("a route on this document does not", () => {
    expect(isExternalHref("#/graph", HERE)).toBe(false);
    expect(isExternalHref("#/vault/inbox/other.md", HERE)).toBe(false);
    expect(isExternalHref("http://127.0.0.1:4747/#/search/x", HERE)).toBe(false);
    expect(isExternalHref("", HERE)).toBe(false);
  });

  test("another page on the viewer's own host is a document of its own", () => {
    // /api/file is an attachment — a PDF, an image — and the browser reads it
    expect(isExternalHref("/api/file?path=inbox%2Fdeck.pdf", HERE)).toBe(true);
    // a clipped page's relative links resolve onto this host, and would 404 in the webview
    expect(isExternalHref("/about", HERE)).toBe(true);
  });

  test("mail and phone links go out; schemes the webview owns stay", () => {
    expect(isExternalHref("mailto:someone@example.com", HERE)).toBe(true);
    expect(isExternalHref("tel:+16045551234", HERE)).toBe(true);
    expect(isExternalHref("blob:http://127.0.0.1:4747/abc", HERE)).toBe(false);
  });

  test("a page with no origin to compare against is left alone", () => {
    expect(isExternalHref("https://example.com", "not a url")).toBe(false);
  });
});
