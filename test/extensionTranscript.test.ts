/**
 * The pure half of the YouTube branch (#79) — clients/browser-extension/
 * transcript.js, imported the way extensionCube.test.ts imports cube.js.
 * The fixtures pin TODAY's YouTube shapes (watch-page script text, the
 * panel rows), so format churn shows up here as one red function instead
 * of as a silently wrong capture.
 */
import { beforeAll, expect, test } from "bun:test";

// The module is an IIFE that hangs everything off globalThis — same
// dual-load idiom as cube.js.
let T: Record<string, CallableFunction>;
beforeAll(async () => {
  await import("../clients/browser-extension/transcript.js");
  T = (globalThis as Record<string, unknown>)["BigBrainTranscript"] as Record<
    string,
    CallableFunction
  >;
});

// ── fixtures: trimmed real shapes ───────────────────────────────────────────

const PLAYER_RESPONSE = {
  playabilityStatus: { status: "OK" },
  videoDetails: {
    videoId: "aircAruvnKk",
    title: "But what is a neural network? | Deep learning chapter 1",
    author: "3Blue1Brown",
    lengthSeconds: "1120",
    shortDescription: "What are the neurons, why are there layers?\nHelp fund future projects.",
    isLive: false,
  },
  microformat: { playerMicroformatRenderer: { publishDate: "2017-10-05" } },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        {
          baseUrl: "https://…",
          languageCode: "en",
          kind: "asr",
          name: { simpleText: "English (auto-generated)" },
        },
        { baseUrl: "https://…", languageCode: "en", name: { simpleText: "English" } },
      ],
    },
  },
};

/** Watch-page script text, as the isolated world sees it: the JSON literal
 * plus surrounding noise, including a `};` INSIDE a string — the trap a
 * slice-to-last-brace parser falls into. */
const SCRIPT_TEXT = [
  'var meta = {"noise":"};"};',
  `var ytInitialPlayerResponse = ${JSON.stringify(PLAYER_RESPONSE)};var b = 1;`,
].join("\n");

// ── parsers ─────────────────────────────────────────────────────────────────

test("parseVarJson digs the literal out of script text — despite a `};` inside a nearby string", () => {
  const pr = T["parseVarJson"]!(SCRIPT_TEXT, "ytInitialPlayerResponse");
  expect(pr?.videoDetails?.videoId).toBe("aircAruvnKk");
  expect(T["parseVarJson"]!("no such thing here", "ytInitialPlayerResponse")).toBeNull();
  expect(
    T["parseVarJson"]!("var ytInitialPlayerResponse = function(){};", "ytInitialPlayerResponse")
  ).toBeNull();
});

test("rowFromLines reads a 2026 panel row: timestamp kept, a11y duration line dropped", () => {
  expect(
    T["rowFromLines"]!(["0:07", "7 seconds", "On that workday, we look after the gardens."])
  ).toEqual({
    timestamp: "0:07",
    text: "On that workday, we look after the gardens.",
  });
  expect(T["rowFromLines"]!(["1:02:03", "1 hour, wait no", "later on"])).toEqual({
    timestamp: "1:02:03",
    text: "1 hour, wait no later on", // only a BARE duration line is a11y noise
  });
  expect(T["rowFromLines"]!(["", "  ", "no timestamp here"])).toEqual({
    timestamp: "",
    text: "no timestamp here",
  });
});

test("segmentsToCues parses panel timestamps, MM:SS and H:MM:SS both", () => {
  expect(
    T["segmentsToCues"]!([
      { timestamp: "0:04", text: "This  is a 3." },
      { timestamp: "1:02:03", text: "later" },
      { timestamp: "not a time", text: "dropped" },
      { timestamp: "0:09", text: "  " },
    ])
  ).toEqual([
    { startMs: 4000, text: "This is a 3." },
    { startMs: 3723000, text: "later" },
  ]);
});

// ── caption + metadata reading ──────────────────────────────────────────────

test("captionInfo prefers the manual track over ASR and reads its language", () => {
  expect(T["captionInfo"]!(PLAYER_RESPONSE)).toEqual({
    available: true,
    kind: "manual",
    language: "en",
  });
});

test("captionInfo names each way a transcript can be missing", () => {
  const asrOnly = structuredClone(PLAYER_RESPONSE);
  asrOnly.captions.playerCaptionsTracklistRenderer.captionTracks = [
    { baseUrl: "https://…", languageCode: "en", kind: "asr", name: { simpleText: "auto" } },
  ];
  expect(T["captionInfo"]!(asrOnly)).toEqual({ available: true, kind: "asr", language: "en" });

  const none = structuredClone(PLAYER_RESPONSE) as Record<string, unknown>;
  delete none["captions"];
  expect(T["captionInfo"]!(none)).toEqual({
    available: false,
    reason: "this video has no caption tracks",
  });

  const live = structuredClone(none) as { videoDetails: { isLive: boolean } };
  live.videoDetails.isLive = true;
  expect((T["captionInfo"]!(live) as { reason: string }).reason).toContain("live stream");

  const gated = {
    playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age" },
  };
  const verdict = T["captionInfo"]!(gated) as { available: boolean; reason: string };
  expect(verdict.available).toBe(false);
  expect(verdict.reason).toContain("Sign in to confirm your age");
});

