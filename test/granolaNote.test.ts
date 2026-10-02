/**
 * lib/granolaNote.ts — the vendor's speaker labels survive into the body.
 * The poll used to keep only `speaker.source` and flatten every turn to
 * `microphone:`/`speaker:`; Granola's transcript API carries `name` on the
 * turns it attributed and `attribution: "me"` on the owner's, and the body
 * must say so.
 */
import { describe, expect, test } from "bun:test";
import { parseEnvelope } from "../lib/envelope";
import {
  granolaBodyHasNames,
  granolaItem,
  granolaNamedTurns,
  granolaTranscriptLines,
  granolaTurnLabel,
  type GranolaNote,
  type GranolaTurn,
} from "../lib/granolaNote";

const me: GranolaTurn = { text: "Hey Briar.", speaker: { source: "microphone", attribution: "me" } };
const briar: GranolaTurn = {
  text: "Hello.",
  speaker: { source: "speaker", attribution: "them", name: "Briar Williams" },
};
const unplaced: GranolaTurn = { text: "Nick.", speaker: { source: "speaker", attribution: "them" } };
const bare: GranolaTurn = { text: "…" };

describe("granolaTurnLabel — the vendor's word, whole", () => {
  test("a named turn is labeled by its name", () => {
    expect(granolaTurnLabel(briar, "Nick")).toBe("Briar Williams");
  });
  test("the owner's microphone is the owner's name", () => {
    expect(granolaTurnLabel(me, "Nick")).toBe("Nick");
  });
  test("an owner without a name is `me`, never `speaker`", () => {
    expect(granolaTurnLabel(me)).toBe("me");
    expect(granolaTurnLabel(me, "  ")).toBe("me");
  });
  test("a voice the vendor could not place stays `speaker`", () => {
    expect(granolaTurnLabel(unplaced, "Nick")).toBe("speaker");
    expect(granolaTurnLabel(bare, "Nick")).toBe("speaker");
  });
  test("a blank name is no name", () => {
    expect(granolaTurnLabel({ text: "x", speaker: { name: "  " } }, "Nick")).toBe("speaker");
  });
});

test("granolaTranscriptLines keeps the vendor's order, one line per turn", () => {
  expect(granolaTranscriptLines([me, unplaced, briar], "Nick")).toEqual([
    "Nick: Hey Briar.",
    "speaker: Nick.",
    "Briar Williams: Hello.",
  ]);
});

test("granolaNamedTurns counts attributed participants, never the owner", () => {
  expect(granolaNamedTurns([me, briar, unplaced, briar])).toBe(2);
  expect(granolaNamedTurns([me, unplaced])).toBe(0);
  expect(granolaNamedTurns(undefined)).toBe(0);
});

describe("granolaBodyHasNames — what a landed body already carries", () => {
  const flat = [
    "# Sync",
    "",
    "Attendees: Nick <n@x.org>, Briar Williams <b@x.org>",
    "",
    "> Granola auto-summary (vendor hint — context-free, non-authoritative):",
    "> Briar Williams: agreed to ship",
    "",
    "--- VERBATIM TRANSCRIPT (raw ASR; diarization labels microphone:/speaker:) ---",
    "",
    "microphone: Hey Briar.",
    "speaker: Hello.",
    "",
  ].join("\n");
  test("the pre-relabel body has none — attendee and summary lines are not turns", () => {
    expect(granolaBodyHasNames(flat)).toBe(false);
  });
  test("one named turn under the marker is enough", () => {
    expect(granolaBodyHasNames(flat + "Briar Williams: Yes.\n")).toBe(true);
  });
  test("the owner's name counts as a name", () => {
    expect(granolaBodyHasNames(flat.replace("microphone: Hey", "Nick: Hey"))).toBe(true);
  });
  test("a body without a transcript has no names to speak of", () => {
    expect(granolaBodyHasNames("# Sync\n\nBriar Williams: hi\n")).toBe(false);
  });
});

describe("granolaItem — the item both the poll and the relabel pass land", () => {
  const note: GranolaNote = {
    title: "Automated Catastrophic Risk Forecasting",
    created_at: "2026-08-31T19:30:00.000Z",
    updated_at: "2026-08-31T21:00:00.000Z",
    web_url: "https://notes.granola.ai/d/abc",
    owner: { name: "Nick", email: "nick@example.com" },
    calendar_event: { scheduled_start_time: "2026-08-31T19:30:00.000Z", calendar_event_id: "ev1" },
    attendees: [
      { name: "Nick", email: "nick@example.com" },
      { name: "Briar Williams", email: "briar@example.com" },
    ],
    summary_markdown: "# Dashboard\n- agreed",
    transcript: [me, unplaced, briar],
  };
  const now = new Date("2026-09-03T18:00:00.000Z");

  test("the body carries the vendor's labels and the header says what they mean", () => {
    const item = granolaItem("not_1", note, now);
    const { envelope, body } = parseEnvelope(item.content);
    expect(body).toContain("\nNick: Hey Briar.\nspeaker: Nick.\nBriar Williams: Hello.\n");
    expect(body).not.toContain("microphone:");
    expect(body).toContain('"Nick" for the account owner\'s microphone');
    expect(granolaBodyHasNames(body)).toBe(true);
    // Vendor summaries never become source evidence.
    expect(body).not.toContain("# Dashboard");
    expect(envelope.id).toBe("granola-not_1");
    expect(envelope.key).toBe("not_1");
    expect(envelope.seq).toBe("2026-08-31T21:00:00.000Z");
    expect(envelope.supersedes).toBeUndefined();
    expect(item.date).toBe("2026-08-31");
    expect(item.name).toBe("2026-08-31-automated-catastrophic-risk-forecasting-not_1.md");
  });

  test("the relabel pass names the insertion it revises", () => {
    const item = granolaItem("not_1", note, now, { supersedes: "ins_0123456789abcdef01234567" });
    expect(parseEnvelope(item.content).envelope.supersedes).toBe("ins_0123456789abcdef01234567");
  });

  test("an owner the vendor did not name still reads as `me`, not a stranger", () => {
    const item = granolaItem("not_2", { ...note, owner: undefined }, now);
    expect(parseEnvelope(item.content).body).toContain("\nme: Hey Briar.\n");
  });
});
