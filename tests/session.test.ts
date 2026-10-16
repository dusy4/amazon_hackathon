import { describe, expect, it } from "vitest";
import { PlaybackSession } from "../services/context/src/session.ts";

describe("spoiler boundary", () => {
  it("advances only on consecutive forward playback reports", () => {
    const s = new PlaybackSession("s", "u");
    s.setContent("match");
    // Title switch: the player reports one stale position from the previous title (clamped to the end).
    s.observePosition(246000, true);
    expect(s.watchedUpToMs).toBe(0);
    // Real playback from 1:26.
    s.observePosition(86000, true);
    s.observePosition(86500, true);
    s.observePosition(87000, true);
    expect(s.watchedUpToMs).toBe(87000);
    // A seek forward is not watching.
    s.observePosition(200000, true);
    expect(s.watchedUpToMs).toBe(87000);
  });

  it("is kept per title", () => {
    const s = new PlaybackSession("s", "u");
    s.setContent("a");
    s.observePosition(1000, true);
    s.observePosition(1500, true);
    s.setContent("b");
    expect(s.watchedUpToMs).toBe(0);
    s.setContent("a");
    expect(s.watchedUpToMs).toBe(1500);
  });
});
