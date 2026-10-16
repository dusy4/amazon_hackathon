import { describe, expect, it } from "vitest";
import { applyLeadIn } from "../services/media/src/lead-in.ts";

describe("commentary lead-in", () => {
  const index = () =>
    ({
      kind: "video",
      sources: {},
      events: [
        { id: "g", type: "goal", startMs: 141_600, endMs: 151_880 },
        { id: "o", type: "other", startMs: 151_880, endMs: 160_000 },
      ],
      segments: [
        { id: "s-g", eventId: "g", startMs: 141_600, endMs: 151_880 },
        { id: "s-o", eventId: "o", startMs: 151_880, endMs: 160_000 },
      ],
    }) as any;

  it("starts goal moments on the build-up and keeps the captioned start", () => {
    const idx = index();
    expect(applyLeadIn(idx)).toBe(1);
    expect(idx.segments[0].startMs).toBe(131_600);
    expect(idx.segments[0].captionedStartMs).toBe(141_600);
    expect(idx.events[1].startMs).toBe(151_880);
  });

  it("is idempotent", () => {
    const idx = index();
    applyLeadIn(idx);
    expect(applyLeadIn(idx)).toBe(0);
    expect(idx.segments[0].startMs).toBe(131_600);
  });
});