test("videoMeta + canonicalUrl: the URL is rebuilt from the id — &t= and friends cannot survive", () => {
  const meta = T["videoMeta"]!(PLAYER_RESPONSE);
  expect(meta).toEqual({
    videoId: "aircAruvnKk",
    title: "But what is a neural network? | Deep learning chapter 1",
    channel: "3Blue1Brown",
    published: "2017-10-05",
    durationSeconds: 1120,
    description: "What are the neurons, why are there layers?\nHelp fund future projects.",
  });
  expect(T["canonicalUrl"]!("aircAruvnKk")).toBe("https://www.youtube.com/watch?v=aircAruvnKk");
});

test("formatTimestamp: MM:SS under an hour, H:MM:SS at and above it", () => {
  expect(T["formatTimestamp"]!(4000)).toBe("00:04");
  expect(T["formatTimestamp"]!(3599000)).toBe("59:59");
  expect(T["formatTimestamp"]!(3600000)).toBe("1:00:00");
  expect(T["formatTimestamp"]!(3671200)).toBe("1:01:11");
});

// ── the landed shape ────────────────────────────────────────────────────────

const META = T_META();
function T_META() {
  return {
    videoId: "aircAruvnKk",
    title: "But what is a neural network? | Deep learning chapter 1",
    channel: "3Blue1Brown",
    published: "2017-10-05",
    durationSeconds: 1120,
    description: "What are the neurons, why are there layers?\nSecond line.",
  };
}
const INFO = { available: true, kind: "manual", language: "en" };
const CUES = [
  { startMs: 4880, text: "This is a 3." },
  { startMs: 3671200, text: "an hour and change in." },
];

test("frontmatter with a transcript: kind transcript, caption fields, arrival identity, NO type", () => {
  const fm = T["buildFrontmatter"]!(META, INFO, true) as [string, string][];
  const asMap = Object.fromEntries(fm);
  expect(asMap["kind"]).toBe("transcript");
  expect(asMap["type"]).toBeUndefined(); // the flavor word must win the type slot at landing
  expect(asMap["tags"]).toBeUndefined(); // background's yq cannot carry a list; the flavor derives the tag
  expect(asMap["caption_kind"]).toBe("manual");
  expect(asMap["language"]).toBe("en");
  expect(asMap["stream"]).toBe("youtube");
  expect(asMap["key"]).toBe("aircAruvnKk");
  expect(asMap["url"]).toBe("https://www.youtube.com/watch?v=aircAruvnKk");
  expect(asMap["from_kind"]).toBe("agent"); // intake's exact-regex self-assertion
  expect(asMap["duration"]).toBe("18:40");
  // every value single-line: background.js's yq JSON-quotes scalars
  for (const [, v] of fm) expect(String(v)).not.toContain("\n");
  expect(asMap["description"]).toBe("What are the neurons, why are there layers? Second line.");
});

test("frontmatter without a transcript: an honest web-clip — no caption fields, no transcript claim", () => {
  const fm = Object.fromEntries(
    T["buildFrontmatter"]!(
      META,
      { available: false, reason: "this video has no caption tracks" },
      false
    ) as [string, string][]
  );
  expect(fm["kind"]).toBe("web-clip");
  expect(fm["caption_kind"]).toBeUndefined();
  expect(fm["language"]).toBeUndefined();
  expect(fm["stream"]).toBe("youtube"); // identity still lands — the video is still the object
  expect(fm["key"]).toBe("aircAruvnKk");
});

test("body with cues: metadata first, banner, one timestamped line per cue — no coalescing", () => {
  const body = T["buildBody"]!(META, INFO, CUES) as string;
  const banner = body.indexOf(
    "--- VERBATIM TRANSCRIPT (YouTube captions: manual, en; [MM:SS] = cue start) ---"
  );
  expect(banner).toBeGreaterThan(-1);
  // the informative block sits ABOVE the banner, where intake's excerpt window reads
  for (const must of [
    "# But what is a neural network?",
    "Channel: 3Blue1Brown",
    "Duration: 18:40",
    "Captions: manual (en)",
  ]) {
    expect(body.indexOf(must)).toBeLessThan(banner);
    expect(body.indexOf(must)).toBeGreaterThan(-1);
  }
  expect(body).toContain("> Video description (author's own, verbatim):");
  expect(body).toContain("\n[00:04] This is a 3.");
  expect(body).toContain("\n[1:01:11] an hour and change in.");
});

test("unknown caption kind/language: dropped from frontmatter, named honestly in the body", () => {
  // The panel can be read without player data (the refetch failed) — the
  // capture then knows it HAS a transcript but not which track it is.
  const info = { available: true, kind: "", language: "" };
  const fm = Object.fromEntries(T["buildFrontmatter"]!(META, info, true) as [string, string][]);
  expect(fm["kind"]).toBe("transcript");
  expect(fm["caption_kind"]).toBeUndefined();
  expect(fm["language"]).toBeUndefined();
  const body = T["buildBody"]!(META, info, CUES) as string;
  expect(body).toContain("Captions: unknown kind (unknown language)");
  expect(body).toContain("(YouTube captions: unknown kind, unknown language; [MM:SS] = cue start)");
});

test("body without cues: the plain statement, no banner, nothing implied", () => {
  const body = T["buildBody"]!(
    META,
    { available: false, reason: "this video has no caption tracks" },
    null
  ) as string;
  expect(body).toContain("No transcript: this video has no caption tracks.");
  expect(body).not.toContain("VERBATIM TRANSCRIPT");
  expect(body).not.toContain("Captions:");
  expect(body).toContain("Channel: 3Blue1Brown"); // the metadata still landed
});
