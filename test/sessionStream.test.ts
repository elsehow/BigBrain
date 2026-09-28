/**
 * The stream rule behind #128: a live stream answered with an HTTP status
 * comes back. The DOM wiring (EventSource, timers) has no harness here, so
 * the DECISION is a pure function and this is its test. (Its sibling — an
 * expired hosted session logs you out — left with the hosted product, #566.)
 */

import { describe, expect, test } from "bun:test";
import { RETRY_MAX_MS, RETRY_MIN_MS, nextRetryMs, retryDelayMs } from "../web/ui/src/lib/live";

describe("the live stream backs off, and stops backing off", () => {
  test("doubles", () => {
    expect(nextRetryMs(RETRY_MIN_MS)).toBe(2_000);
    expect(nextRetryMs(2_000)).toBe(4_000);
  });

  test("caps — an hour-long outage must not push the next try past the horizon", () => {
    let ms = RETRY_MIN_MS;
    for (let i = 0; i < 100; i++) ms = nextRetryMs(ms);
    expect(ms).toBe(RETRY_MAX_MS);
  });

  test("jitter spreads the herd — every open tab wakes on the same restart", () => {
    expect(retryDelayMs(1_000, () => 0)).toBe(1_000);
    expect(retryDelayMs(1_000, () => 1)).toBe(1_250);
  });

  test("the cap is short enough that a restart heals itself", () => {
    // A viewer restart — an update, a `bigbrain install`, the desktop app
    // relaunching — drops every open stream. The tab has to recover on its
    // own, without a reload, in a time a person would not describe as
    // broken.
    expect(RETRY_MAX_MS).toBeLessThanOrEqual(30_000);
  });
});
